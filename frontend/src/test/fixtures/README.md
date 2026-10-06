# API fixtures

What the real Fleet server answers, captured from `createApp` on a throwaway home with fake runtimes and synthetic state. They are the evidence for the React migration's contract types and tests (plan section 11, work package 1). Nothing here calls a model, touches `~/.claude`, `~/.codex` or `~/.claude-fleet`, or reaches the network.

## Regenerate

```bash
node frontend/src/test/fixtures/capture.js                  # every pack
node frontend/src/test/fixtures/capture.js day-full         # one pack
node frontend/src/test/fixtures/capture.js --serve fleet-mixed --port 4310   # keep a pack's server up
```

No install step: it needs only Node 22 and git. Each pack runs in its own child process (the server reads its directories from the environment when its modules load) on a fixed directory `/tmp/fleet-fixture-<pack>`, which is deleted and recreated each run. Output goes to `frontend/src/test/fixtures/<pack>/`, replacing the old files of that pack.

Running it twice gives byte-identical files on the same OS: the clock is fixed (`2026-10-06T10:00:00Z`, `TZ=UTC`, `Date.now` and `new Date()`), ids come from a counter, the per-process token is `FIXTURE_TOKEN`, and the temp path is rewritten to `/fixture`. Item fingerprints (`h`) hash the server's own JSON, so they are stable per OS (the path `/private/tmp` differs on macOS and Linux) but not across them. Regenerate after any server change that alters a response; review the diff, because a changed fixture is a changed contract.

`--serve` is what `frontend/e2e/baseline/capture.mjs` uses to serve the legacy UI against a pack. The same mode will serve the React build.

## File format

Every file is `{request, response}`:

```json
{ "request": {"method": "POST", "path": "/api/managed", "body": {...}, "note": "why this case"},
  "response": {"status": 201, "contentType": "application/json", "body": {...}} }
```

Naming: `get-<route>` for GETs, `post-<route>[-<case>]` for POSTs (`-invalid`, `-missing`, `-stale` for error bodies), `managed/<id>` for each managed session detail, `history/<engine>-<id>` for external transcripts, `markdown/` for project files, `index.json` for the list of files in a pack. Non-JSON bodies are inlined as text; image bytes are recorded as their length. The conditional variants of a GET are separate files: `get-sessions` (full, with `h` on every row), `get-sessions-not-modified` (304), `get-sessions-packed` (rows replaced by `{h}`).

## Packs

| Pack | State | Main evidence |
| --- | --- | --- |
| `fleet-mixed` | 11 managed rows (idle, running, approval, queued, error, stopped, Codex idle and running, fork-pending copy, held by a terminal, project-tagged), 8 live and offline external Claude sessions (busy, idle, stale, old, background observer, archived), 2 Codex sessions, plan usage windows, 3 git checkouts | list counts and filters, row shapes, SSE (`events-sse`), the request guards (`post-no-token`, `post-wrong-origin`, 415, malformed JSON, 405), launch/message/name/mode/model/stop/close, archive and rule, queue, approval mode, gateway, service, update, search, `summary.json` (one line per row) |
| `conversation-heavy` | one managed Claude conversation of 200 messages with a streaming last message, Bash/Read/Edit/TodoWrite/Task tools, truncated output, an event, an image and a reference, two queued follow-ups, a current approval and an AskUserQuestion, an errored session, a Codex session, a live external session with history | message shapes, `managed/c-heavy` full and `managed-c-heavy-grown-packed` (streaming growth with packed messages), 304, approvals (answer, deny, stale), images (valid, invalid, seventh, GIF to Codex), references (valid, self), attachments, PR status with failing CI |
| `teams-heavy` | a team initiative with 6 tasks and 25 delegations (oldest, running, interrupted, failed, completed) including 200 steps on the first, an owner-review initiative with Git snapshot and two reviewer runs | `managed/t-team`, `managed/t-owner`, team catalog and editor (`post-team-*`, built-in refusal, role count validation, owner-review team), limits, team launch |
| `day-full` | yesterday's Day and today's Day with 199 items (all statuses, sources, modes, priorities), open approve/choose/info/launch/report needs, a carried item with a previous thread, an active thread, scout history, capacity, a project-tagged item, a launched agent | `managed/day-today`, every `DayAction` (`post-day-*`, including the 500s the plan calls out for validation errors, the 200-item limit and the one-Day-per-date 409), plan on Today |
| `projects-collision` | Alpha and Beta with equal deliverable titles, punctuation, Unicode and 60-character-prefix collisions, hand-edited Markdown with arbitrary sections, 30 active projects at the cap plus archived ones, a Day | `get-projects*`, `collision-ids`, `markdown/*.md`, the cap (create, archive, restore at cap 409), setup that could not start (B01, no storage error), deliverable, ask, comment, plan on Today |
| `failure-lifecycle` | two managed rows and a terminal session | restart token rotation, the storage latch and its recovery, 304 and packed responses, 431, the 20-connection SSE limit (429), an SSE burst, missing assets, and `scenarios.json` (scripted network cases) |

