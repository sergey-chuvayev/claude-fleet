# Existing MCP connections

Approved scope: inspect, activate and troubleshoot configured MCP servers; no server editor.

Add a Connections modal matching Fleet's existing flat dark interface. Pick an existing
Fleet session or a project directory. Use the active session's SDK transport when present;
otherwise open one bounded, prompt-free diagnostic transport with the same setting sources.
Clearly distinguish project checks from live session tool availability.

Expose sanitized name, scope, status, tools and actionable failure guidance, never server
environment or headers. Controls reconnect and enable/disable through the SDK. Route
Claude.ai authorization to connector settings; local OAuth to Claude Code's /mcp flow.
Use existing same-origin/token checks for every operation that can start a process.
Close diagnostic transports on timeout, project changes and server shutdown. Do not send
model prompts or silently resume blocked tasks.

Implementation: connection service and protected routes; modal and per-session entry;
mock-SDK lifecycle/action/security tests; real prompt-free SDK smoke test; browser QA.

Validation: 194 tests pass, including diagnostic lifecycle, stale transport protection,
credential exclusion, and protected HTTP actions. A real prompt-free SDK check listed
configured servers. A disposable configuration confirmed that SDK disable persists
across diagnostic transports. Browser checks covered reconnect/enable, 390px layout,
Escape and focus return.

Authentication reference: https://code.claude.com/docs/en/agent-sdk/mcp
Local setup and /mcp: https://code.claude.com/docs/en/mcp
