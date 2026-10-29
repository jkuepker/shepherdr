// herdr-core (`hc`) as the runtime Shepherdr's agents run in: the same calls as herdr.ts's `herdr`, so every coordinator
// and task agent is a terminal on the core, which the Herdr desktop app shows as a space and a tab. Picked with
// SHEPHERDR_BACKEND=hc (backend.ts); docs/hc.md says what is reduced. Read from hc 0.1.13 (`hc schema`, the real core):
// - One long `hc connect` speaks the core's API, JSON-RPC a line each way, many calls on it at once; a second one holds
//   events.subscribe. terminal.run takes {argv, cwd, env (set on top of the core's), labels, keep, no_parent, no_notify,
//   on} and returns the terminal ({address: "t7", ...}); terminal.list {labels, all} the records with their labels;
//   terminal.get one, with its foreground process ({pid, argv, cwd}); errors are {code, message, data: {kind, hint}}.
// - A terminal labelled herdr.space=<id> and herdr.tab=<id> shows up in the Herdr app as that space and tab. Each of
//   Shepherdr's also carries shepherdr=<this install>, and an agent's shepherdr.name and shepherdr.kind: herdr's named
//   agent. hc's own names are unique across everyone's terminals on the core, so Shepherdr never relies on them.
// - herdr opens a pane with a shell and starts an agent in it; an hc terminal runs one program. So a new workspace or
//   tab hands back a pane that is only a promise (its space, tab, folder and environment), and start() runs the agent as
//   that terminal's program. The pane id stays the promise's; it points at the terminal from then on.
// - The core gives every terminal its own environment (whoever started the core first), not Shepherdr's: seen, Claude
//   Code's session markers from a Claude session there (CLAUDE_CODE_CHILD_SESSION turns transcripts off, which are
//   Shepherdr's chats) and no Claude login ("Login expired"). The agent starts through sh, which drops the markers, with
//   the login and the provider keys Shepherdr has handed over in terminal.run's env (on stdin, never in a process list).
// - Status is the program's own OSC 7501 report (Claude Code sends one). A CLI that reports none is 'unknown'.
// - `hc send` pastes text and always presses Enter; `hc keys` presses named keys (herdr's names are hc's) and only the
//   unshifted characters of a US keyboard. Text with others waits for the Enter that follows it and goes in as one send.
// - Reads are plain text (no ANSI) of the screen plus N lines of history; the core has no output events, so a watched
//   terminal's screen is read again every so often instead.
// - Worktrees are git's own (herdr's worktree API has no counterpart): the same folders herdr picks,
//   ~/.herdr/worktrees/<repo>/<branch>, so a task started on herdr carries on here.
// - On another machine (box.ts) the calls still go to this machine's core, with `on` set to the machine: its name in
//   `hc machine ls` (install.ts), its terminals' addresses `machine/t7`.
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { Subprocess } from 'bun'
import { HerdrError } from './backend.ts'
import { BOX, boxHome } from './box.ts'
import { LinkBackoff } from './recovery.ts'
import { HOME, readJson, writeJson } from '../store.ts'
import { isAgentProcess } from './agent-process.ts'
import * as G from './engine/git.ts'
import type { AgentInfo, AgentStatus, HerdrEvent, PaneInfo, ProcessInfo, WorkspaceInfo, WorktreeFrom, WorktreeOf, WorktreeSpace } from './herdr.ts'

/** the Claude login a terminal keeps (as Muxy and herdr pass it on) */
const KEEP_AUTH = ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_SKIP_BEDROCK_AUTH', 'CLAUDE_CODE_SKIP_VERTEX_AUTH', 'CLAUDE_CODE_SKIP_FOUNDRY_AUTH']
/** credentials the CLIs read whose names do not end in _API_KEY (those all go along): Anthropic and Codex tokens,
 *  Bedrock, Vertex, Azure, Copilot, Hugging Face, Cloudflare */
