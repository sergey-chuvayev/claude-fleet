# Agent inspection and efficient small tasks

Continue from 0.5.0 and reuse the existing subagent visibility implementation. Each
initiative delegation is selectable beneath its manager, with assignment, actual model,
status, elapsed time, bounded tool inputs/results, and returned evidence. Usage is based
on reported assistant messages, deduplicated by message ID; unavailable cost is labelled,
never inferred from current pricing. Existing initiative snapshots remain unchanged.

Add a Quick preset with a coordinating manager, developer and one independent verifier.
Keep Software delivery as the thorough option. Preserve all configured verification gates.
Reduce repeated manager context by returning a compact task board by default, with an
explicit inspect action for full delegation evidence. Detailed UI data stays available.

Validate SDK event handling, repeated usage events, bounded payloads, durable task gates,
classic browser script compatibility and inspector rendering with synthetic data.
