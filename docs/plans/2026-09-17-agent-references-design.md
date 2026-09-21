# Agent references

Approved scope: @ mentions and drag-and-drop references in a managed agent’s message composer. Slash remains the command picker. References are per-draft removable chips; clicking one navigates to the source. Four references maximum. Arrow keys and Enter/Tab select; Escape dismisses.

At send time, the server resolves managed or terminal session IDs against known sessions, rejects self/missing references, and captures bounded recent user/assistant conversation and activity. Reference data is stored with the message and provided to the SDK as explicitly quoted snapshot context. No request is sent to the source agent. Terminal-held sessions use transcript context rather than stale Fleet messages. The sent message exposes the snapshot for inspection.

Validation: resolver and manager integration tests cover limits, invalid IDs, self-reference, persistence, retry idempotence, and terminal-held sources. Browser checks use mock agents and cover keyboard selection, chip navigation, draft retention, drag-and-drop, delivery, failed sends, and a 390px viewport. Existing image and slash-command behavior remains available.