const PROVIDER_ENV = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN', 'CODEX_ACCESS_TOKEN', 'OPENAI_CODEX_OAUTH_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_PROFILE', 'AWS_REGION', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GCLOUD_PROJECT', 'GOOGLE_VERTEX_PROJECT', 'GOOGLE_VERTEX_LOCATION', 'AZURE_RESOURCE_NAME', 'COPILOT_GITHUB_TOKEN', 'HF_TOKEN', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']

/** run by sh before the agent: Claude Code's and herdr's session markers out of what the core gave the terminal */
export const SCRUB = [
  'for v in $(env | sed -n "s/^\\([A-Z][A-Z0-9_]*\\)=.*/\\1/p"); do',
  `  case $v in ${KEEP_AUTH.join('|')}) ;; CLAUDECODE|CLAUDE_CODE_*|CLAUDE_PID|CLAUDE_AGENT_SDK_*|CLAUDE_PLUGIN_*|HERDR_*) unset "$v";; esac`,
  'done',
  'exec "$0" "$@"',
].join('\n')

/** the credentials in Shepherdr's environment an agent needs: the Claude login, and every provider key a CLI reads.
 *  Only to this machine's terminals: another machine's core has its own */
export function authEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([k, v]) => v && (KEEP_AUTH.includes(k) || PROVIDER_ENV.includes(k) || k.endsWith('_API_KEY')))) as Record<string, string>
}

/** which install of Shepherdr a terminal is: two on one core never take each other's */
export const INSTANCE = createHash('sha256').update(process.env.SHEPHERDR_MAIN_HOME ?? HOME).digest('hex').slice(0, 10)
/** the machine this worker runs on, in hc's words: its terminals are `machine/t7` */
const ON = BOX?.label
const LABELS = { shepherdr: INSTANCE }

function binary() {
  return process.env.SHEPHERDR_HC || Bun.which('hc') || join(homedir(), '.local', 'bin', 'hc')
}

/** what hc's error kinds mean in herdr's codes (agents.ts holdFrom) */
const CODES: Record<string, string> = { blocked: 'agent_blocked', not_found: 'agent_not_found', finished: 'agent_not_running' }

/* ---------- the API connection ---------- */

type Waiting = { resolve: (x: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

/** one `hc connect`: calls by id, notifications to `note`. Opened again by the next call once it closed */
class Link {
  private p: Subprocess<'pipe', 'pipe', 'ignore'> | null = null
  private waiting = new Map<number, Waiting>()
  private n = 0
  constructor(private note?: (m: { method: string; params: Record<string, unknown> }) => void, private closed?: () => void) {}

  private open() {
    const p = Bun.spawn([binary(), 'connect'], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', env: process.env })
    this.p = p
    ;(async () => {
      let buf = ''
      try {
        const r = p.stdout.getReader()
        for (;;) {
          const { done, value } = await r.read()
          if (done) break
          buf += Buffer.from(value).toString('utf8')
          let i: number
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim()
            buf = buf.slice(i + 1)
            if (line) this.frame(line)
          }
        }
      } catch {
        /* closed under us */
      }
      this.gone(p)
    })()
    p.exited.then(() => this.gone(p))
    return p
  }

  private frame(line: string) {
    let f: { id?: number; result?: unknown; error?: { message?: string; data?: { kind?: string; hint?: string } }; method?: string; params?: Record<string, unknown> }
    try { f = JSON.parse(line) } catch { return }
    if (f.id === undefined || f.id === null) {
      if (f.method) this.note?.({ method: f.method, params: f.params ?? {} })
      return
    }
    const w = this.waiting.get(f.id)
    if (!w) return
    this.waiting.delete(f.id)
    clearTimeout(w.timer)
    if (f.error) {
      const kind = f.error.data?.kind ?? 'error'
      w.reject(new HerdrError(CODES[kind] ?? kind, f.error.message ?? kind))
    } else w.resolve(f.result)
  }

  private gone(p: Subprocess) {
    if (this.p !== p) return
    this.p = null
    for (const w of this.waiting.values()) (clearTimeout(w.timer), w.reject(new HerdrError('unreachable', "hc isn't answering")))
    this.waiting.clear()
    this.closed?.()
  }

  call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    let p: Subprocess<'pipe', 'pipe', 'ignore'>
    try { p = this.p ?? this.open() } catch (e) { return Promise.reject(new HerdrError('unreachable', `hc could not start: ${(e as Error).message}`)) }
    const id = ++this.n
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new HerdrError('timeout', `hc ${method} timed out`))
      }, timeoutMs)
      this.waiting.set(id, { resolve: resolve as (x: unknown) => void, reject, timer })
      try {
        p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
        p.stdin.flush()
      } catch {
        this.gone(p)
      }
    })
  }

  close() {
    const p = this.p
    this.p = null
    try { p?.kill() } catch { /* gone already */ }
  }
}

