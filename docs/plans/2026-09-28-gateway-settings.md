# AI Gateway settings

Approved scope: activate Jev routing with a saved Vercel AI Gateway key through Fleet Settings, including Dock launches.

The header opens an AI Gateway modal with a masked input, Save key, Test connection and Remove saved key. Metadata reports saved, environment or unconfigured status; no endpoint returns a credential. Saving applies to new Auto sessions immediately. Existing routing decisions remain pinned.

Store the key outside session data in gateway-key.json within Fleet's state directory, using an atomic owner-only file write. Saved keys override AI_GATEWAY_API_KEY; removal restores the environment fallback. Mutations and test calls use the existing same-origin control token. Tests send only a synthetic sample to the fixed Gateway evaluate endpoint, with bounded timeout and sanitized errors. The interface explains separate billing.

Verification: storage persistence and permissions, failed writes, credential redaction, HTTP authorization, dynamic session lookup, regression suite, desktop/mobile browser interactions with a synthetic key. Live Gateway authentication requires the user's key and is not part of automated verification.
