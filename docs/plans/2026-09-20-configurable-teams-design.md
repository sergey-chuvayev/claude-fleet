# Configurable teams and durable initiative tasks

Approved direction: editable role/team templates with a useful software-delivery preset.
The manager remains the sole operator conversation. Roles define instructions, models,
and tools; workflow rules define independent verification. Initiatives snapshot templates.

Implementation:
1. Validate and atomically persist custom templates; preserve built-in bugfix compatibility.
2. Add a software team with product, developer, reviewer, and QA roles and bounded runs.
3. Persist a task ledger alongside sessions. Manager tools create tasks with acceptance
   criteria/dependencies. Delegations are bound to tasks and actual returned reports.
4. Enforce dependencies, independent gate roles, bounded repair attempts, and evidence
   before displaying a task as verified. Interrupted work remains resumable, never green.
5. Add a template editor in launch and an initiative team/task/handoff inspector.
6. Test storage, invalid configurations, SDK wiring, verification and interruption;
   exercise the browser with synthetic data. Keep production server untouched.

One writer at a time per initiative for the initial implementation: all agents share the
initiative worktree, so parallel editing/review could invalidate evidence. Plans may be
flexible, but dependencies and review gates are application-owned. Reports are agent
claims with recorded provenance, not a guarantee of correctness. No cross-provider model
adapter in this version. Built-in SDK subagent lifecycle is retained.

## Validation

- 109 Node tests pass, including authenticated HTTP routes, store reload, immutable
  snapshots, SDK hook wiring, dependencies, repair loops, evidence and limits.
- Actual Claude runtime smoke test: manager → product → QA → verified ($0.0415).
- Actual coding test: manager → developer → reviewer → QA → verified ($0.0844).
  Independently checked git diff (only math.js changed) and ran unchanged math.test.js.
- The first live test caught the runtime's indented `[Subagent hand-back]` envelope.
  Capture raw subagent output, with a narrow framing fallback and regression coverage.
- Browser: saved custom template, launched synthetic initiative, adjusted limits,
  inspected QA handoffs, and checked desktop / 390px mobile for overflow and usable controls.
- Runtime work remains sequential per initiative; multi-provider execution and automatic
  publishing are outside this version. SDK budget accounting is based on reported usage.
