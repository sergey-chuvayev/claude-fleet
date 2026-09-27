# Opt-in Jev routing

Approved: add Auto · Jev to model selection. Route once and persist the selection
through follow-ups and restarts. Manual choices retain their existing behavior.

Use the Vercel evaluation HTTP API with AI_GATEWAY_API_KEY on the server; no new SDK.
Send bounded original/current user task text, not repository files, tool outputs or
images. Evaluate complexity, ambiguity, risk and whether the task is read-only.
Use a versioned deterministic policy: high-confidence simple read-only tasks may use
Haiku; clear routine tasks use Sonnet; complex/high-risk tasks use Opus 5.5.
Ambiguous, missing-context, invalid or unavailable evaluations retain the preset.
Probability thresholds are conservative starting policy, not calibrated Fleet accuracy.

Persist selected model, signals, policy version, outcome and available Gateway cost.
Display routing status and fallback reason in the session, and disclose the separate
Gateway call in the launch form. Reviewer/worker roles retain configured models.
Honor cancellation before starting Claude. Never send the auto sentinel to the SDK.

Plan: HTTP adapter and pure policy; manager integration and persistence; model picker
and status; tests for policy, malformed data, timeouts, cancellation, manual overrides,
restart persistence and team roles; browser QA. Live evaluation requires a configured
Gateway key. Do not claim measured routing savings without task-level evaluation.

References:
https://vercel.com/docs/ai-gateway/modalities/evaluation
https://docs.typesafe.ai/confidence

Validation: full suite 200/200; 22 affected tests rerun after the final explanation
changes. Browser preview exercised launch, a simulated successful Gateway evaluation,
manual override, return to the saved Auto decision, and a 390px layout. No Gateway key
was configured, so actual Jev response quality, latency and cost are not yet validated.
