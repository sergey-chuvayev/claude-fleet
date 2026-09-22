# Owner + review

Approved direction: offer an opt-in execution mode with a persistent main-thread
owner and one independent reviewer. Preserve existing team behavior and defaults.
The owner investigates, edits, tests, commits, repairs findings, and finishes the
PR in its original session. Only review is delegated.

## State and evidence

Use the existing initiative worktree, team snapshot, usage accounting, task board,
and delegation ledger. An owner-review workflow has exactly two roles, and one
durable request task. The owner registers acceptance criteria once and calls
`ready` after committing a clean worktree. Fleet records the commit, tree, base
commit, and test evidence. The original request remains part of the review mandate.

Each ready implementation consumes one request-wide attempt: the initial review
plus two repair/re-review cycles by default. Creating follow-up tasks cannot reset
this counter. A malformed report, crash, or interruption is a review execution
error rather than a failed implementation; permit one execution retry across the
request. An explicit operator limit adjustment can extend implementation attempts.

Review PASS/FAIL requires evidence. FAIL is for blocking correctness or acceptance
issues; optional improvements do not block. Code changes after submission or PASS
invalidate the evidence. Compare the clean Git tree, keeping the reviewed commit
as an audit reference, so administrative actions or an empty commit do not require
another review. A missing worktree or failed Git check cannot preserve verified
status. Reviewer shell access follows existing permissions; it is not a security
sandbox. Checks detect resulting worktree changes.

## Delivery

The owner opens the PR after review and verifies the branch, head and URL using
commands, without an administrative review delegation. Fleet's task state records
code verification, not a guarantee that a remote PR exists. Keep existing publish
approval behavior. Whole-session SDK reported usage is the shared cap; reporting
delay means it is not an exact billing ceiling.

## Implementation plan

1. Add the preset and mode-aware team validation/compilation; preserve legacy teams.
2. Implement one-request review state and Git snapshot validation using the ledger.
3. Wire readiness, reviewer mandates, tool/stop hooks, resumption and error recovery.
4. Update launch/editor/board copy for owner, request-wide attempts and stale reviews.
5. Add real-Git state tests, mocked-SDK integration tests, configuration/UI tests,
   and run the existing suite. Document opt-in usage and operational limits.

The writing-plans skill is not installed in this workspace; this explicit plan
serves as the implementation checklist. No autonomous live model benchmark is
part of the first change. Cost, elapsed time and substantive review findings can
be compared on representative requests before changing launch defaults.
