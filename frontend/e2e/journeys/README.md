# Production-build journeys, accessibility and performance

Work package 5 of the migration plan (`docs/plans/2026-10-06-react-migration-design.md`,
sections 9 and 11). Everything here runs the production build (`dist/`) in Chromium,
served by the real server (`createApp` serves `dist/` since the cutover, with its own
manifest allowlist, security headers and CSP) on a throwaway home with fake runtimes:
`frontend/src/test/fixtures/capture.js --serve <pack>`. No model is called, nothing in
`~/.claude`, `~/.codex` or `~/.claude-fleet` is read or written. Rebuild after a source
change: the fixture server serves whatever `dist/` holds.

## Run

```sh
npm run build:frontend
PLAYWRIGHT_DIR=/dir/with/playwright node frontend/e2e/journeys/run.mjs            # journeys + a11y
PLAYWRIGHT_DIR=/dir/with/playwright node frontend/e2e/journeys/run.mjs journeys   # one suite
PLAYWRIGHT_DIR=/dir/with/playwright node frontend/e2e/journeys/run.mjs approval   # tests whose name contains "approval"
```

Playwright is not a dependency of this repo. Point `PLAYWRIGHT_DIR` at any directory
with `playwright` in its `node_modules` and a Chromium installed
(`npm i playwright && npx playwright install chromium-headless-shell`). For the axe
checks, also make `axe-core` loadable: `AXE_DIR=/dir` where `/dir/node_modules/axe-core`
exists (`npm i axe-core` there), or install it next to Playwright. Without it the name
checks fall back to a targeted check and say so in their notes.

Options: `--headed` shows the browser; `E2E_SCREENSHOTS=/some/dir` saves a screenshot of
each failing test. Exit code 1 when any test fails. Each test gets its own fixture
server (the journeys write state), so the full run takes about a minute.

To poke at the build by hand: `node frontend/e2e/journeys/serve.mjs day-full --port 4400`.

Performance, legacy against React (about four minutes; results and their reading are in
`docs/plans/2026-10-06-react-migration-perf.md`). `public/` is gone since the cutover, so
the legacy side runs from a pre-cutover checkout named by `LEGACY_ROOT` (see
`../legacy.mjs`); without it only React is measured:

```sh
git worktree add /tmp/fleet-legacy a8c8498
LEGACY_ROOT=/tmp/fleet-legacy PLAYWRIGHT_DIR=/dir/with/playwright node frontend/e2e/journeys/perf.mjs --runs 3 --out /tmp/perf.json
PLAYWRIGHT_DIR=/dir/with/playwright node frontend/e2e/journeys/perf.mjs react --runs 1   # one side, quick
```

The fixture servers use fixed directories (`/tmp/fleet-fixture-<pack>-serve`), so run one
of these commands at a time on a machine.

## Files

| File | What |
| --- | --- |
| `serve.mjs` | Starts a fixture server (this checkout's, or a pre-cutover one for the legacy page), which serves `dist/` itself. `startFront` is a transparent proxy in front of it for the performance runs (request counts, a synthetic stream), applying Fleet's own Host/Origin/Sec-Fetch-Site guard to its own address as `frontend/dev/fleet-proxy.mts` does for Vite. The fixture server's guards are never relaxed. |
| `harness.mjs` | Loading Playwright and axe-core from outside the repo, a page per test (fixture clock, en-GB, UTC, page errors and 5xx answers fail the test), `eventually`, POST recording. |
| `journeys.mjs` | The user journeys. |
| `a11y.mjs` | A23: keyboard only, 390px, 200% zoom, reduced motion, long dialog, statuses in words, axe per view and dialog. |
| `perf.mjs` | The performance gates, legacy against React on the same fixture. Writes JSON; the numbers are in `docs/plans/2026-10-06-react-migration-perf.md`. |
| `run.mjs` | The runner. |

## Journeys

| Journey | Pack | Asserts |
| --- | --- | --- |
| session select, conversation and approval allow | fleet-mixed | selection moves the conversation; Allow once sends exactly one `{decision:'allow'}` and the card and the row's "Needs approval" go |
| launch from Today | day-full | New agent from Today: one create POST with a requestId, modal closes, view and selection move to the new session; a Launch need sends the edited brief word for word and settles |
| composer send with an image | fleet-mixed | a dropped PNG shows in the tray; Enter sends one POST with the text, one image and a requestId; the draft clears; the fake runtime answers to an image prompt (not stdin text) |
| Today triage and answering a need | day-full | Today on a triage card moves it (28 to 27); an info answer sends the exact text and leaves Waiting on you (5 to 4) |
| project create and plan on Today | day-full | one create POST and the new project opens; a deliverable planned on Today appears on the Day board |
| search, Open in Fleet | fleet-mixed | Cmd+K, a keyword search, Open in Fleet closes the dialog and selects that session in Sessions |
| settings queue limit | fleet-mixed | the limit Select sends `{limit:4}`, the dialog reflects it, Escape still closes after the Select disabled itself while saving, focus returns to Settings, and a reload reads 4 from the server |

## Accessibility notes

Failing: any axe violation of impact critical, and any of the name/role rules listed in
`NAME_RULES` in `a11y.mjs`. Reported, not failing: findings inherited from the legacy
markup and palette, listed with their counts in the perf document. At 390px the top
bar's sideways-scrolling action row ends 4px past the edge, exactly as legacy 0.54.0
does; the check allows those 4px and no more.
