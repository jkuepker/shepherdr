// herdr-core as the runtime (hc.ts), on a fake core (fake-hc.ts): herdr's calls become labelled terminals the Herdr
// app shows, an agent gets the login and loses Claude Code's session markers, and what hc can't type waits for its Enter.
import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync, execSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeHc } from './fake-hc.ts'

const core = fakeHc()
process.env.SHEPHERDR_HC = core.bin
process.env.SHEPHERDR_HERDR_APP = ''
process.env.CLAUDE_CODE_OAUTH_TOKEN = 'login-token'
process.env.SOME_API_KEY = 'some-key'
const { hc, INSTANCE, SCRUB, authEnv, trimScreen, worktreePath } = await import('../server/live/hc.ts')

const dirs: string[] = []
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, shell: '/bin/sh', encoding: 'utf8' }).trim()
const only = (name: string) => core.read().terminals.find((t) => t.labels['shepherdr.name'] === name)!

describe('agents on herdr-core', () => {
  test("a workspace's pane is a promise until its agent starts: then a terminal labelled for the Herdr app", async () => {
    const made = await hc.createWorkspace('Coordinator', '/tmp', { SHEPHERDR_CHAT: 'p:x' })
    expect(core.read().terminals).toHaveLength(0)
    expect(await hc.panes(made.workspace.workspace_id)).toHaveLength(1)
    const started = hc.start('coord', 'claude', made.root_pane.pane_id, ['--model', 'opus'])
    // Claude Code takes input once it reports a status
    for (let i = 0; i < 20 && !core.read().terminals.length; i++) await Bun.sleep(50)
    core.edit((s) => (s.terminals[0].status = { state: 'idle', app: 'claude-code' }))
    const { agent } = await started
    const t = only('coord')
    expect(t.labels).toMatchObject({ 'herdr.space': made.workspace.workspace_id, shepherdr: INSTANCE, 'shepherdr.kind': 'claude' })
    expect(t.labels['herdr.tab']).toBeTruthy()
    expect(t.argv.slice(0, 4)).toEqual(['/bin/sh', '-c', SCRUB, 'claude'])
    expect(t.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'login-token', SOME_API_KEY: 'some-key', SHEPHERDR_CHAT: 'p:x' })
    expect(agent).toMatchObject({ name: 'coord', agent: 'claude', agent_status: 'idle', interactive_ready: true, pane_id: t.address })
    // the promise's pane id is the terminal's from now on
    expect((await hc.processInfo(made.root_pane.pane_id)).foreground_processes?.[0].argv).toEqual(['claude', '--model', 'opus'])
    expect(await hc.paneIdle(made.root_pane.pane_id)).toBe(false)
  })

  test('herdr agents are the named terminals of this install, with their status', async () => {
    core.edit((s) => s.terminals.push({ ...s.terminals[0], address: 't99', labels: { shepherdr: 'someone-else', 'shepherdr.name': 'other' } }))
    core.edit((s) => (s.terminals[0].status = { state: 'working' }))
    const list = await hc.agents()
    expect(list.map((a) => a.name)).toEqual(['coord'])
    expect(list[0].agent_status).toBe('working')
    core.edit((s) => (s.terminals[0].status = { state: 'error' }))
    expect((await hc.agent('coord')).agent_status).toBe('blocked')
  })

  test('a prompt is one send; a blocked agent refuses it as herdr does', async () => {
    core.edit((s) => (s.terminals[0].status = { state: 'idle' }))
    await hc.prompt('coord', 'hello there')
    expect(only('coord').typed.at(-1)).toEqual({ text: 'hello there' })
    core.edit((s) => (s.terminals[0].status = { state: 'blocked' }))
    await expect(hc.prompt('coord', 'x')).rejects.toMatchObject({ code: 'agent_blocked' })
    await expect(hc.prompt('nobody', 'x')).rejects.toMatchObject({ code: 'agent_not_found' })
    core.edit((s) => (s.terminals[0].status = { state: 'idle' }))
  })

  test("text hc can type goes in as keys; other text waits for its Enter and goes in with it", async () => {
    const pane = only('coord').address
    await hc.paneText(pane, 'Hi 1.')
    expect(only('coord').typed.at(-1)).toEqual({ keys: ['shift+h', 'i', 'space', '1', '.'] })
    await hc.paneText(pane, 'a_b')
    await hc.paneText(pane, '!')
    expect(only('coord').typed.at(-1)).toEqual({ keys: ['shift+h', 'i', 'space', '1', '.'] })
    await hc.paneKeys(pane, ['Enter', 'Escape'])
    expect(only('coord').typed.slice(-2)).toEqual([{ text: 'a_b!' }, { keys: ['esc'] }])
  })

  test('a read is the screen without its blank middle, the last lines asked for', () => {
    expect(trimScreen('one  \n\n\n\n\ntwo\nthree\n\n\n', 2)).toBe('two\nthree')
    expect(trimScreen('a\n\n\n\nb', 10)).toBe('a\n\nb')
  })

  test('a tab is another promise in the space; closing the space ends its terminals', async () => {
    const ws = (await hc.workspaces())[0]
    expect(ws).toMatchObject({ label: 'Coordinator', tab_count: 1 })
    const tab = await hc.createTab(ws.workspace_id, 'Agent', '/tmp')
    expect((await hc.workspaces())[0].tab_count).toBe(2)
    await hc.closePane(tab.root_pane.pane_id)
    await hc.renameWorkspace(ws.workspace_id, 'Renamed')
    expect((await hc.workspaces())[0].label).toBe('Renamed')
    await hc.closeWorkspace(ws.workspace_id)
    expect(core.read().terminals.map((t) => t.labels['shepherdr.name'])).toEqual(['other'])
    expect(await hc.workspaces()).toEqual([])
  })
})