const link = new Link()
export const call = <T>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number) => link.call<T>(method, params, timeoutMs)

/* ---------- terminals ---------- */

interface Terminal {
  address: string
  argv?: string[]
  cwd?: string | null
  cols?: number
  rows?: number
  labels?: Record<string, string>
  pid?: number | null
  state: 'live' | 'finished'
  status?: { state?: string } | string | null
  title?: string
  foreground?: { pid?: number; argv?: string[]; cwd?: string; name?: string } | null
}

const mine = (t: Terminal) => t.labels?.shepherdr === INSTANCE && (ON ? t.address.startsWith(`${ON}/`) : !t.address.includes('/'))
const stateOf = (t: Terminal) => (typeof t.status === 'string' ? t.status : t.status?.state) ?? null

async function terminals(all = false): Promise<Terminal[]> {
  const r = await call<{ terminals: Terminal[] }>('terminal.list', { labels: LABELS, all })
  return r.terminals.filter(mine)
}

const get = (address: string) => call<Terminal>('terminal.get', { terminal: address })

/** a shell left in a terminal: its agent exited and hc's keep put one there */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'nu'])
const isShell = (argv?: string[]) => SHELLS.has(basename(argv?.[0] ?? '').replace(/^-/, ''))

/* ---------- spaces, tabs and panes Shepherdr keeps ---------- */

interface Space {
  label: string
  cwd: string
  tabs: Record<string, string>
  worktree?: WorktreeOf
}

const FILE = 'hc-spaces.json'
const spaces = () => readJson<Record<string, Space>>(FILE, {})
const saveSpaces = (all: Record<string, Space>) => writeJson(FILE, all)

/** a pane whose terminal starts with its agent */
interface Promised {
  workspace_id: string
  tab_id: string
  cwd: string
  env: Record<string, string>
}

const promised = new Map<string, Promised>()
/** a promised pane's terminal, once it runs */
const ran = new Map<string, string>()
const addressOf = (pane: string) => ran.get(pane) ?? pane
const newId = (p: string) => `${p}${randomUUID().replace(/-/g, '').slice(0, 10)}`

function promise(workspace_id: string, tab_id: string, cwd: string, env: Record<string, string>) {
  const pane = newId('p')
  promised.set(pane, { workspace_id, tab_id, cwd, env })
  return pane
}

function infoOf(id: string, s: Space, live: Terminal[]): WorkspaceInfo {
  const here = live.filter((t) => t.labels?.['herdr.space'] === id)
  const waiting = [...promised.values()].filter((p) => p.workspace_id === id)
  const tabs = new Set([...here.map((t) => t.labels?.['herdr.tab']), ...waiting.map((p) => p.tab_id)])
  return { workspace_id: id, label: s.label, focused: false, tab_count: Math.max(1, tabs.size), pane_count: here.length + waiting.length, ...(s.worktree ? { worktree: s.worktree } : {}) }
}

function addSpace(label: string, cwd: string, env: Record<string, string>, tab: string, worktree?: WorktreeOf) {
  const id = newId('s')
  const tab_id = newId('t')
  const all = spaces()
  all[id] = { label, cwd, tabs: { [tab_id]: tab }, ...(worktree ? { worktree } : {}) }
  saveSpaces(all)
  const pane = promise(id, tab_id, cwd, env)
  return { workspace: infoOf(id, all[id], []), root_pane: { pane_id: pane } }
}

/* ---------- the Herdr app's names for them ---------- */

/** SHEPHERDR_HERDR_APP="" for none (tests) */
const APP = process.env.SHEPHERDR_HERDR_APP ?? Bun.which('herdr-app')
let namedAt = 0

