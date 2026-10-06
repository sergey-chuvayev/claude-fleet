'use strict'
// Invariants of legacy browser tests removed at cutover (work package 6) whose React
// replacement was not yet in frontend/src when the legacy app was deleted. The legacy
// tests ran public/ scripts in a VM and cannot outlive them, so each lost assertion is
// kept here as a todo, visible in every `npm test` run, until its replacement lands.
// docs/plans/2026-10-06-react-migration-test-map.md lists the same rows as PENDING.
// When a replacement merges, delete its line here and mark the map row "replaced by".
const {test}=require('node:test')

const pending=[
  ['fleet.test.js: the cost label never rounds a real spend down to nothing', 'domain/format.test.ts (formatMoney); no cost display exists in frontend/src yet'],
  ['fleet.test.js: the status bar reports absence honestly and swaps to the countdown when a window is nearly gone', 'features/status/UsageStatus.test.tsx: unknown draws nothing, API key hides the cluster, stale "as of", countdown past 90%, warn/hot, zero still drawn, blocked text'],
  ['fleet.test.js: a team session renders one nested child row per delegation, with role, model and status', 'SessionList.test.tsx: the per-row status word; DelegationDetail.test.tsx: attempt stat, token usage line and its fallback, no cost, escaped step input'],
  ['model-picker.test.js: refreshing a session\'s model picker does not reset the launch model', 'features/launch/models.test.tsx or SessionDetail.test.tsx'],
  ['review.test.js: free text is sent as typed, trimmed, and the box is cleared on success (and whitespace-only sends nothing)', 'features/sessions/SessionInspector.test.tsx'],
  ['review.test.js: a failed send keeps what was typed and says why', 'features/sessions/SessionInspector.test.tsx'],
  ['review.test.js: picking the CI option fills the box with the message', 'features/sessions/SessionInspector.test.tsx'],
  ['review.test.js: no PR link means no panel, and showing the same session again changes nothing (draft kept)', 'features/sessions/SessionInspector.test.tsx'],
  ['select.test.js: a scroll closes the menu only when it moves the trigger', 'components/Select.test.tsx'],
  ['teams-board.test.js: the roster shows the configured model (manager reflects selectedModel), never the in-flight one', 'features/teams/TeamOverview.test.tsx'],
  ['views.test.js: Progress is a view of its own, and aria-pressed follows every switch', 'app/AppShell.test.tsx'],
]
for (const [legacy, replacement] of pending) test.todo(`${legacy} -> pending React test in frontend/src/${replacement}`)
