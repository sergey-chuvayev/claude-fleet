# React migration: performance gates, accessibility and stress results

Work package 5 of `2026-10-06-react-migration-design.md` (sections 9 and 11). Measured on
2026-10-06 on branch `test/stress-a11y-perf` merged with `react-migration` at `9949739`, legacy `public/` (0.54.0) against the React
production build, same machine, browser, fixture and viewport.

## Setup

| | |
| --- | --- |
| Machine | Apple M4 Pro, 14 cores, 48 GB, macOS 26.6.2 |
| Runtime | Node v24.13.0, Chromium 145.0.7632.6 headless shell (Playwright 1.58.2) |
| Commit | `e6c914d` (the fixes below, merged with `react-migration`), build id `0.54.0+fc5b1a41c7e8` (package version plus the Vite manifest hash, as `server.js` computes it) |
| Fixture | `conversation-heavy` (164 messages in `c-heavy`, streaming last message, tools, approvals, queued follow-ups), served by `capture.js --serve` |
| Viewport | 1440x900, scale 1, dark, en-GB, UTC |
| Runs | per implementation 1 cold start (new browser, empty cache) and 3 warm runs (same context, reloaded); medians reported |
| Command | `npm run build:frontend && PLAYWRIGHT_DIR=... node frontend/e2e/journeys/perf.mjs --runs 3 --out perf.json` |

Legacy is served by the fixture server itself (its own `public/` routes and headers);
the React build by `frontend/e2e/journeys/serve.mjs` with the same security headers.
Both sit behind the same front, which also plays a synthetic engine: it answers
`/api/events` and `GET /api/managed/c-heavy` itself, grows the streaming message by four
words every 100 ms and announces each change with a `sessions` event (and a `list` event
every second), with ETags and packed messages from the server's own `sync.js`. No real
model, no network.

## Gates

| Metric | Target (plan) | Legacy 0.54.0 | React build | Verdict |
| --- | --- | --- | --- | --- |
| Cold startup to usable conversation | under 1.5 s, at most 10% worse than legacy | 228 ms | 140 ms | pass, 39% faster |
| Warm startup (reload, cache warm) | same | 199 ms | 89 ms | pass, 55% faster |
| p95 input to next paint while streaming (30 keystrokes + 8 session switches) | under 100 ms | 24 ms | 40 ms | pass, see note 1 |
| of which keystrokes in the composer, p95 | | 16 ms | 24 ms | |
| of which session switches, p95 | | 24 ms | 48 ms | |
| Input or focus lost while streaming | none | none | none | pass |
| Long tasks over 50 ms in 8 s of steady streaming | none repeated | 0 | 0 | pass |
| Main-thread task time while streaming | | 238 ms/s | 230 ms/s | parity, see note 2 |
| Detail GETs for 80 stream events (8 s) | one in flight per resource, coalesced | 91, about 6.0 KB each (packed) | 91, about 6.0 KB each (packed) | parity, see note 3 |
| Settled (8 s, no stream): GETs, 304 share | settled resources answer 304 | 4 GETs, 3 of them 304 | 4 GETs, 3 of them 304 | pass |
| Idle animation-frame callbacks | no rAF polling | 0 per s | 0 per s | pass |
| Idle main-thread task time | near zero for cosmetic work | 228 ms/s | 196 ms/s | see note 2 |
| Idle script time | | 1.6 ms/s | 2.6 ms/s | pass |
| Idle with reduced motion | | 7.1 ms/s | 0.8 ms/s | pass |
| Initial JS, gzip | at most 250 KiB | 161 KiB (18 scripts, all loaded at start) | 119 KiB (14 chunks) | pass |
| Initial CSS, gzip | | (in `styles.css`) | 9.1 KiB | |
| Lazy JS, gzip (all other chunks) | | n/a | 138 KiB | |
| Heap after 100 selection + modal cycles, after GC | within 10% of post-warm-up | +3.8% (7.4 MB) | +7.4% (9.1 MB) | pass |
| DOM nodes and JS listeners after those 100 cycles | bounded | nodes -113, listeners 0 | nodes 0, listeners 0 | pass |

Per run (warm startup ms; switch p95 ms): legacy 135, 210, 199; 112, 24, 24. React 61,
91, 89; 112, 48, 40. The first run of each pays for the first render of `c-error`.
Before the merge (`fb73f31`) the same command gave the same picture within a few ms.

Notes:

1. The React build is slower than legacy on interaction (24 against 16 ms per keystroke,
   48 against 24 ms per session switch, Event Timing granularity is 8 ms), while every
   value stays under half the target. Not optimized here; the plan says not to trade
   features for it, and nothing here is near the gate.
2. Idle and streaming main-thread time is dominated by 182 running CSS animations (the
   pixel avatars and status dots), which legacy has too: with reduced motion the idle cost
   falls to 7.1 ms/s for legacy and 0.8 ms/s for React. Script time is 1.6 to 2.6 ms/s and
   no animation frame is requested while idle, so there is no JavaScript polling loop.
   Pausing avatars that are off screen would cut this for both; that is a design change
   and is left as a proposal.
3. One detail GET per `sessions` event plus the 2.5 s safety refresh, each packed (6 KB
   of a 300 KB conversation) or 304, never two in flight for the same key (A25 tests
   below). Both implementations behave the same here.

## Fixes made for these gates