/** the Herdr app calls a space after its folder and a tab by its number: Shepherdr's names, where the app runs here */
async function nameInApp(force = false) {
  if (!APP || (!force && Date.now() - namedAt < 30_000)) return
  namedAt = Date.now()
  const ran = (args: string[]) => Bun.spawn([APP, ...args], { stdout: 'pipe', stderr: 'ignore' })
  try {
    const p = ran(['ls'])
    const t = setTimeout(() => p.kill(), 5000)
    const out = await new Response(p.stdout).text()
    clearTimeout(t)
    const shown = (JSON.parse(out) as { spaces?: { id: string; name: string; tabs?: { id: string; name: string }[] }[] }).spaces ?? []
    const all = spaces()
    for (const w of shown) {
      const id = ON ? w.id.replace(`${ON}/`, '') : w.id
      const s = all[id]
      if (!s) continue
      if (w.name !== s.label) ran(['do', 'space.rename', JSON.stringify({ id: w.id, name: s.label })])
      for (const tab of w.tabs ?? []) {
        const name = s.tabs[ON ? tab.id.replace(`${ON}/`, '') : tab.id]
        if (name && tab.name !== name) ran(['do', 'tab.rename', JSON.stringify({ id: tab.id, name })])
      }
    }
  } catch {
    /* the app isn't open: it gets its names at a later look */
  }
}

/* ---------- typing ---------- */

/** the characters `hc keys` types as themselves: an unshifted US keyboard */
const PLAIN = new Set([...'abcdefghijklmnopqrstuvwxyz0123456789', ...".,/-;'=[]\\`"])
const keyOf = (c: string) => (PLAIN.has(c) ? c : c >= 'A' && c <= 'Z' ? `shift+${c.toLowerCase()}` : c === ' ' ? 'space' : c === '\n' || c === '\r' ? 'enter' : c === '\t' ? 'tab' : null)
/** herdr's key names, which are hc's but for a few spellings */
const NAMES: Record<string, string> = { escape: 'esc', return: 'enter', bspace: 'backspace', btab: 'shift+tab', 'shift-tab': 'shift+tab', pgup: 'pageup', pgdn: 'pagedown' }
const keyName = (k: string) => {
  const l = k.toLowerCase()
  if (NAMES[l]) return NAMES[l]
  const c = l.match(/^(c|m)-(.)$/)
  return c ? `${c[1] === 'c' ? 'ctrl' : 'alt'}+${c[2]}` : k.length === 1 ? k : l
}
/** text hc can't type on its own, by terminal: it goes in with the Enter that follows */
const pendingText = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> }>()

/* ---------- reading ---------- */

/** a terminal no one watches is 120 rows, mostly the blank middle of a full-screen CLI: one blank line for a run of
 *  them, and only the last `lines` */
export function trimScreen(text: string, lines: number) {
  const t = text.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '')
  return t.split('\n').slice(-Math.max(1, lines)).join('\n')
}

/* ---------- agents ---------- */

/** when each terminal was first seen running its agent: a CLI that reports no status counts as ready a moment later */
const seenRunning = new Map<string, number>()
const READY_MS = 3000
/** Claude Code reports its status once it takes input; still nothing after this long (a dialog), it counts as ready */
const CLAUDE_READY_MS = 10_000
const STATUS: Record<string, AgentStatus> = { idle: 'idle', working: 'working', done: 'done', blocked: 'blocked', error: 'blocked' }

function agentOf(t: Terminal, full: Terminal): AgentInfo {
  const kind = t.labels?.['shepherdr.kind'] ?? ''
  const runs = t.state === 'live' && isAgentProcess(kind, full.foreground?.argv)
  const status = runs ? stateOf(full) : null
  if (!runs) seenRunning.delete(t.address)
  else if (!seenRunning.has(t.address)) seenRunning.set(t.address, Date.now())
  const since = seenRunning.get(t.address)
  const ready = runs && (!!status || (since !== undefined && Date.now() - since >= (kind === 'claude' ? CLAUDE_READY_MS : READY_MS)))
  return {
    agent: runs ? kind : null,
    agent_status: (status && STATUS[status]) || 'unknown',
    agent_session: null,
    cwd: t.cwd ?? null,
    foreground_cwd: full.foreground?.cwd ?? null,
    name: t.labels?.['shepherdr.name'] ?? null,
    pane_id: t.address,
    tab_id: t.labels?.['herdr.tab'] ?? '',
    workspace_id: t.labels?.['herdr.space'] ?? '',
    title: t.title ?? null,
    terminal_title_stripped: t.title ?? null,
    interactive_ready: ready,
  }
}