describe('worktrees on herdr-core', () => {
  test("git makes a task's worktree, as a space of its own; removing it removes the checkout, never the branch", async () => {
    const repo = mkdtempSync(join(tmpdir(), 'shep-hc-repo-'))
    dirs.push(repo)
    sh('git init -q -b main && git -c user.email=a@b -c user.name=a commit -q --allow-empty -m init', repo)
    const at = join(repo, '..', `${repo.split('/').pop()}-wt`)
    dirs.push(at)
    const r = await hc.worktreeCreate({ cwd: repo }, 'work-1', 'main', 'ST-1 Thing', at)
    expect(r.worktree?.path).toBe(at)
    expect(r.workspace.worktree).toMatchObject({ is_linked_worktree: true, checkout_path: at })
    expect(sh('git branch --show-current', at)).toBe('work-1')
    // opened again: the space already open
    expect((await hc.worktreeOpen({ cwd: repo }, at, 'ST-1 Thing')).already_open).toBe(true)
    await hc.worktreeRemove(r.workspace.workspace_id)
    expect(sh('git worktree list --porcelain', repo)).not.toContain(at)
    expect(sh('git branch --list work-1', repo)).toContain('work-1')
    expect(await hc.workspaces()).toEqual([])
  })

  test("herdr's folder for a branch: ~/.herdr/worktrees/<repo>/<branch>", () => {
    expect(worktreePath('/src/shop', 'work-2-fix', '/home/me')).toBe('/home/me/.herdr/worktrees/shop/work-2-fix')
  })
})

describe("an agent's environment on herdr-core", () => {
  test("the login and provider keys go along, nothing else of Shepherdr's", () => {
    expect(authEnv({ CLAUDE_CODE_OAUTH_TOKEN: 't', OPENAI_API_KEY: 'o', AWS_PROFILE: 'p', HOME: '/h', CLAUDE_CODE_ENTRYPOINT: 'x' })).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 't', OPENAI_API_KEY: 'o', AWS_PROFILE: 'p' })
  })

  test("Claude Code's and herdr's session markers are dropped before the agent runs; the login and your own stay", () => {
    // as hc runs it: sh -c SCRUB <program>, with no outer shell to expand $v or $0 early (dash on Linux would choke)
    const out = execFileSync('/bin/sh', ['-c', SCRUB, 'env'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_OAUTH_TOKEN: 'keep', CLAUDE_PID: '9', HERDR_PANE_ID: 'p1', CLAUDE_TEA_API: 'mine' },
    })
    expect(out).toContain('CLAUDE_CODE_OAUTH_TOKEN=keep')
    expect(out).toContain('CLAUDE_TEA_API=mine')
    for (const gone of ['CLAUDECODE=', 'CLAUDE_CODE_CHILD_SESSION=', 'CLAUDE_PID=', 'HERDR_PANE_ID=']) expect(out).not.toContain(gone)
  })
})