| Commit | What |
| --- | --- |
| `fb73f31` fix(frontend): draw the first view without waiting out React's Suspense throttle | Startup was 380 ms warm against legacy 130 ms. The first view's lazy chunk showed a Suspense fallback, and React 19 holds a reveal back for up to 300 ms after a fallback, so the conversation appeared about 300 ms after its data. `main.tsx` now loads the first view's code before the first render, and a loaded view part renders without suspending (`app/views.tsx`). Switching to a view not visited yet still pays that once. |
| `4f4be86` fix(frontend): bound the resource cache and resource families | Every session ever opened kept its detail in the store for the life of the page. Unwatched keys are kept up to 48, newest first; watched keys and keys with a request out are never dropped; a resource family keeps at most 256 definitions. |

A measurement trap worth knowing: `page.waitForSelector` returns an ElementHandle, which
keeps each closed React dialog alive (legacy's dialogs persist, so it does not show). The
first heap run read +23% and +218 nodes per cycle for that reason alone; `perf.mjs` uses
locators.

## Accessibility (A23)

`node frontend/e2e/journeys/run.mjs a11y`, all passing: keyboard only (list selection,
team fold, delegation detail, splitter Arrow/End/Enter, combobox Arrow/Home/End/Enter and
Escape, focus trap over 40 Tabs, modal close and focus return), answering an approval
from the keyboard, 390x844 touch (native pickers, all views), 200% zoom (720x450 CSS px at
scale 2, five views and Settings), reduced motion (no running animation; 182 without the
preference), a dialog taller than a 420 px window (scrolls inside, every focus stop
visible and trapped), statuses in words, and axe-core 4.14 on seven views and four dialogs.

Fixed (one commit each, each with a regression test):

| Commit | Finding |
| --- | --- |
| `993e9d1` | Escape and Tab stopped working in a dialog after a control disabled itself while saving (the queue limit Select in Settings): focus fell to `<body>` with no focusin to catch it. |
| `ec7adb8` | axe image-alt (critical): images in agent Markdown without alt text were announced as their URL. |
| `a0a9805` | axe landmark-unique: Today, Projects, Progress and Worktrees had two regions with the same name (the workspace and the pane). |
| `2baafa8` | After Allow once or Deny from the keyboard, focus fell to the page with the card. It now moves to the next waiting card, else the composer. |

Known, reported by the suite as notes and not fixed here (all present in legacy 0.54.0
markup or palette):

| Rule | Where | Why left |
| --- | --- | --- |
| color-contrast (serious) | `--muted` #87878f at 9 to 10 px on raised surfaces: block meta, badges, composer hint, queued labels (3.95 to 4.45, needs 4.5) | legacy token; changing it is a palette decision for the design pass |
| nested-interactive (serious) | `<summary>` rows with buttons inside on Projects, Today and Worktrees | legacy structure; needs a layout change |
| scrollable-region-focusable (serious) | long tool output `<pre>` scrolls but takes no focus | a tab stop per code block in a 200-message log is worse; consider focusable only when it overflows |
| label-content-name-mismatch (serious) | the question pin ("Back to your message: ...") shows "YOU ..." | wording choice |
| heading-order, page-has-heading-one (moderate) | h2 then h4 sections; no h1 | legacy heading levels |
| aria-allowed-role (minor) | `textarea role=combobox` (composer), `h2 role=button` (title) | valid ARIA 1.2 patterns axe does not accept on these elements |
| 390 px overflow | the top bar's sideways-scrolling action row ends 4 px past the edge | identical in legacy (measured); the suite allows exactly those 4 px |

## Stress and races (A24 to A28)

`npm run test:frontend` includes `frontend/src/stress/`: the whole app in StrictMode
against a programmable fake Fleet that answers through the server's real `sync.js`.

| Test | Covers | Result |
| --- | --- | --- |
| `conditional.app.test.tsx` | A24: 304 (body never read), packed, unknown fingerprint, 431, removal and reorder; unchanged rows keep identity; a route failing twice is tried twice per refresh, keeps the last good list and says so; 30 packed message growths lose nothing | pass |
| `races.app.test.tsx` | A25: a burst of 20 events while a GET is out is one follow-up; list bursts coalesce; a GET that left before a mutation cannot overwrite it; a swapped-away session failing late never shows its error; a hidden page reads nothing for the list and each watched key once on return | pass after `029f94c` (a failed resource shown again was never read again) |
| `recovery.app.test.tsx` | A26: offline keeps last good list and draft, reconnect reads unconditionally; new instance drops old approvals and ETags, keeps the draft, sends nothing; stale token is not retried and the resend reuses the requestId; an ambiguous POST failure is reconciled by reading. A27: storage banner, draft kept, Stop allowed, banner clears only after a write lands, retry reuses the requestId | pass |
| `lifecycle.app.test.tsx` | A28: 100 mount/switch/unmount cycles in StrictMode with events flowing: one EventSource, no listener, interval, long timer, observer, object URL or frame loop left, nothing watched after unmount; cache bounded with 200 sessions churned | pass after `4f4be86` |

Observation, not changed: while the tab is hidden, a `sessions` event naming the session
on screen still reads it (the list waits for the page to return). Legacy `control.js`
does the same; with an agent streaming in a background tab that is one small packed GET
per event.

## Open risks

- The numbers are from one fast machine. The gate for a slower reference laptop is
  "under 1.5 s" and both builds are far under it here; rerun `perf.mjs` there before
  calling the startup gate closed.
- `serve.mjs` stands in for the cutover `server.js` (same CSP and headers). Once the
  cutover serves `dist/`, rerun the journeys against it.
- The synthetic stream is one conversation at 10 updates per second. A fleet with many
  busy agents adds list events, not detail GETs (only the selected detail is watched).