async function agents(): Promise<AgentInfo[]> {
  const live = (await terminals()).filter((t) => t.labels?.['shepherdr.name'])
  const full = await Promise.all(live.map((t) => get(t.address).catch(() => t)))
  void nameInApp()
  return live.map((t, i) => agentOf(t, full[i]))
}

async function agentTerminal(name: string): Promise<Terminal> {
  const t = (await terminals()).find((x) => x.labels?.['shepherdr.name'] === name)
  if (!t) throw new HerdrError('agent_not_found', `agent ${name} is not running`)
  return t
}

async function agentInfo(name: string): Promise<AgentInfo> {
  const t = await agentTerminal(name)
  return agentOf(t, await get(t.address).catch(() => t))
}

/** ends a terminal and removes it, once its program is gone */
async function close(address: string) {
  await call('terminal.kill', { terminal: address }).catch(() => undefined)
  for (let i = 0; i < 20; i++) {
    try {
      await call('terminal.rm', { terminal: address })
      break
    } catch (e) {
      const code = (e as HerdrError).code
      if (code === 'agent_not_found') break
      await Bun.sleep(250)
    }
  }
  seenRunning.delete(address)
  pendingText.delete(address)
}

async function start(name: string, kind: string, pane_id: string, args: string[] = []): Promise<{ agent: AgentInfo }> {
  const p = promised.get(pane_id)
  if (!p) throw new HerdrError('pane_not_found', `pane ${pane_id} is not one Shepherdr opened, or its agent runs already`)
  const all = await call<{ terminals: Terminal[] }>('terminal.list', { all: true })
  const ours = all.terminals.filter((t) => mine(t) && t.labels?.['shepherdr.name'] === name)
  if (ours.some((t) => t.state === 'live')) throw new HerdrError('agent_exists', `agent ${name} runs already`)
  // an earlier run's finished terminal keeps its screen until removed: it goes now
  for (const t of ours) await close(t.address)
  const taken = all.terminals.some((t) => t.state === 'live' && (t as Terminal & { name?: string }).name === name)
  const env = { ...(ON ? {} : authEnv()), ...p.env }
  const params = {
    argv: ['/bin/sh', '-c', SCRUB, kind, ...args],
    cwd: p.cwd,
    env,
    labels: { ...LABELS, 'herdr.space': p.workspace_id, 'herdr.tab': p.tab_id, 'shepherdr.name': name, 'shepherdr.kind': kind },
    keep: true,
    no_parent: true,
    no_notify: true,
    ...(taken || !/^[a-z0-9_-]{1,32}$/.test(name) ? {} : { name }),
    ...(ON ? { on: ON } : {}),
  }
  const t = await call<Terminal>('terminal.run', params, 30_000)
  promised.delete(pane_id)
  ran.set(pane_id, t.address)
  setTimeout(() => void nameInApp(true), 1500)
  // ready once its CLI takes input (agents.ts waits for this)
  for (const end = Date.now() + 60_000; Date.now() < end; await Bun.sleep(500)) {
    const a = agentOf(t, await get(t.address).catch(() => t))
    if (a.interactive_ready) return { agent: a }
    const now = await get(t.address).catch(() => null)
    if (!now || now.state !== 'live') throw new HerdrError('agent_exited', `${kind} exited as it started`)
  }
  throw new HerdrError('agent_not_ready', `${kind} did not become ready`)
}

