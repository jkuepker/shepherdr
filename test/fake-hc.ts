// herdr-core standing in for itself: `fake-hc connect` speaks hc 0.1.13's API (JSON-RPC, a line each way) on terminals
// kept in a JSON file (FAKE_HC_STATE), so several connections and the test see the same core. Nothing runs: a
// terminal's foreground is the program its sh launcher execs (hc.ts SCRUB), what is sent lands on its screen and in
// `typed`, and a test sets a terminal's status (its program's OSC 7501 report) by writing the file. fakeHc() writes the
// small `hc` executable that runs this file, for SHEPHERDR_HC.
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface FakeTerminal {
  address: string
  argv: string[]
  cwd: string
  env: Record<string, string>
  labels: Record<string, string>
  name?: string
  state: 'live' | 'finished'
  status: { state: string; app?: string } | null
  pid: number
  foreground: { pid: number; argv: string[]; cwd: string } | null
  cols: number
  rows: number
  title: string
  screen: string
  typed: { text?: string; keys?: string[] }[]
}

export interface FakeState {
  n: number
  terminals: FakeTerminal[]
}

export const load = (f: string): FakeState => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { n: 0, terminals: [] })
export const save = (f: string, s: FakeState) => writeFileSync(f, JSON.stringify(s))

/** a folder with an `hc` that is this fake, and its state file */
export function fakeHc() {
  const dir = mkdtempSync(join(tmpdir(), 'shep-hc-'))
  const state = join(dir, 'state.json')
  const bin = join(dir, 'hc')
  writeFileSync(bin, `#!/bin/sh\nFAKE_HC_STATE=${JSON.stringify(state)} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(import.meta.path)} "$@"\n`)
  chmodSync(bin, 0o755)
  save(state, { n: 0, terminals: [] })
  return {
    bin,
    state,
    read: () => load(state),
    /** change the core's terminals, as a program or the person would */
    edit: (f: (s: FakeState) => void) => {
      const s = load(state)
      f(s)
      save(state, s)
    },
  }
}

type Params = Record<string, unknown>
class Fault extends Error {
  constructor(readonly kind: string, message: string) {
    super(message)
  }
}

function handle(file: string, method: string, p: Params): unknown {
  const s = load(file)
  const find = (t: unknown) => {
    const x = s.terminals.find((y) => y.address === t || (y.state === 'live' && y.name === t))
    if (!x) throw new Fault('not_found', `${t} not found`)
    return x
  }
  const has = (t: FakeTerminal, labels: Params = {}) => Object.entries(labels).every(([k, v]) => t.labels[k] === v)
  const done = <T>(x: T) => (save(file, s), x)
  switch (method) {
    case 'terminal.run': {
      const argv = (p.argv as string[]) ?? []
      if (p.name && s.terminals.some((t) => t.state === 'live' && t.name === p.name)) throw new Fault('name_taken', `${p.name} is taken`)
      const address = `${p.on ? `${p.on}/` : ''}t${(++s.n).toString(36)}`
      const pid = 1000 + s.n
      // sh -c SCRUB <program> <args>: the program takes the terminal's pid
      const program = argv[0] === '/bin/sh' && argv[1] === '-c' ? argv.slice(3) : argv
      const t: FakeTerminal = { address, argv, cwd: String(p.cwd ?? ''), env: (p.env as Record<string, string>) ?? {}, labels: (p.labels as Record<string, string>) ?? {}, ...(p.name ? { name: String(p.name) } : {}), state: 'live', status: null, pid, foreground: { pid, argv: program, cwd: String(p.cwd ?? '') }, cols: 200, rows: 120, title: '', screen: '', typed: [] }
      s.terminals.push(t)
      return done(t)
    }
    case 'terminal.list':
      return { terminals: s.terminals.filter((t) => (p.all || t.state === 'live') && has(t, p.labels as Params)), machines: [], hidden_finished: 0 }
    case 'terminal.get':
      return find(p.terminal)
    case 'terminal.read': {
      const t = find(p.terminal)
      return { text: t.screen, complete: true, how: 'screen' }
    }
    case 'terminal.send': {
      const t = find(p.terminal)
      if (t.state !== 'live') throw new Fault('finished', `${t.address} has finished`)
      if (t.status?.state === 'blocked' && !p.force) throw new Fault('blocked', `${t.address} is blocked`)
      t.typed.push({ text: String(p.text) })
      t.screen += `\n❯ ${p.text}`
      return done({ started: null, status: t.status, turn: 0 })
    }
    case 'terminal.keys': {
      const t = find(p.terminal)
      if (t.state !== 'live') throw new Fault('finished', `${t.address} has finished`)
      for (const k of p.keys as string[]) if (!/^([a-z0-9.,/;'=[\]\\`-]|space|enter|esc|tab|shift\+tab|backspace|delete|up|down|left|right|home|end|pageup|pagedown|shift\+[a-z]|(ctrl|alt)\+.)$/.test(k)) throw new Fault('invalid_params', `unknown key "${k}"`)
      t.typed.push({ keys: p.keys as string[] })
      return done({})
    }
    case 'terminal.kill': {
      const t = find(p.terminal)
      t.state = 'finished'
      t.foreground = null
      return done({ reason: 'killed' })
    }
    case 'terminal.rm': {
      const t = find(p.terminal)
      if (t.state === 'live') throw new Fault('live', `${t.address} is live`)
      s.terminals = s.terminals.filter((x) => x !== t)
      return done({})
    }
    case 'terminal.label': {
      const t = find(p.terminal)
      for (const [k, v] of Object.entries(p.labels as Record<string, string>)) {
        if (v) t.labels[k] = v
        else delete t.labels[k]
      }
      return done(t)
    }
    case 'events.subscribe':
      return { channel: null, seq: 0, terminals: s.terminals.filter((t) => has(t, p.labels as Params)) }
    default:
      throw new Fault('method_not_found', `no method ${method}`)
  }
}

if (import.meta.main) {
  const file = process.env.FAKE_HC_STATE!
  if (process.argv[2] !== 'connect') {
    console.error('fake hc: only `hc connect`')
    process.exit(2)
  }
  let buf = ''
  const reader = Bun.stdin.stream().getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += Buffer.from(value).toString('utf8')
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      const m = JSON.parse(line) as { id: number; method: string; params?: Params }
      try {
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: handle(file, m.method, m.params ?? {}) })}\n`)
      } catch (e) {
        const kind = e instanceof Fault ? e.kind : 'error'
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: (e as Error).message, data: { kind } } })}\n`)
      }
    }
  }
}
