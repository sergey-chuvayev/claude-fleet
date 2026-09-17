<div align="center">

<img src="public/icons/fleet-512.png" width="88" alt="">

# Claude Fleet

**A local control room for Claude Code.**

See every session running on your machine, launch agents you can talk to,
and ask one question across everything you have ever worked on.

<img src="https://img.shields.io/badge/node-%E2%89%A522-2aa889?style=flat-square&labelColor=0c1014" alt="Node 22+">
<img src="https://img.shields.io/badge/binds-127.0.0.1-2aa889?style=flat-square&labelColor=0c1014" alt="Binds to localhost">
<img src="https://img.shields.io/badge/deps-4%20runtime-2aa889?style=flat-square&labelColor=0c1014" alt="Four runtime dependencies">
<img src="https://img.shields.io/badge/license-MIT-2aa889?style=flat-square&labelColor=0c1014" alt="MIT license">

<br>
<br>

<img src="docs/dashboard.png" alt="The Fleet dashboard: a list of Claude Code sessions on the left with status, context usage and a per-turn activity strip, and a terminal-style conversation on the right showing a syntax-highlighted diff and a failed test run.">

</div>

---

Claude Code is happiest in a terminal, which is fine until you have six of them.
Fleet gives that sprawl one window: what each session is doing, which one failed,
which one is about to run out of context, and which one has been waiting on you
for twenty minutes.

Terminal sessions are watched read-only. Fleet never injects keystrokes and never
kills a process it did not start. Agents you launch *from* Fleet are different:
those you can message, approve, interrupt and resume.

Everything runs on `127.0.0.1` against the Claude account already configured on
your machine. There is no service, no account, and no telemetry.

## Quick start

```bash
git clone <this repo> claude-fleet && cd claude-fleet
npm install
./start.sh
```

`start.sh` prints the URL it actually bound to and opens it. If port 7777 is
taken, Fleet tries the next ten.

```bash
npm start            # server only, default port 7777
PORT=8080 npm start  # pick a port
npm test             # data, controller, permissions, theme and HTTP tests
npm run app          # build "Claude Fleet.app", a macOS launcher
```

Requires **Node 22+** and a working `claude` on your PATH.

## What it does

### The session list reads like a CI job

Each row is one session: its state, project, branch, context pressure, and the
story of its latest turn. The strip of segments is one segment per tool call
since your last message, coloured by the kind of work (grey for inspecting,
accent for changing files, cyan for commands, violet for sub-agents) and red
where a call failed, attributed by exact tool id rather than by name. Beside it,
in words, is the step running now or the last step taken. On the right, how long
the turn has been going.

Colour never carries meaning alone: every segment names its call on hover, and
the row has a spoken summary such as *"This turn: 4 inspecting, 2 changing files,
1 failed. Now: Bash Run the test suite."*

| State | Meaning |
|---|---|
| **Working** | Marked busy by Claude |
| **Waiting** | Alive, waiting for input |
| **Stale** | Alive but untouched for over three days |
| **Offline** | Registry entry whose process has exited |
| **In terminal** | A Fleet conversation currently held by a terminal |

Context turns amber at 75% and red at 90%. A `[1m]` marker or observed usage
above 200k identifies a 1M context window.

<details>
<summary><b>Background sessions and sub-agents</b></summary>

Sessions a program started rather than a person (an SDK run, a plugin's worker, a
background indexer) are kept out of the main list and counted under a
**Background** filter. They are identified by a registry `entrypoint` other than
`cli`. The registry records no parent, so Fleet walks the process tree: when an
ancestor is another session, that session's row shows a `⑂ n` badge and the
background row reads "via that session"; when the chain leads to a daemon
instead, the row names the program running it.

Tools invoked inside a turn, including sub-agents from the Task tool, run in the
session's own process and never appear as separate rows at all.

</details>

### The conversation is a stack of blocks

![The Fleet console showing a rendered Markdown answer with an inline table, above a composer](docs/console.png)

Each message, tool call and tool result is its own block, the way a terminal
groups a command with its output. A block shows what ran, how long it took and
whether it failed, and can be collapsed or copied on its own. Long output starts
collapsed.

Tool blocks are rendered per tool: a shell command as a prompt line, an edit as a
diff, a to-do list as a checklist, everything else as its input. Assistant text is
Markdown with syntax-highlighted code. Markdown, sanitising and highlighting come
from `marked`, `DOMPurify` and `highlight.js`, bundled into `public/vendor/libs.js`
and served by Fleet itself. There is no CDN, and the page's content security policy
still allows scripts only from Fleet.

