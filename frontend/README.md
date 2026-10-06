# Fleet frontend (React + TypeScript)

The browser app that replaces `public/` at cutover. Until then the server still
serves `public/`; this app runs only under Vite or as a build in `dist/`.

## Develop

Run a Fleet server, then Vite against it:

```sh
npm start                      # Fleet on 127.0.0.1:7777 (or any running Fleet)
npm run dev:frontend           # Vite on http://127.0.0.1:5173
```

Other ports: `FLEET_PORT=7790 FLEET_DEV_PORT=5174 npm run dev:frontend`.

To keep your real Fleet out of it, start one with a throwaway home:
`CLAUDE_FLEET_HOME=$(mktemp -d) PORT=7790 node bin/claude-fleet.js start`.

Fleet only accepts an exact `Host` and a matching `Origin`. The dev proxy
(`dev/fleet-proxy.mts`) first applies the same checks to the dev server's own
address, then rewrites both headers for the Fleet target and forwards `/api`
(the `/api/events` stream included), `/theme.css` and `/manifest.webmanifest`.
The server's guards are never relaxed for development.

## Check

```sh
npm run typecheck              # tsc, strict
npm run test:frontend          # Vitest + Testing Library (jsdom)
npm run build:frontend         # dist/ with .vite/manifest.json
```

## Layout

- `src/transport/`: conditional GET (`conditional.ts`), the keyed store
  (`store.ts`), boundary validation (`contracts.ts`), the event stream
  (`events.ts`), keys and invalidation (`resources.ts`), `FleetClient`
  (`client.ts`) and React hooks (`hooks.tsx`).
- `src/app/`: the shell and the `fleet:*` preferences adapter.
- `src/domain/`: ids and pure helpers. `src/components/`: shared primitives
  (the Markdown boundary lives here). `src/features/<area>/`: feature code.
- `src/styles/tokens.css`: design tokens ported from `public/styles.css`.
- `src/test/`: fakes (the server's real `sync.js` behind a fake fetch) and fixtures.
