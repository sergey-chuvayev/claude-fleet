# Live Work queue

Ship the approved additive Work queue view in the real npm application. Reuse
Fleet's terminal theme, flat list/detail layout and existing conversation controls.
One row is a real managed session/request; external terminal sessions stay in
Sessions. Group by Needs you, Ready to review, Running, Queued and Ready. An idle
single agent is Ready, not independently verified or merged.

The two views share the detail pane and its live conversation, approval forms,
review ledger, composer, stop and close actions. Add task opens the existing launch
form with its single-agent default and optional Owner + review/team presets. Do not
ship simulated integration or acceptance controls as real merge actions.

Expose the existing dispatcher through authenticated enable, pause/resume and
concurrency controls. Save settings in Fleet's session store. Enabling the queue is
explicit and does not change already-running tasks; pausing prevents new admission.
Restart retains settings but reports interrupted queued work instead of silently
starting old requests. Keep queue-disabled behavior for users who have not opted in.

Implementation: add shipped public/work-queue.js, load it from index.html and the
server asset allowlist; integrate the shared selection/render path; persist and
validate queue settings; test state grouping, real launch/selection, queue actions,
HTTP assets and npm packaging. Verify desktop/mobile in a browser against isolated
state with a mocked model transport, then merge and release via the existing workflow.

This continues the approved prototype and the user's explicit instruction to ship
the live tab; no further design approval is needed.