### Ask your sessions

**Ask** in the top bar (`Cmd/Ctrl+K`) answers a question across every Claude Code
transcript on this machine: *"did we ever work out why recordings went missing on
answered calls?"* It replaces scrolling back through `claude --resume` hunting for
the session where something was decided.

It runs in two stages, and you see the first one immediately.

1. **Keyword pass, local.** Fleet indexes the visible conversation of every
   transcript modified in the last 60 days and ranks passages with BM25. Nothing
   leaves the machine, and it takes about 10 ms once the index is warm.
2. **Answer pass, one Claude call.** The best ten sessions and their excerpts go
   to a single short, tool-less turn that writes the answer and says which
   sessions are genuinely about the question. It cannot cite a session the
   keyword pass did not find. Haiku by default.

What gets indexed is what a person would recognise as the conversation: your
messages and Claude's replies. Tool calls and results are excluded, since they are
the bulk of a transcript and would match on file contents rather than discussion.

<details>
<summary><b>Why the answering turn is so bare</b></summary>

`tools: []`, no project settings, no CLAUDE.md, `persistSession: false` so a search
never becomes a transcript that the next search finds, and thinking disabled.
That last one is the whole latency budget: measured on a real corpus, adaptive
thinking cost 33 s and 2,800 output tokens for the same answer that takes 9 s and
578 tokens without it.

The `claude-mem` plugin's observer sessions are skipped entirely. They are
machine-written summaries of every other session, so they would out-match the real
conversation on every question.

</details>

### Approvals that stay out of the way

Every agent runs in one of three modes, chosen at launch and changeable from the
conversation header.

- **Auto** (the default) answers ordinary requests for you and still stops for
  anything that destroys data (`rm`, `shred`, `dd`), reaches another host
  (`curl`, `wget`, `ssh`, `rsync`), runs an unreviewable script (`sh -c`, `eval`),
  escalates (`sudo`, `doas`), or publishes (`git push`, `npm publish`).
- **Ask every time** runs nothing unreviewed.
- **Approve everything** never stops.

A command is judged per shell segment, so `cd build && rm -rf .` is read as `rm`,
and wrappers like `env FOO=1`, `xargs` and `find -exec` do not hide it. A question
from Claude and a plan for review always reach you, in every mode. Blocks Fleet
approved on your behalf are marked **auto**, so a quiet run is never a silent one.
Your existing Claude permission rules and hooks still apply first.

That list is one array in [`permissions.js`](permissions.js). Edit it to taste.

<details>
<summary><b>Models, images, slash commands, and sessions held elsewhere</b></summary>

**Models.** Picked at launch and switchable from the conversation header. A change
applies from your next message, because each message starts a fresh query against
the same resumed session. The list is the runtime's own once a run has reported
it, and falls back to Opus/Sonnet/Haiku before then.

**Images.** Paste a screenshot into the composer or drop a file on it. Up to six
per message, PNG/JPEG/GIF/WebP, 8 MB each. Bytes are sniffed rather than trusted by
declared type, and stored owner-only under `.fleet/attachments/` with a fresh id,
which is the only thing the `/api/attachments/<id>` route accepts.

**Slash commands.** Type `/` at the start of a line to search this project's
commands and skills: yours, the project's, and each plugin's. The picker only
writes text into the composer, and nothing runs until you send. Claude Code's
built-ins (`/model`, `/clear`, `/compact`) are interpreted by the interactive CLI
rather than the SDK, so they are deliberately absent; where Fleet can offer the
same thing it does so as a real control instead.

**Held elsewhere.** If you resume a Fleet conversation in a terminal, its row
switches to **In terminal**, mirrors what that terminal is doing, and the composer
says which window has it and since when. Fleet refuses to send until that process
exits, because two writers on one transcript would corrupt it.

**Limits.** Four simultaneous runs, one turn per agent, up to 100 managed
conversations, messages up to 16,000 characters. The latest 200 conversation
entries persist in `.fleet/sessions.json`. Claude keeps its own full transcript, so
`claude --resume <session id>` still reaches a conversation Fleet has forgotten.

</details>

### It borrows your terminal's colours

Fleet reads the active theme named in `~/.warp/settings.toml`, loads it from
`~/.warp/themes/`, and serves it as CSS variables at `/theme.css`. Surfaces and
muted text are mixed from the terminal's own background and foreground with
`color-mix()`, so any Warp theme produces a coherent dashboard rather than a
clashing one.

Only colour values and the terminal font size are read, a theme file outside the
themes directory is ignored, and anything that is not a hex colour is discarded.
Without Warp installed, Fleet uses its own palette. Set `CLAUDE_FLEET_WARP_DIR` to
read a different directory.