async function prompt(target: string, text: string) {
  const t = await agentTerminal(target)
  const a = agentOf(t, await get(t.address))
  if (!a.agent) throw new HerdrError('agent_not_running', `${target}'s CLI is not running`)
  if (a.agent_status === 'blocked') throw new HerdrError('agent_blocked', `${target} is asking something`)
  await call('terminal.send', { terminal: t.address, text })
}

async function paneKeys(pane_id: string, keys: string[]) {
  const address = addressOf(pane_id)
  if (promised.has(address)) return
  let names = keys.map(keyName)
  const waiting = pendingText.get(address)
  if (waiting) {
    pendingText.delete(address)
    clearTimeout(waiting.timer)
    if (names[0] === 'enter') {
      await call('terminal.send', { terminal: address, text: waiting.text, force: true })
      names = names.slice(1)
    } else console.error(`shepherdr: hc can't type ${JSON.stringify(waiting.text)} without the Enter after it; left out`)
  }
  if (names.length) await call('terminal.keys', { terminal: address, keys: names })
}

async function paneText(pane_id: string, text: string) {
  const address = addressOf(pane_id)
  if (promised.has(address) || !text) return
  const keys = [...text].map(keyOf)
  const waiting = pendingText.get(address)
  if (!waiting && keys.every(Boolean)) return void (await call('terminal.keys', { terminal: address, keys }))
  // waits for its Enter (source.ts types text, then Enter): one `hc send` types both
  if (waiting) clearTimeout(waiting.timer)
  const all = (waiting?.text ?? '') + text
  pendingText.set(address, {
    text: all,
    timer: setTimeout(() => {
      pendingText.delete(address)
      console.error(`shepherdr: hc can't type ${JSON.stringify(all)} without an Enter after it; left out`)
    }, 5000),
  })
}

async function read(pane_id: string, _format: 'ansi' | 'text' = 'ansi', lines = 200) {
  const address = addressOf(pane_id)
  if (promised.has(address)) return ''
  const r = await call<{ text?: string }>('terminal.read', { terminal: address, lines })
  return trimScreen(r.text ?? '', lines)
}

async function visible(pane_id: string) {
  const address = addressOf(pane_id)
  if (promised.has(address)) return ''
  const r = await call<{ text?: string }>('terminal.read', { terminal: address, lines: 0 })
  return trimScreen(r.text ?? '', 1000)
}

async function processInfo(pane_id: string): Promise<ProcessInfo> {
  const address = addressOf(pane_id)
  if (promised.has(address)) return {}
  const t = await get(address)
  const fg = t.state === 'live' ? t.foreground : null
  if (!fg) return {}
  return { shell_pid: isShell(fg.argv) ? fg.pid : undefined, foreground_process_group_id: fg.pid, foreground_processes: [{ argv: fg.argv, name: fg.name, pid: fg.pid }] }
}

async function paneIdle(pane_id: string) {
  const address = addressOf(pane_id)
  if (promised.has(address)) return true
  const t = await get(address)
  return t.state !== 'live' || !t.foreground || isShell(t.foreground.argv)
}

async function panes(workspace_id: string): Promise<PaneInfo[]> {
  const live = (await terminals()).filter((t) => t.labels?.['herdr.space'] === workspace_id)
  const waiting = [...promised.entries()].filter(([, p]) => p.workspace_id === workspace_id)
  return [...live.map((t) => ({ pane_id: t.address, workspace_id, cwd: t.cwd ?? null })), ...waiting.map(([pane_id, p]) => ({ pane_id, workspace_id, cwd: p.cwd }))]
}

async function closePane(pane_id: string) {
  const address = addressOf(pane_id)
  ran.delete(pane_id)
  if (promised.delete(address)) return
  await close(address)
}

async function closeWorkspace(workspace_id: string) {
  for (const [pane, p] of promised) if (p.workspace_id === workspace_id) promised.delete(pane)
  for (const t of await terminals(true)) if (t.labels?.['herdr.space'] === workspace_id) await close(t.address)
  const all = spaces()
  delete all[workspace_id]
  saveSpaces(all)
}

async function workspaces(): Promise<WorkspaceInfo[]> {
  const live = await terminals()
  return Object.entries(spaces()).map(([id, s]) => infoOf(id, s, live))
}

