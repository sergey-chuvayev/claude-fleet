# Task control prototype

Approved direction: Fleet manages many independent coding tasks, with reusable teams,
a bounded work queue, and an inbox for decisions and completed changes. The first
deliverable is an interactive prototype of queue → concurrent work → blocker → review
→ integration check. It uses synthetic data and never starts an agent or modifies a repo.

The task is the primary object. The board groups work by what the operator can do next
rather than by pipeline stage, so the queue reads as a list of decisions. A detail pane
carries the assignment, team, evidence, and next action. Team presets can be edited for
future assignments; existing assignments keep their snapshot. Concurrency limits control
admission, and lowering one does not interrupt active work. Pausing stops admission while
active tasks finish. Integration verification is separate from agent verification and
goes stale when another change is accepted.

## Shape

The prototype is **additive**: `preview-server.js` serves Fleet's own `public/` frontend
with synthetic read-only sessions and injects `queue.js` + `queue.css`, which add a
**Work queue** tab beside **Sessions**. It deliberately does not import `ManagedSessions`,
the SDK, or Fleet's state store, and answers `GET` only.

Showing the idea inside the real chrome is the point. A standalone mock was built first
and dropped: it answered "what does this page look like" when the question worth
answering is "what does Fleet become".

`state.js` holds the whole simulation as pure transitions with no DOM, which is what
makes it testable from Node; it loads as a browser script and as a CommonJS module.
Buttons advance simulated work explicitly. Local storage retains the demo, and reset
restores the initial five-task scenario.

## Validation

`state.test.js` covers admission limits, paused dispatch, blocker recovery, immutable
team snapshots, repair, stale integration checks, budget exhaustion and persistence,
and runs as part of `npm test`. Browser-verified: rendering, the full review loop,
task creation, team editing, pause and concurrency changes.

No live scheduler, dispatcher or SDK change is part of this prototype.