## Inventory coverage

| F | Evidence |
| --- | --- |
| F01, F25 | `get-control`, `get-update`, `get-service`, `get-manifest`, `get-theme-css`, `post-update`, `post-service-disable` (any pack) |
| F02, F03 | `fleet-mixed/get-sessions`, `summary`, `get-sessions-not-modified`, `get-sessions-packed` |
| F04, F08 | `fleet-mixed/managed/*`, `fleet-mixed/history/*`, `conversation-heavy/managed/*` (held, fork-pending, external live and offline) |
| F05, F14, F15 | `teams-heavy/*` |
| F06, F07 | `get-models`, `get-teams`, `get-control` (`codex`), `fleet-mixed/post-managed-create*` |
| F09, F10, F11, F13 | `conversation-heavy/*` |
| F12 | `fleet-mixed/post-name`, `post-mode`, `post-model`, `post-stop`, `post-close` |
| F16, F17, F18, F34 | `day-full/*`, `projects-collision/post-today-*` |
| F19, F31 | `projects-collision/*` |
| F20 | `get-progress`, `get-progress-30`, `day-full/get-progress-after` |
| F21 | `fleet-mixed/post-search`, `get-search-job` |
| F23 | `fleet-mixed/post-queue-*`, `post-approval-mode*`, `post-gateway-*`, `post-service-disable` |
| F24 | `fleet-mixed/post-archive-*`, `post-restore-external` |
| F27 | `fleet-mixed/get-sessions` (`usage` with `unifiedWindows`) |
| F28 | `failure-lifecycle/*` |
| F29 | `get-worktrees` in every pack (real git checkouts) |
| F30 | `conversation-heavy/get-pr-status-open-ci-failing`, `*/get-pr-status-missing` |
| F32 | `day-full` (report need and Done), the client-side sound and notification behavior is a Playwright and unit-test matter |
| F35 | `conversation-heavy/post-message-gif-to-codex`, `post-message-image-invalid` |

Not captured, with the reason:

- **F22 Connections** (`POST /api/connections`): it spawns MCP probes and opens browser authentication. The shape is in the plan (section 6, `ConnectionResult`); capture it with a stubbed `Connections` when the contract tests need it.
- **F26 and F33**: F26 is layout and keyboard behavior (the screenshots in `frontend/e2e/baseline/screens/` and the Playwright journeys cover it); F33 (project manager write approval) is a tool-permission path whose result shows only as an ordinary approval (`conversation-heavy`) and a project log line.
- `POST /api/settings/gateway` with `save` or `test`, and `POST /api/service` with `enabled: true`: they write a credential or hand the process to launchd.
- Real model replies: the fake runtime answers `Fixture reply to: <prompt>`; message text from real turns is synthetic.

## Known quirks (real server behavior, kept on purpose)

- External Claude rows have no `engine` field; Codex rows carry `engine: 'codex'`. Treat a missing engine as `claude`.
- Day validation failures are plain 500s today (`post-day-add-invalid`, `post-day-triage-missing-item`, ...). Work package 2 gives them 4xx codes; update those fixtures then.
- `post-limits-wrong-session` in `teams-heavy` is a 200 because no run is active in the fixture; the active-manager 409 needs a live run.
- `/api/control` has no `instanceId`, `buildId` or `apiVersion` yet (`failure-lifecycle/token-3-control-after-restart`).

## Adding to a pack

A pack is `packs/<name>.js` with `prepare(ctx)` (build state before the server starts) and `capture(ctx)` (issue requests with `ctx.get`, `ctx.post`, `ctx.record`, `ctx.captureEvents`, `ctx.write`). `capture.js` documents the helpers (`ctx.managed`, `ctx.claudeExternal`, `ctx.codexExternal`, `ctx.git`, `ctx.script`, `ctx.livePending`). Keep every id, timestamp and path derived from `ctx.now()` and the counter, never from the real clock, or the determinism check (run twice, diff) fails.
