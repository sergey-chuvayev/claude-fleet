# Fleet role resource limits

Approved scope: bound Fleet roles through presets, custom-team persistence, the editor and
SDK query options. Global Claude settings and plugins are outside this change.

Use SDK agent maxTurns and effort fields. Presets use manager 100/high, developer 40/medium,
reviewer 20/medium, QA 20/low and product 15/medium. Reviewer uses Sonnet and QA Haiku.
Custom roles default to 30/medium; users may configure 1–100 turns and supported effort levels.
Existing team snapshots receive missing defaults at compilation without rewriting history.

Select the main model explicitly and strip trailing [1m] model suffixes. This removes an
extended-context opt-in, not tokens already present in a resumed conversation. Keep project
instruction loading. Give bugfix the same durable workflow as delivery with QA verification,
three attempts, a $10 API-equivalent budget and explicit tool allowlists.

Ask delegates for reports within 30 lines and SPLIT_REQUIRED when a mandate cannot finish
within its allowance. Managers must decompose rather than raise caps. Verification still
requires evidence; report text is not mechanically truncated.

Validate presets, legacy compilation, custom configuration round trips and actual query
options with tests. Run the complete existing suite and JavaScript syntax checks.
