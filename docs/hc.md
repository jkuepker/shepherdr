# Running on herdr-core (the Herdr app)

Shepherdr runs its coordinators and task agents in herdr by default. It can run them in herdr-core (`hc`) instead,
the runtime behind the Herdr desktop app. There, every coordinator and every task agent is a terminal on the core
and shows up in the Herdr app: each Shepherdr space and each task gets a space in the app, named as in Shepherdr, and
its agent gets a tab there (a task's is `Agent`). Its status comes from the agent itself (OSC 7501), so the app's
agent list and its working, done and blocked marks follow Shepherdr's agents too.

## Turn it on

Set `SHEPHERDR_BACKEND=hc` for the server, or write `{"backend": "hc"}` to `~/.shepherdr/backend.json`. Leave both
unset to stay on herdr.

To switch an install that already runs on herdr:

1. Stop Shepherdr (`bun scripts/plugin.ts stop`).
2. Close its coordinators and task agents in herdr. An agent still running there would keep answering the same chat
   next to the one Shepherdr starts on herdr-core.
3. Turn the herdr plugin's start off (or remove the plugin), so herdr's next start does not bring Shepherdr back up
   there.
4. Start Shepherdr on herdr-core (below). Each chat starts its agent the next time it is needed, resuming its
   session. Tasks keep their worktrees, because git puts them where herdr did (`~/.herdr/worktrees/<repo>/<branch>`).
   Resuming chats and tasks that were started on herdr has not been tested yet.

On herdr-core there is no herdr plugin to start Shepherdr, so start it yourself:

```sh
SHEPHERDR_BACKEND=hc bun scripts/plugin.ts start    # stop, status and share work the same
```

To keep it running across logins, use a launchd agent (macOS) or a systemd user service (Linux) that runs that
command. Give it the PATH your shell has, so it finds `hc`, `git` and the agent CLIs. Give it your Claude login and
provider keys too (`CLAUDE_CODE_OAUTH_TOKEN`, `*_API_KEY`), the way your shell profile sets them. A launchd example:

```xml
<key>ProgramArguments</key>
<array><string>/bin/zsh</string><string>-lc</string>
  <string>. ~/.secrets.env; cd ~/path/to/shepherdr &amp;&amp; SHEPHERDR_BACKEND=hc exec bun scripts/supervise.ts</string></array>
<key>KeepAlive</key><true/>
```

Here `supervise.ts` runs in the foreground: it restarts the server and rebuilds it when the checkout moves to a new
commit. `plugin.ts start` detaches that same supervisor.

## Other machines

The machines are the ones `hc machine ls` lists and reaches over SSH (`hc machine add <ssh target>`). Machines that
are only in herdr's list do not count here. Each machine gets its helper and a worker, as on herdr. A machine's
terminals start through this computer's core, with `on` set to that machine, and the app shows them under that
machine. `SHEPHERDR_MACHINES=a,b` limits the workers to the machines named. An empty value runs none.

## What the agents get

The core gives every terminal its own environment: that of whoever started the core first, not Shepherdr's. So
each agent starts through `sh`, which first unsets the Claude Code and herdr session markers it inherited:
`CLAUDECODE`, `CLAUDE_CODE_*` (except the login), `CLAUDE_PID`, `CLAUDE_AGENT_SDK_*`, `CLAUDE_PLUGIN_*` and
`HERDR_*`. One of those markers turns Claude Code's transcripts off, and the transcripts are where Shepherdr reads
its chats from. Shepherdr hands each agent on this computer the Claude login and the provider keys from its own
environment. They travel in the core's API call, never on a command line. Agents on other machines use their
machine's own core environment.

## What is reduced on herdr-core

- **The terminal view is plain text.** hc reads a terminal's text, not its colours, so a task's terminal shows no
  ANSI colours. The core also sends no output events, so the open terminal view is read again about every 0.7 s.
- **Typing into the terminal view.** hc types named keys and the characters of an unshifted US keyboard. Text with
  other characters (`_ ! " : ( ) { } < > ? @ # $ % & * + | ~`) goes in only together with the Enter that follows
  it, as one paste. Typed alone, without an Enter, it is left out, and the server log says so. Answering cards and
  sending messages are not affected.
- **No agent session from the runtime.** herdr names each agent's log file; hc does not. Shepherdr finds the log
  itself, as it already does for agents herdr has no integration for: Claude Code through its hooks, and Codex and
  pi by their newest log in the task's folder.
- **Status for Codex, pi and other CLIs.** Only a CLI that reports OSC 7501 has a status (Claude Code does). One that
  reports none shows as running, with no working or idle state, and takes input a moment after it starts.
- **No nesting.** In the app, a task's space is a space of its own, not nested under its repo's space. Shepherdr opens
  no repo space for a task and closes none.
- **No herdr notifications.** Shepherdr's own alerts and push notifications still go out.
- **No Autopilot isolation.** An isolated run needs a pane's own shell, which an hc terminal does not have, so it
  refuses to start. Regular coordinators and tasks work.
- **When an agent exits,** its terminal ends and closes in the app. Shepherdr starts it again, resuming its session,
  just as it does when an agent stops under herdr.