/* ---------- worktrees, with git ---------- */

/** where herdr puts a branch's worktree: ~/.herdr/worktrees/<repo>/<branch> (SHEPHERDR_WORKTREES: another folder for
 *  ~/.herdr/worktrees) */
export const worktreePath = (repo: string, branch: string, home = boxHome()) => join(process.env.SHEPHERDR_WORKTREES || join(home, '.herdr', 'worktrees'), basename(repo), branch.replace(/[/\\]+/g, '-'))

async function repoOf(from: WorktreeFrom) {
  const dir = 'cwd' in from ? from.cwd : spaces()[from.workspace_id]?.cwd
  if (!dir) throw new HerdrError('workspace_not_found', `no space ${(from as { workspace_id: string }).workspace_id}`)
  // a linked worktree's repo is the one its git folder belongs to
  const common = await G.git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  if (!common.ok) throw new HerdrError('not_a_repo', `${dir} is not a git checkout`)
  return dirname(common.out.trim())
}

/** a space for a checkout that is open already, by its folder */
const openOn = (path: string) => Object.entries(spaces()).find(([, s]) => s.worktree?.is_linked_worktree && s.worktree.checkout_path === path)

async function worktreeSpace(id: string, s: Space, path: string): Promise<WorktreeSpace> {
  const live = await terminals()
  const pane = live.find((t) => t.labels?.['herdr.space'] === id)?.address ?? [...promised.entries()].find(([, p]) => p.workspace_id === id)?.[0] ?? promise(id, Object.keys(s.tabs)[0] ?? newId('t'), path, {})
  return { workspace: infoOf(id, s, live), root_pane: { pane_id: pane }, worktree: { path }, already_open: true }
}

async function worktreeCreate(from: WorktreeFrom, branch: string, base: string, label: string, path?: string): Promise<WorktreeSpace> {
  const repo = await repoOf(from)
  const at = path ?? worktreePath(repo, branch)
  const has = await G.branchExists(repo, branch)
  const r = has ? await G.git(repo, 'worktree', 'add', at, branch) : await G.git(repo, 'worktree', 'add', '-b', branch, at, base)
  if (!r.ok) throw new HerdrError('worktree_failed', `git worktree add ${at}: ${(r.err || r.out).trim().split('\n')[0]}`)
  const made = addSpace(label, at, {}, label, { checkout_path: at, is_linked_worktree: true, repo_root: repo })
  return { ...made, worktree: { path: at } }
}

async function worktreeOpen(from: WorktreeFrom, path: string, label: string): Promise<WorktreeSpace> {
  const open = openOn(path)
  if (open) return worktreeSpace(open[0], open[1], path)
  const repo = await repoOf('cwd' in from ? from : { cwd: path })
  return { ...addSpace(label, path, {}, label, { checkout_path: path, is_linked_worktree: true, repo_root: repo }), worktree: { path } }
}

/** git worktree remove of a linked worktree's space, which closes it; forced only when asked, never the branch */
async function worktreeRemove(workspace_id: string, force = false) {
  const s = spaces()[workspace_id]
  if (!s?.worktree?.is_linked_worktree) throw new HerdrError('not_a_worktree', `space ${workspace_id} is not a linked worktree`)
  const r = await G.removeWorktree(s.worktree.repo_root, s.worktree.checkout_path, force)
  if (!r.ok) throw new HerdrError('worktree_failed', (r.err || r.out).trim().split('\n')[0] || 'git could not remove it')
  await closeWorkspace(workspace_id)
}

/* ---------- herdr's calls ---------- */

