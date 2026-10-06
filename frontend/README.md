# Fleet frontend (React + TypeScript)

Fleet's browser app. The server serves its production build from `dist/`; the
legacy `public/` app was removed at cutover (work package 6).

## Production build and serving

- `npm run build:frontend` writes `dist/` with `dist/.vite/manifest.json`. `dist/` is
  ignored by version control; `prepack` builds it, so the npm tarball ships `dist/` and
  not these sources. `start.sh` builds it on every start of a checkout.
- `server.js` (`loadFrontend`) reads the manifest and `index.html` once at startup and
  serves only `/`, `/index.html`, the hashed files the manifest lists (`assets/*`,
  `cache-control: immutable`), `/icons/fleet-192.png` and `/icons/fleet-512.png` (copied
  from `frontend/public/icons/`), plus the generated `/theme.css` and
  `/manifest.webmanifest`. Everything else, including dot segments and encoded
  separators, is a JSON 404.
- `buildId` in `/api/control` is `<version>+<first 12 hex of sha256(manifest)>`.
- A process keeps the asset set it loaded and holds each file in memory once served.
  A rebuild or reinstall under a running server can remove a chunk it never served;
  that request 404s until the server restarts (the page's build check covers it).
- Without a build, `node bin/claude-fleet.js` exits at startup and tells you to run
  `npm run build:frontend`. In a checkout (frontend/ present), it also warns at startup
  when a file under `frontend/src`, `frontend/index.html` or `package-lock.json` is
  newer than `dist/.vite/manifest.json` (`staleBuild` in `server.js`).
- The CSP stays `script-src 'self'` with no `unsafe-eval`; the built `index.html` has a
  single module script and no inline script. `package.test.js` (A29, opt-in with
  `FLEET_PACKAGE_TEST=1`, run in CI) checks all of this against the packed, installed
  release, packed from a temporary copy so the checkout's `dist/` is never rebuilt.
- A new file in `frontend/public/` is served only if the server gets an exact route for
  it; hashed assets need nothing beyond being imported.

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
  (`client.ts`) and React hooks (`hooks.tsx`). Every read goes through the
  client's fetch: conditional routes as `client.resources.*`, plain JSON routes
  as `client.getJson(path, parse)` for one-off reads or
  `client.resources.plain({ key, url, parse })` for polled, shared ones.
- `src/app/`: the shell and the `fleet:*` preferences adapter.
- `src/domain/`: ids and pure helpers. `src/components/`: shared primitives
  (the Markdown boundary lives here). `src/features/<area>/`: feature code.
- `src/styles/tokens.css`: design tokens ported from the legacy `public/styles.css`.
- `src/test/`: fakes (the server's real `sync.js` behind a fake fetch) and fixtures.

## Plugging a feature into the shell

The shell (`app/AppShell.tsx`) draws everything from two registries. A feature
replaces its own placeholder file; it does not edit the shell.

- **Views** (`app/views.tsx`): each tab is a `Pane` and, for split views, a
  `Detail` rendered in `aside#detail`, with the divider between them. The shell
  owns the containers (legacy ids and classes) and the divider. Placeholders:
  `features/sessions/SessionsPane`, `features/inspector/SessionDetail`,
  `features/today/TodayPane` + `DayConsole`, `features/projects/ProjectsPane` +
  `ProjectConsole`, `features/progress/ProgressPage`, `features/worktrees/WorktreesPage`.
- **Modals** (`app/modals.tsx`): modal kind to component, receiving
  `{ modal, onClose }`. Render a `<Dialog id={MODAL_IDS[kind]}>`. Placeholders:
  `features/launch/LaunchDialog`, `features/search/SearchDialog`,
  `features/connections/ConnectionsDialog`, `features/settings/SettingsDialog`,
  `features/worktrees/ClearWorktreeDialog`. Status bar and top bar slots:
  `features/status/UsageStatus`, `features/status/UpdateStatus`.
- **Background** (`app/background.tsx`): controllers that render nothing and run
  on every view, mounted once by the shell (`SoundController`, Today's
  `ReportBack`). A failing one is logged and dropped.
- **State** (`app/state.ts`, `app/AppStore.tsx`): `useView()`, `useSelection(slot)`,
  `useModal()`, `useActions()` (`navigate`, `select(selection, { reveal })`,
  `openModal`, `closeModal`, `setInspector`), `useReconcileSelection(slot, rows)`
  from the component that owns the visible rows, `usePreference(key)`,
  `useInspector()`. A selection is a tagged union (`managed`, `external`,
  `delegation`, `day-thread`, `project-manager`); `selectionKey()` equals
  `sessionKey(row)` for session rows.
- **Primitives** (`components/`): `Dialog`/`DialogHead`/`DialogFoot`, `Select`,
  `SplitPane`/`PanelSplitter`, `Disclosure`/`Fold`, `useToast`/`useAnnounce`,
  `CopyButton`/`copyToClipboard`, `Icon`, `Avatar`, `PixelRun`, `EmptyState`,
  `RelativeTime`/`Elapsed`/`useNow`, `useSeen`, and the legacy `FleetUI` page
  blocks in `components/ui.tsx` (`PageHead`, `Stat`, `Bar`, `Ring`, `Section`,
  `Pill`, `Callout`, `Group`, `List`, `Row`, `Log`, `LinkChips`). Formatters:
  `domain/format.ts`; link labels: `domain/links.ts`.
- **Styles**: `styles/shell.css` and `styles/components.css` are the legacy rules
  whose selectors name only shell or primitive classes, ported in legacy order.
  A feature ports its own rules from the legacy `public/styles.css` into a stylesheet it
  imports from its component (as `styles/conversation.css` is); those load after
  the shell's, so a legacy rule that sat earlier than a shell rule of equal
  specificity needs a look.
- `test/shell.tsx` renders anything inside the real providers with an in-memory
  `localStorage`; `e2e/compare/shell/capture.mjs` takes side-by-side screenshots
  against the legacy baseline.