The app icons are drawn geometrically from that same palette by `npm run icons`,
with no image library, so rerun it if you switch themes.

### It can live in the Dock

`npm run app` builds **Claude Fleet.app** next to the project. Opening it starts
the server if it is not already listening, then opens Fleet in a Chrome app window
with no tab strip or address bar. It falls back to Edge, then Brave, then your
default browser, and logs to `~/Library/Logs/claude-fleet.log`. The bundle holds no
credentials and no copy of the project, only the path to it.

Fleet also serves a web app manifest, so you can install it from the browser
instead: in Chrome, **⋮ → Cast, Save and Share → Install page as app**; in Safari,
**File → Add to Dock**.

## Local boundary

Fleet binds to `127.0.0.1`. It rejects unrecognised Host headers and cross-origin
requests, requires a per-server token for actions, serves only explicit UI assets,
and does not enable CORS. **Do not expose this server through a public proxy.**

Managed agents can modify files and run tools as permitted by your Claude settings
and approvals. Monitoring external sessions only ever reads their state.

Asking a question reads every transcript in the window, including sessions from
other projects, and sends the matched excerpts (not whole transcripts) to Claude as
one prompt. That is the only part of Fleet that leaves the machine.

Local state files use owner-only permissions. A process lock prevents two Fleet
servers from controlling the same stored conversations. Graceful shutdown cancels
managed runs and pending approvals; stopping Fleet does not stop external agents.

GitHub PR and Linear issue links shown on a row are extracted from visible
conversation text. They are recorded references, not live PR or ticket status, and
no API credentials are involved.

## How it is built

Vanilla HTML, CSS and JavaScript over a Node HTTP server, with the official Claude
Agent SDK for managed runs. Four runtime dependencies, no framework, no build step
for the app itself.

| File | Responsibility |
|---|---|
| [`server.js`](server.js) | Local HTTP API, event stream, origin and token checks, static assets |
| [`fleet.js`](fleet.js) | Cached, read-only collection of external Claude sessions |
| [`managed.js`](managed.js) | SDK runs, approvals, tool blocks, persistence, cancellation |
| [`search.js`](search.js) | Transcript index, BM25 ranking, and the answering turn |
| [`permissions.js`](permissions.js) | The three approval modes and the command list that still stops |
| [`theme.js`](theme.js) | Reads the local Warp palette and renders it as CSS variables |
| [`catalog.js`](catalog.js) | Read-only listing of a project's slash commands and skills |
| `public/app.js` | Dashboard layout, session list, filters, monitoring |
| `public/blocks.js` | Incremental block rendering, Markdown, highlighting |
| `public/control.js` | Launch form, composer, approvals, streamed updates |
| `public/ask.js` | The Ask panel, its polling, and the result cards |
| `build/` | Vendored browser bundle, icon drawing, macOS launcher |

### Environment

| Variable | Effect |
|---|---|
| `PORT` | Preferred port, default 7777 |
| `CLAUDE_FLEET_DIR` | Claude home to read sessions from, default `~/.claude` |
| `CLAUDE_FLEET_EXECUTABLE` | Absolute path to the `claude` binary, or `bundled` for the SDK's own |
| `CLAUDE_FLEET_WARP_DIR` | Warp configuration directory to theme from |
| `CLAUDE_FLEET_SEARCH_DAYS` | How far back Ask indexes transcripts, default 60 |
| `CLAUDE_FLEET_SEARCH_MODEL` | Model for the Ask answering turn |

The SDK ships its own Claude runtime, which can lag the CLI you actually use and
so offer an older set of models. `start.sh` and the Mac app therefore prefer the
`claude` on your PATH. Running `npm start` directly does not apply this preference.

### Development

```bash
npm test          # node --test across *.test.js
npm run vendor    # rebuild public/vendor/libs.js after changing its inputs
```

`app.js`, `blocks.js` and `control.js` are classic scripts sharing one global
scope, so a duplicate top-level `const` across files is a `SyntaxError` that kills
the page and `node --check` cannot see it. The test suite loads all three in one VM
context and fails on any such collision. **Run `npm test` after touching a browser
script.**

Fleet reads `index.html` from disk per request, but its static allowlist is held in
memory, so an old process will serve a new page whose new assets 404. Restart after
adding a route.

## License

MIT. See [LICENSE](LICENSE).

<div align="center">
<sub>Screenshots use synthetic sessions generated for the purpose. Fleet is not affiliated with Anthropic.</sub>
</div>