export const hc = {
  ping: () => call<{ terminals: unknown[] }>('terminal.list', { labels: LABELS }, 3000).then(() => ({ version: 'herdr-core' }) as { version?: string; protocol?: number }),
  agents,
  agent: agentInfo,
  workspaces,
  createWorkspace: async (label: string, cwd: string, env: Record<string, string> = {}) => addSpace(label, cwd, env, label),
  renameWorkspace: async (workspace_id: string, label: string) => {
    const all = spaces()
    if (!all[workspace_id]) throw new HerdrError('workspace_not_found', `no space ${workspace_id}`)
    all[workspace_id].label = label
    saveSpaces(all)
    void nameInApp(true)
    return {}
  },
  createTab: async (workspace_id: string, label: string, cwd: string, env: Record<string, string> = {}) => {
    const all = spaces()
    if (!all[workspace_id]) throw new HerdrError('workspace_not_found', `no space ${workspace_id}`)
    const tab_id = newId('t')
    all[workspace_id].tabs[tab_id] = label
    saveSpaces(all)
    return { tab: { tab_id }, root_pane: { pane_id: promise(workspace_id, tab_id, cwd, env) } }
  },
  start,
  prompt,
  sendKeys: async (target: string, keys: string[]) => paneKeys((await agentTerminal(target)).address, keys),
  paneKeys,
  paneText,
  read,
  visible,
  size: async (pane_id: string) => {
    const address = addressOf(pane_id)
    if (promised.has(address)) return null
    const t = await get(address)
    return t.cols && t.rows ? { cols: t.cols, rows: t.rows } : null
  },
  panes,
  processInfo,
  paneIdle,
  worktreeCreate,
  worktreeOpen,
  worktreeRemove,
  closePane,
  closeWorkspace,
  /** the Herdr app has no notifications to show for another program; Shepherdr's own alerts still go out */
  notify: async (_title: string, _body: string) => undefined,
}

/* ---------- events ---------- */

/** hc's event stream as herdr's (agents.ts reads every event as "look again", output_changed as "its screen
 *  changed"), opened again when it closes. The core tells no output, so the watched terminals' screens are read again
 *  every so often instead */
export class HcSubscription {
  private link: Link | null = null
  private stopped = false
  private retry?: ReturnType<typeof setTimeout>
  private recovery = new LinkBackoff()
  private watched: string[] = []
  private screens = new Map<string, string>()
  private poll?: ReturnType<typeof setInterval>
  private polling = false
  constructor(
    private onEvent: (e: HerdrEvent) => void,
    private onOpen: () => void = () => undefined,
  ) {}

  set(subs: Record<string, unknown>[]) {
    this.watched = subs.filter((s) => s.type === 'pane.output_changed' && s.pane_id).map((s) => String(s.pane_id))
    for (const p of this.screens.keys()) if (!this.watched.includes(p)) this.screens.delete(p)
    if (this.watched.length && !this.poll) this.poll = setInterval(() => void this.look(), 700)
    if (!this.watched.length && this.poll) (clearInterval(this.poll), (this.poll = undefined))
    if (!this.link && !this.retry && !this.stopped && subs.length) this.open()
  }

  private open() {
    this.retry = undefined
    if (this.stopped) return
    const l = new Link(
      (m) => {
        if (m.method !== 'event') return
        const type = String(m.params.type ?? '')
        if (type === 'heartbeat') return
        if (type === 'missed') return this.onOpen()
        this.onEvent({ event: `pane.${type}`, data: { type: `pane.${type}`, pane_id: String(m.params.terminal ?? '') } })
      },
      () => {
        if (this.link !== l || this.stopped) return
        this.link = null
        this.retry = setTimeout(() => this.open(), this.recovery.fail())
      },
    )
    this.link = l
    l.call('events.subscribe', { labels: LABELS }, 15_000).then(
      () => {
        this.recovery.success()
        this.onOpen()
      },
      () => l.close(),
    )
  }

  private async look() {
    if (this.polling) return
    this.polling = true
    try {
      for (const pane of this.watched) {
        const text = await call<{ text?: string }>('terminal.read', { terminal: addressOf(pane), lines: 0 }).then((r) => r.text ?? '', () => null)
        if (text === null) continue
        const was = this.screens.get(pane)
        this.screens.set(pane, text)
        if (was !== undefined && was !== text) this.onEvent({ event: 'pane.output_changed', data: { type: 'pane.output_changed', pane_id: pane } })
      }
    } finally {
      this.polling = false
    }
  }

  stop() {
    this.stopped = true
    if (this.retry) clearTimeout(this.retry)
    if (this.poll) clearInterval(this.poll)
    this.link?.close()
    this.link = null
  }
}
