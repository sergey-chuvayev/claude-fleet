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
  (`client.ts`) and React hooks (`hooks.tsx`). Every read goes through the
  client's fetch: conditional routes as `client.resources.*`, plain JSON routes
  as `client.getJson(path, parse)` for one-off reads or
  `client.resources.plain({ key, url, parse })` for polled, shared ones.
- `src/app/`: the shell and the `fleet:*` preferences adapter.
- `src/domain/`: ids and pure helpers. `src/components/`: shared primitives
  (the Markdown boundary lives here). `src/features/<area>/`: feature code.
- `src/styles/tokens.css`: design tokens ported from `public/styles.css`.
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
  A feature ports its own rules from `public/styles.css` into a stylesheet it
  imports from its component (as `styles/conversation.css` is); those load after
  the shell's, so a legacy rule that sat earlier than a shell rule of equal
  specificity needs a look.
- `test/shell.tsx` renders anything inside the real providers with an in-memory
  `localStorage`; `e2e/compare/shell/capture.mjs` takes side-by-side screenshots
  against the legacy baseline.
