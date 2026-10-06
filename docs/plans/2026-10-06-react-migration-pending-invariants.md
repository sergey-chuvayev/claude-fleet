# React migration: the 11 pending legacy invariants

The cutover PR (#116) keeps 11 `test.todo` entries in `cutover-pending.test.js`, one per legacy browser test invariant that had no React replacement. This branch closes all of them. Delete each entry from that file against the table below, and mark the matching row of `2026-10-06-react-migration-test-map.md` "replaced by" (or "obsolete").

Paths are under `frontend/src/`. No product code changed: every behavior was already present in React and only lacked a test, except invariant 1, which is obsolete.

| # | Legacy invariant | Outcome | Where |
| --- | --- | --- | --- |
| 1 | `fleet.test.js`: the cost label never rounds a real spend down to nothing | Obsolete | See below |
| 2 | `fleet.test.js`: the status bar reports absence honestly and swaps to the countdown | Replaced | `features/status/UsageStatus.test.tsx` (new): unknown draws nothing, API key hides the cluster, stale is dimmed with "as of", countdown at 90% and above, warn at 75%, hot at 90%, zero still drawn, blocked text with and without a window reading |
| 3 | `fleet.test.js`: nested delegation row status word, inspector extras | Replaced | `features/sessions/SessionList.test.tsx` ("says each delegation row status in a word ..."); `features/agents/DelegationDetail.test.tsx` ("DelegationDetail extras": attempt, token line, runtime-total and "not reported" fallbacks, no cost line even when `costUsd` is present, escaped step input) |
| 4 | `model-picker.test.js`: refreshing a session picker does not reset the launch model | Replaced | `features/launch/models.test.tsx` ("does not reset the launch model when a session picker changes its own model or the list refreshes") |
| 5 | `review.test.js`: free text trimmed, box cleared on success; whitespace-only sends nothing | Replaced | `features/sessions/SessionInspector.test.tsx` ("the Feedback form": sends free text ... trimmed; whitespace-only) |
| 6 | `review.test.js`: a failed send keeps the text and says why | Replaced | same describe: "keeps what was typed and says why when the send fails" |
| 7 | `review.test.js`: picking the CI option fills the box | Replaced | same describe: "fills the box with the CI message when the CI option is picked" (also asserts nothing is sent) |
| 8 | `review.test.js`: no PR means no panel; re-showing the same session is a no-op | Replaced | same describe: "has no panel without a PR link, and a re-shown session neither refetches nor wipes the draft". The review form was not dropped: `public/review.js` and the folded Feedback form are still on `main` at 0.54.0 (0.50.1 folded it, it did not remove it) |
| 9 | `select.test.js`: a scroll closes the menu only when it moves the trigger | Replaced | `components/Select.test.tsx` ("Select closes on scroll only when the trigger moves": unrelated element and the menu itself leave it open, a panel holding the trigger and the page close it) |
| 10 | `teams-board.test.js`: roster shows the configured model, the manager reflects `selectedModel` | Replaced | `features/teams/TeamOverview.test.tsx` ("the roster model": configured model beside an in-flight delegation that reported another; `selectedModel` on the manager only; `auto-jev` with and without a routed model) |
| 11 | `views.test.js`: Progress is its own view, `aria-pressed` follows every switch | Replaced | `app/AppShell.test.tsx` ("makes Progress a view of its own ...": tab order, own pane, no inspector, `fleet:view`, exactly one pressed tab through five switches) |

## Invariant 1: obsolete, with a guard

The legacy `money()` helper was never wired to a surface at 0.54.0. Fleet showed a per-row cost and a "Reported cost" line in the delegation inspector from `b087167` (#8) until 0.21.0 (`7b3e834`, "release Today and remove monetary limits"), which removed every cost display, the Day usage cap, and the monetary controls. After that commit `money()` and `.session-cost` were dead code that nothing rendered, and the only remaining legacy assertion on cost is that the delegation inspector does not show one (invariant 3).

So F27's "current actual session-cost display remains if present" has nothing to carry over: it is not present. Building a `formatMoney` and a cost label now would add a monetary display the product removed on purpose. Two guards keep it that way:

- `features/sessions/SessionList.test.tsx` ("shows no money on any row even when the server reports a cost"): rows carrying `costUsd` render no `$` and no "cost".
- `features/agents/DelegationDetail.test.tsx`: the inspector shows no cost even with `costUsd` on the delegation.

If cost display returns, port `money()` from `public/app.js` with these rules: nothing for zero, null, undefined or negative (unknown is not free), `<$0.01` below one cent, otherwise `$` plus two decimals.
