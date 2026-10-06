# Fleet React + TypeScript migration design

Date: 2026-10-06. Status: draft implementation specification for review, revised 2026-10-06 to separate backend bug fixes from the migration. No migration has been implemented by this document.

Document location: `docs/plans/2026-10-06-react-migration-design.md` on `docs/react-migration-plan`, isolated worktree `/private/tmp/fleet-react-plan`. The main application checkout is unchanged.

Contents: [Scope](#1-decision-and-scope) · [Baseline](#2-evidence-baseline-and-limitations) · [Feature inventory](#3-complete-product-inventory-and-ownership) · [Architecture](#4-target-frontend-architecture) · [HTTP contracts](#5-existing-http-contract-complete-route-matrix) · [Entities](#6-entities-identity-and-dto-definitions) · [Live updates](#7-transport-cache-invalidation-and-recovery) · [Phase 0 fixes](#8-phase-0-backend-fixes-before-the-migration) · [Design](#9-design-fidelity-and-accessibility) · [Build and release](#10-build-packaging-development-and-release) · [Acceptance tests](#11-test-strategy-and-acceptance-matrix) · [Work packages](#12-implementation-work-packages-and-completion-gates) · [Remaining evidence](#13-review-decisions-and-remaining-evidence).

## 1. Decision and scope

Replace Fleet's entire browser application with React and TypeScript in one production cutover. Keep the Node.js server, agent runtimes, CLI, on-disk conversations, projects, archive, service integration, and local-only security model. Preserve Fleet's minimalist dark interface and every working user flow.

The work happens in two phases:

- **Phase 0: backend fixes on the current UI.** The verified defects B01 to B08 (section 8) are bugs and do not depend on React. Each ships first as its own small PR with a regression test, against the existing frontend. Section 8 describes each one.
- **Phase 1: the migration.** A frontend-only swap to React and TypeScript, plus a small set of backend additions the new client needs (section 7: build/instance identity and typed error codes). The migration release changes no storage format and no domain behavior.

Keeping the phases separate means known bugs get fixed now, and the migration's risk is mostly about visuals and behavior, which fixtures and browser journeys cover well.

“One cutover” means the shipped HTML boots one React application, every production view belongs to that application, and none of the old `window.Fleet*` controllers mount alongside it. Implementation can be developed and tested in dependency-ordered work packages in an isolated branch. These are development milestones, not progressive production rollouts. Release only when the complete acceptance matrix passes. Rollback replaces the whole release with the previous compatible package.

The alternatives considered are a React wrapper around the IIFEs, gradual per-tab replacement, and a complete replacement. The wrapper retains DOM ownership conflicts and the mutable global protocol. Per-tab replacement reduces initial development scope but prolongs those conflicts and violates the approved cutover requirement. A complete replacement is selected; its larger release risk is addressed with fixtures, contract tests, full browser journeys, and package smoke tests.

This is not a visual redesign, a backend rewrite, an Electron migration, a new remote service, or an expansion of Codex into features currently implemented through Claude. No additional general-purpose global state library, full application framework, router, CSS utility framework, or component library is necessary for the initial implementation. Server state sits behind a thin cache over the existing sync protocol (section 4 picks between TanStack Query and a small external store); local interaction state stays in React reducers.

This is also not a rework of backend persistence. A durable idempotency ledger, per-resource revisions, async serialized writes and summary caching are left out of scope. Each needs its own proposal backed by profiling evidence.

## 2. Evidence, baseline, and limitations

**Work package 1 deliverables (2026-10-06):** the inventory and route matrix below are reconciled to `ee63d5e`; API fixtures live in `frontend/src/test/fixtures/` (regenerate with `node frontend/src/test/fixtures/capture.js`); the visual baseline is in `frontend/e2e/baseline/screens/`; the old-to-new test mapping is `docs/plans/2026-10-06-react-migration-test-map.md`.

**Update 2026-10-06 (later):** Phase 0 is done. B01 to B08 merged to `main` as #100, #101, #102 and #99 (`484a372`). The pending launch modal and Codex work described below had already landed on `main` (mainly #82), so the migration baseline is now `origin/main` at `484a372` (package 0.54.0), not the dirty 0.46.1 tree. Re-capture fixtures, screenshots and the feature inventory against that commit; features added between 0.46.1 and 0.54.0 (for example sounds, Worktrees, task comments, Today report-back) must be added to section 3 before work package 1 closes.

The source baseline is the working tree at `/Users/sergeychuvayev/projects/claude-fleet`, inspected on 2026-10-06, package version `0.46.1`. It includes uncommitted changes in `README.md`, `codex.js`, `codex.test.js`, `draft.test.js`, `public/app.js`, `public/control.js`, `public/index.html`, and `public/styles.css`. Those changes are part of the behavior to preserve, especially the launch modal and Codex availability recovery. The isolated documentation worktree starts from commit `3f5d300`; that commit alone does not represent this full working-tree baseline. First step before any migration work: the owner commits or merges the pending changes (launch modal, Codex availability recovery) to `main`, so the migration branch starts from a real SHA that contains the behavior it must preserve. Do not reset, stash, overwrite, or silently omit those changes.

The prior review reported 291 passing tests. This document does not claim a new test run. Browser preview was blocked with `ERR_BLOCKED_BY_CLIENT`; there is no newly verified browser or performance baseline. All performance budgets below are proposed acceptance targets, not measured improvements. Before implementation, obtain actual desktop/mobile screenshots and repeatable traces from the intended source build using synthetic state and an isolated Fleet home.

Primary source map:

| Area | Current source of truth |
| --- | --- |
| HTML, look, responsive layout | `public/index.html`, `public/styles.css`, `.impeccable.md`, `docs/plans/2026-10-01-minimal-dark-design.md`, pending `docs/plans/2026-10-05-launch-modal-design.md` |
| Shell, list, inspector, modals, splitters | `public/app.js` |
| Launch, conversation, drafts, attachments, references, commands, updates | `public/control.js`, `public/blocks.js` |
| Today, projects, progress | `public/day.js`, `public/projects.js`, `public/progress.js`, `public/views.js` |
| Teams, search, connections, settings, dropdowns | `public/teams.js`, `public/ask.js`, `public/connections.js`, `public/settings.js`, `public/select.js`, `public/ui.js` |
| Transport and routing | `server.js`, `sync.js`, `public/sync.js` |
| Session lifecycle and identity | `managed.js`, `fleet.js`, `history.js`, `codex.js`, `dispatch.js`, `references.js`, `catalog.js` |
| Domain rules and persistence | `day.js`, `day-agent.js`, `projects.js`, `project-agent.js`, `team-store.js`, `teams.js`, `tasks.js`, `owner-review.js`, `archive.js`, `worktree.js` |
| Settings and operation | `settings.js`, `routing.js`, `connections.js`, `usage.js`, `progress.js`, `service.js`, `update.js`, `theme.js`, `open.js`, `paths.js`, `bin/`, `package.json`, `.github/workflows/` |

The current browser is not uniformly naive: `public/blocks.js` already reuses individual message elements, and sync already supports ETags and item fingerprints. Preserve those benefits. The main architectural problem is distributed ownership: full panel `innerHTML` replacement, DOM-derived form state, manual restoration of focus/scroll/disclosures, script-order globals, independent fetch timers, and cross-module event handlers.

## 3. Complete product inventory and ownership

Inventory identifiers are release requirements and map to acceptance tests in section 11. Revision 2026-10-06 (work package 1): reconciled against `origin/react-migration` at `ee63d5e` (package 0.54.0). F01 to F28 are amended in place for changes since 0.46.1; F29 to F35 are new. “Preserve” means preserve useful behavior and semantics, not a known defect or a misleading label.

| ID | Surface and behavior that must survive | React owner |
| --- | --- | --- |
| F01 | Top bar, Fleet identity/version, Today/Projects/Sessions/Progress/Worktrees navigation, refresh, New agent, Search, Connections, Settings, update status, connection/error banner (clears only after a write lands, not after a read, since 0.50), account status bar; a fifth view tab, Worktrees (F29) | `app/AppShell`, `app/Navigation`, `features/status` |
| F02 | Session list across Claude and Codex, managed and external; busy/idle/stale/offline counts; foreground/background/archived separation; All time/Today/rolling seven-day filters; meaningful empty states; selected-row fallback and mobile reveal | `features/sessions/SessionList`, selectors |
| F03 | Stable row identity, titles and renamed title precedence, engine identity, deterministic pixel avatars, unseen activity, cwd/branch/model/context metadata, task/queue status, turn steps/current action/errors/duration, background attribution and linked work badges (links render as labelled chips such as `TECH-5163`, `repo#123`, Slack, Notion through a shared `linkLabel`/`links` helper, 0.51); session rows are not draggable, so the first click opens the row (0.52.2) | `SessionRow`, `TurnSummary`, `SessionIdentity` |
| F04 | Session inspector: latest request/response for external sessions, context thresholds, activity, message count, GitHub/Linear references, cwd/branch/permissions/control/session identity, transcript truncation disclosure, copy resume command, and the review strip (F30) for agent sessions that mention GitHub PRs | `features/inspector/SessionInspector` |
| F05 | Nested delegation rows, per-parent remembered fold, selected older delegation retained beyond recent 20 rows, fold selects parent, assignment/steps/input/output/report/duration/model/usage, read-only detail without composer | `features/agents/DelegationList`, `DelegationInspector` |
| F06 | Launch modal from any view and Cmd/Ctrl+N: draft survives dismissal, discard clears it, opening does not change selected conversation, first launch only creates server state, last cwd, model/default mode, team/single/owner-review choice, validation, rate-limit notice, retry with same request ID, success selects launched session. Since 0.46.3 the launch form is a modal (`#launch-backdrop`, `modal-launch`), not a draft row: no "New agent" row in the list, a close button plus Discard, Esc closes without discarding, the opening prompt is a labelled textarea with "Enter to launch, Shift+Enter for a new line", the default single-agent model under "Fleet default" is Opus 5.5 (0.52.0), and the server's default approval mode does not overwrite a draft in progress | `features/launch/LaunchDialog`, launch reducer |
| F07 | Claude and Codex always visible in launch choice; Codex setup guidance ("Codex was not found. Install the Codex CLI and sign in, then reopen this dialog to check again.") and refreshed availability on reopen; launching with unavailable Codex shows an inline error and sends no request; Codex hides the team field, retitles the dialog "What should Codex work on?" and hides the Auto/Jev model note; Codex accepts PNG, JPEG and WebP images only and refuses GIF before acceptance (#99); engine-specific model/team availability and sandbox explanation; desktop executable discovery retained server-side | launch capability adapter |
| F08 | Monitor live external Claude/Codex transcripts, historical/offline continuation, imported previous messages, live Claude copy/fork, refusal to resume live Codex, correct engine resume command; externally held managed session displays holder and waits to send | `features/conversation/ExternalConversation`, lifecycle actions |
| F09 | Managed conversation, engine labels, timestamps, streaming response, safe Markdown, highlighted fenced code, text fallback, tool cards and diffs, todo lists, Task/Agent delegation mandate/report, copy/collapse/truncation/error/event blocks, follow-tail and deliberate reading position; the last operator message above the fold stays pinned at the top of the log as a compact "YOU" bubble that scrolls back to it on click, one pin per conversation, reduced-motion aware (0.47.0) | `Conversation`, `MessageList`, `MessageBlock`, `Markdown` |
| F10 | Per-session composer text, selection and IME, Enter send/Shift+Enter newline, resize/autosize, pending/failed send, queued follow-ups, draft isolation when switching, slash commands/skills, `@` session references, reference chips and navigation (dragging a session row onto the composer was removed in 0.52.2; the drop zone now accepts files only) | `features/composer`, draft store |
| F11 | Pasted/dropped images, thumbnails, remove image, image-only follow-up, validation (six images, eight MiB each; aggregate request limit also applies), private server attachment URLs, references resolved at send time and self-reference excluded | composer attachment/reference modules |
| F12 | Rename supported sessions; model change applies next turn; mode change; project assignment/removal; current activity; stop; two-click close; errors and held/queued messages; use server lifecycle rather than inferring completion from empty output | `ConversationHeader`, session mutations |
| F13 | Pending approvals with tool input/reason/role; allow once/deny; AskUserQuestion single/multi choice plus free text; keyed answer drafts; stale approval error and refresh; no automatic approval after restart | `features/approvals` |
| F14 | Team catalog and editor, built-in copy/custom update, role add/remove/rename, manager/verifier restrictions, models/instructions/tools/effort/turn limits, repair-attempt limits, owner+review mode; active team snapshot remains immutable | `features/teams/TeamEditor` |
| F15 | Initiative/task overview, tasks and verification state, handoff mandate/report disclosures, actual delegation model precedence, owner-review evidence/repair outcomes, remembered overview height; no monetary budget controls reintroduced | `TeamOverview`, `TaskCard`, `Handoff` |
| F16 | Today start with optional note, a toast, soft sound and optional macOS notification when an agent launched from Today reports back (F32), one Day per local date, unfinished carryover, previous/open item threads, source badges/links (labelled chips via the shared `linkLabel`), item context rendered as Markdown and folded as "Hand-off from the project" or "Context" when over 400 characters or carrying headings (0.51), must/should/could priorities, me/draft/agent/ask modes, estimates and calendar capacity | `features/today/TodayPage`, `DayBoard` |
| F17 | Today triage Today/Later/Drop and Take all Must; manual add title/context/links; active/later/done sections, mark done constraints, item details/log/project tag, live worker status and launched-session navigation (the launch chip is titled with the session name, truncated at 40 characters, 0.52.3), manual sweep and scheduled-check information | `DayItem`, `TriageList`, board actions |
| F18 | Today needs: approve exact/editable draft, reject, choice, information, reply without approval; launch brief with editable cwd/team; per-item conversation; "Waiting on you" cards end in a footer with the launched-session chip, a Thread chip that opens the item's conversation, the item's links and a button that jumps to the item's full entry on the board (0.52.3); an agent's report need offers Done or Needs more work, and Done closes the item even with other questions open (0.53.1); Day agent/scout tabs, latest scout grouped by role and prior runs; board tool calls grouped into readable events | `DayNeed`, `DayThreadTabs`, `ScoutInspector` |
| F19 | Projects create from title/optional note; manager setup and conversation; persisted project selection; deadline/working days/progress; deliverable state/note; plan on Today/open existing Day item; member sessions; brief/sections/log/links; copy Markdown path; two-click archive; hand-edited Markdown reflected; creating a project whose manager cannot start (all agents busy) keeps the project and toasts "Project created. Its manager did not start: <reason>" instead of latching the storage banner (B01); every task row opens to its brief, source chips and a comment box (F31) and shows up to three link chips; nothing reaches Today unless the operator sends it (0.46.4); the project manager edits Notion, Linear and GitHub only with per-change approval (F33); stable deliverable ids and a 30 active-project cap that ignores archived projects (B04, B06) | `features/projects` |
| F20 | Progress full-width weekly shipped/stalled/ran report, totals and bounded rows, linked PRs, refresh/load/error/empty states; “shipped” means marked done on Day, not a verified GitHub merge | `features/progress` |
| F21 | Search modal and Cmd/Ctrl+K, suggestions, question/model, immediate keyword hits then asynchronous answer, cited result order, snippets/disclosures/relevance, live session navigation or copy resume, no-hit/error/stopped/replaced search | `features/search` |
| F22 | Connections modal from toolbar or managed session; project/session selection, check/search/status/tool count/details; reconnect/enable/disable; authentication/default-browser flow, polling/expiry/identity conflict recovery, private config/error redaction | `features/connections` |
| F23 | Settings queue enabled/limit 1 to 8/pause/resume and authoritative running/waiting counts; disable refusal while tasks wait; default approval mode affects future launches; service startup support/handover; gateway save/test/remove/source and credential clearing; Notifications section: "Desktop notification when an agent reports back" (browser permission, stored per browser under `fleet.notify`, blocked/unsupported messages) and "Play sounds" with three sample buttons (F32) | `features/settings` |
| F24 | Session archive/restore, bulk offline archive and restore all, age rule, restored exemption, archived searchability/resumability; distinction from managed close and project archive | `features/archive` |
| F25 | Update available/current/installing/restarting/error/check-out-not-installable states; recovery to new server; same behavior in browser/app/launchd launches; manifest/icons/theme fallback, no external font/CDN dependency | status/update controller and build shell |
| F26 | Resizable main split per view, Today split, composer and team overview; keyboard adjustment/double-click reset/clamping; inspector remembered visibility; responsive desktop/tablet/mobile; reduced motion, keyboard shortcuts, focus trap/return, accessible dropdowns/native touch selection, clipboard fallback | `components`, `app/preferences` |
| F27 | Account usage/binding window/reset/countdown/stale/rejection, plan context distinct from session context and cost, missing usage remains unknown; the gauge reads Claude's `unifiedWindows` as well as the older shape (0.46.2); current actual session-cost display remains if present, without inventing spending caps | `features/status/UsageStatus` |
| F28 | SSE invalidation, conditional GET, known-item reconstruction, changed-only rendering, visibility refresh, reconnect/offline retention, out-of-order suppression, storage error display and stop escape hatch, deterministic cleanup; the `fleet-snapshot` document event feeds the sound observer (F32), and `/api/pr-status` and `/api/worktrees` are polled by their own views (F30, F29) | `transport`, query hooks |
| F29 | Worktrees tab (0.49.0), last in the tab row: every checkout a session worked in with branch, repo, short path and pills (Main checkout, Merged, No commits yet, Not merged into trunk, PR #n open/merged/closed with link, N uncommitted, N unpushed, Session running, Locked); filter select (All checkouts, Safe to clear, Merged, Open pull request, Uncommitted or unpushed) remembered in `fleet:worktrees-filter`; stat strip (Checkouts, Safe to clear, Open PR, Needs care); open rows list the "Kept because" blockers and the sessions that used the folder and stay open across redraws; "Clear..." only on clearable rows opens a confirmation listing what is removed and left alone, and the server re-derives the verdict from git and refuses on change; Refresh button, 15-second freshness, outside-checkout note, empty/error/loading states; the tab hides the inspector toggle | `features/worktrees/WorktreesPage`, `ClearWorktreeDialog` |
| F30 | Review loop strip in the inspector (0.48.0, slimmed 0.50.1 and 0.50.2): for agent sessions only (not Day, project manager or item threads) the last three GitHub PR links get one line each with link, state pill (Open, Merged, Closed, Draft) and CI pill (passing, failing, running, none) with failing check names in the tooltip; gh problems are explained (not installed, not signed in, rate limited, not found, invalid); managed sessions get a Feedback toggle opening a form with a preset select (Write your own, "CI failed, fix it") and a one-click CI-fix button; feedback posts through the normal message route and queues like a typed message; the typed draft is kept per session while another is open; 30-second poll while visible | `features/inspector/ReviewStrip`, PR status query |
| F31 | Project task detail and comment (0.51.0, 0.53.0): each deliverable row opens to its brief (Markdown), Sources chips and a comment textarea (Enter sends, Shift+Enter newline) whose Send posts `/api/projects/:id/comment`; toast "Comment sent. The project manager is updating the task."; an empty comment toasts "Write your comment first."; the comment is also logged in the project and on the task's Today item; the first question to a project with no brief, tasks or manager becomes its setup note; open task rows persist across refresh | `features/projects/TaskRow`, `TaskComment` |
| F32 | Sounds and report-back (0.50.0, 0.54.0): three synthesized soft tones (done, ask, report), no assets; on by default (`fleet.sounds`), one sound per update with 1.2-second spacing, the first snapshot only sets the baseline, silent until the first pointer interaction; done plays when a managed agent goes from active to idle (not Day, project or thread), ask when a session reaches approval or a Day's waiting count grows, report when an agent launched from Today reports back; report-back also raises a toast "title: question" (220 characters) and an optional macOS notification whose click focuses the window and shows the Day item; server side, `reportToDay` logs the agent's last words and any PR links on the item and asks Done or Needs more work | `features/sound/SoundController`, `features/today/ReportBack` |
| F33 | Project manager document edits (0.51.0): the manager's Notion, Linear and GitHub write tools are allowed per call after operator approval, only in a turn the operator started, never for messaging people (Slack, email, comments are denied); the gate label reads "Changes need your approval" with an explanatory tooltip; each approved change is logged in the project; background runs may not write outside Fleet | `features/approvals`, `features/projects/ManagerGate` |
| F34 | Task to Today hand-off (0.51.0, 0.46.4): "Plan on Today" hands the Day a bounded hand-off (task brief, note, task links, project story, file path); duplicate detection is by project plus deliverable (B05), so equal titles in different projects stay separate; a report-back closes the matching project item and logs it in the project | `features/projects`, `features/today` |
| F35 | Visible effects of Phase 0 and defaults since 0.46.1 with no surface of their own: "Fleet default" names Opus 5.5; a refused send leaves no request ID or image files so a retry is admitted (B02); Codex receives text plus image file arguments (B03); Open in Fleet from search goes through the published filter and select actions (B08); approval classification sees through wrappers (B07) | server behavior, `features/launch`, `features/search` |

Current scope limitations are explicit: transcript search is Claude-oriented and does not currently search Codex history; Connections controls Claude MCP transports; teams, Day, threads, and project managers use Claude. Present engine capability limitations clearly. Extending those capabilities is not required to ship this migration. The API supports project unarchive/list-including-archived and initiative limits even where current UI does not expose a dedicated control; retain and test the routes without inventing a new page.

## 4. Target frontend architecture

Use React function components, TypeScript strict mode, ES modules, and Vite for development and production builds. Keep backend CommonJS during this work. Pin selected stable dependency versions and commit the lockfile during implementation; this plan intentionally does not guess future version numbers. Use existing `marked`, `DOMPurify`, and `highlight.js` (core plus an explicit list of common languages, not the full build) behind one safe rendering boundary. Add React/ReactDOM, TypeScript and types, Vite's React integration, and Vitest/Testing Library plus Playwright for browser acceptance.

Server-state cache: run a short spike before choosing. The custom conditional-fetch adapter (ETags, fingerprints, packed-array reconstruction, section 7) does the hard part either way. Option A is TanStack Query on top of the adapter, for deduping, invalidation and retry. Option B is a small typed store over the existing `sync.js` protocol, read through `useSyncExternalStore`, with per-key in-flight dedupe and an invalidation map. Pick B unless the spike shows TanStack removes meaningful code. The rest of this document says "query cache" for whichever is chosen. Check Node 22 compatibility before locking versions.

Recommended layout:

```text
frontend/
  index.html
  src/
    main.tsx
    app/               AppShell, navigation reducer, providers, preferences
    transport/         http, contracts, conditional cache, events, recovery
    domain/            ids, selectors, formatting, engine capabilities
    components/        Dialog, Select, SplitPane, Markdown, disclosure, toast
    features/
      sessions/ inspector/ agents/ launch/ conversation/ composer/
      approvals/ teams/ today/ projects/ progress/ search/
      connections/ settings/ archive/ status/
    styles/            tokens, shell, components, feature styles
    test/              fixtures, render helpers, transport/clock doubles
  public/              icons (copied as-is by Vite)
  e2e/
dist/                  generated production index.html, hashed assets, manifest
```

Build to `dist/` with Vite's manifest enabled. The legacy `public/` directory is deleted at cutover, so no build cleanup can touch hand-maintained files. Icons live in `frontend/public/` and Vite copies them unchanged; `theme.css` and `manifest.webmanifest` stay server-generated routes. `server.js` serves from `dist/` instead of `public/`. A generated static-asset manifest lets Node serve exact build files without becoming an unrestricted filesystem server. No history router is needed: the current four views and modal state can use an explicit app reducer, preserving `fleet:view`. Avoid URL changes in the initial migration unless independently approved.

### Ownership and state

There are three state categories, with one owner each:

1. **Server state:** the query cache contains validated session snapshots/details, external histories, projects, teams, model catalogs, progress, search jobs, connections, settings and update/service responses. Query keys include the entity identity and server generation. Do not copy these into component reducers or a second normalized global store. Stable entity selectors may return cached references keyed by IDs/fingerprints.
2. **User interaction state:** a small typed app reducer owns view and selection, modal kind, inspector intent, selected project/thread/delegation; feature reducers own forms, dropdown state and disclosures. The composer draft store is keyed by engine-qualified session identity and holds text, attachments, reference IDs, revision, request ID and submission snapshot. Server updates never replace dirty form values.
3. **Preferences:** a guarded storage adapter reads existing keys once, validates/clamps them, and writes only on deliberate user changes. It tolerates unavailable storage and corrupted values. Credentials and control token never enter preferences.

Retain `fleet:view`, `fleet:project`, `fleet:launch-cwd`, `fleet:seen` (bounded 200), `fleet:children-collapsed` (bounded 200), `fleet:minimal-split`, `fleet:today-split`, `fleet:minimal-composer-height`, `fleet:overview-height`, and `fleet:minimal-details-open`. Import current semantics; invalid/removed view values fall back to Sessions. Preserve today's date in local time, rolling-week filtering, and the distinct Progress reporting period. Do not quietly change them to UTC or calendar week.

Drafts currently survive in-session switching/dismissal, not browser reload. Preserve that minimum. For a controlled update/restart, add bounded session-storage recovery of text/reference IDs and launch form state, excluding gateway secrets and raw image data; disclose that image attachments must be reattached after a full reload. A non-reloading token refresh must retain every attachment. Arbitrary persistent draft storage and cross-tab synchronization are outside initial scope.

Every selection is a tagged union: managed session, external engine/session, delegation with parent, Day item thread, or project manager. PID is metadata, not normal identity. When a selected item disappears, apply a deterministic nearby/parent fallback and explain closure where useful. Responses for old selections may populate their own cache but cannot change the current selection, error, or form.

The application root owns one event stream, one visibility listener, and one recovery controller. Feature hooks subscribe through query keys, never through `window.Fleet*`, custom document events, DOM mutations, or another component's refs. Runtime timers unsubscribe on unmount; StrictMode double mounting must not create duplicate subscriptions or mutations.

### Rendering and interaction

Use stable keys from server entity IDs: row IDs, message IDs, approval IDs, delegation/step IDs, Day item/need IDs, project IDs and corrected deliverable IDs. Content fingerprints are change indicators, not component keys: a streaming message must keep the same React key while its text changes. Preserve object references for unchanged fingerprinted items.

Render the shell and inactive-page boundaries independently. Streaming one message should update that message and relevant status, not every session row, dropdown, editor and Day board. Memoize expensive Markdown/highlight output by content and rendering mode; stream plain/safely parsed text at a bounded cadence and highlight final/visible code. Escape all plain tool input and render only sanitized Markdown through the HTML boundary. Preserve existing prohibited tags/attributes, external link `noopener noreferrer`, and CSP behavior.

Start with the bounded message window (currently 200), not unconditional transcript virtualization. Add row/window virtualization only if measured fixture budgets require it and keyboard/read-position tests pass. Long tool output stays collapsed and bounded. Keep a read anchor `{messageId, offset}` while user is above the tail; append/resize follows the tail only when already near the bottom. Switching sessions restores that session's position. Browser native selection, open disclosures, text composition and form caret must survive unrelated updates.

Dialogs have a single active modal layer, focus trap, Escape/outside-click semantics, inert background and restoration to the opener. Team editing is a mode within the launch dialog, not nested modal layering. Selects are controlled React components with typeahead, arrows, Home/End, Enter/Escape and disabled-option handling; use native touch selection where current behavior does. Remove select DOM monkey-patching and MutationObservers. Reuse current visual tokens, spacing, widths, typography, icon language, flat pane organization and charcoal surfaces.

## 5. Existing HTTP contract: complete route matrix

This section records current routes and return envelopes. “200” is the current success status, not a proposed REST redesign. All POST bodies are JSON objects and require `Content-Type: application/json` and `X-Fleet-Token` from `/api/control`. GET routes do not require that token. Generic guards described after the matrices apply to every row. Domain DTOs follow in section 6.

### GET routes

| Path | Input | Current successful response | Domain failure / notes |
| --- | --- | --- | --- |
| `/api/control` | none | 200 `{token,version,apiVersion,instanceId,buildId,capabilities,codex,supportsSessionReferences,defaultCwd,maxConcurrent,defaultApprovalMode,queue,storageError,searchDays,theme}` | `codex={available,model?}`; `theme={name,source}`; `instanceId` is new per server process, `buildId` identifies the build, `capabilities` lists engines and features (merged in #103) |
| `/api/sessions` | conditional headers | 200 `SessionSnapshot`; 304 no body | Packs `sessions`; ETag excludes top-level `generatedAt` |
| `/api/managed/:id` | managed ID, conditional headers | 200 `{session:ManagedDetail}`; 304 | 404 absent session; packs `session.messages` and `session.subagents`; currently raw cloned session plus holder |
| `/api/managed/:id/commands` | managed ID | 200 `{commands:Command[]}` | 404 absent session; cwd-specific catalog |
| `/api/sessions/history?sessionId=…` | transcript ID, conditional headers | 200 `History`; 304 | 404 if not a discoverable listed transcript; Claude/Codex reader; packs `messages` |
| `/api/events` | EventSource connection | 200 event stream | 429 after 20 dashboard connections |
| `/api/attachments/:uuid.png\|jpg\|gif\|webp` | generated attachment filename | 200 image bytes | 404 missing; private immutable cache, one year; UUID-extension allowlist |
| `/api/models` | none | 200 `{models:ModelOption[]}` | runtime/fallback options plus Auto/Jev |
| `/api/teams` | none | 200 `{teams:TeamSummary[],tools:string[]}` | full team obtained separately |
| `/api/teams/:id` | lowercase team ID | 200 `{team:TeamDefinition}` | 404 team absent |
| `/api/projects?archived=1` | optional `archived=1` | 200 `{projects:ProjectView[]}` | default excludes archived; `1` includes both active and archived |
| `/api/worktrees` | none | 200 `{generatedAt,checkouts:Checkout[],outside:number}` | `Checkout` has path, pathShort, repo `{name,root}`, branch, tip, trunk, isMain, merged, mergedBy, empty, dirty, unpushed, locked, running, pr `{number,url,state}`, clearable, blockers `[{text}]`, sessions `[{name,engine,alive,cwd}]`; read with git and gh on each request, no ETag |
| `/api/pr-status?url=…` | GitHub PR URL `https://github.com/o/r/pull/n` | 200 `{status}`; success `{ok:true,state,draft,number,ci:{result,failing[]},…}` | gh trouble is never an error status: `{ok:false,reason}` with reason `missing`, `unauthenticated`, `rate-limited`, `not-found`, `invalid` or `failed`; cached 30 s to 10 min, at most two gh runs at once, five-minute backoff when gh is unavailable |
| `/api/progress?days=N` | optional numeric days | 200 `ProgressReport` | clamps 1 to 30; defaults seven; not an envelope |
| `/api/search/:id` | search job ID | 200 `{job:SearchJob}` | 404 expired/unknown; poll while thinking |
| `/api/settings/gateway` | none | 200 `{gateway:{configured,source}}` | no saved key returned; storage failures may be 503 |
| `/api/settings/approval-mode` | none | 200 `{defaultApprovalMode}` | mode `ask|auto|all` |
| `/api/service` | none | 200 `{service:ServiceStatus}` | unsupported OS represented in DTO |
| `/api/update` | none | 200 `{update:UpdateStatus}` | answers cache and triggers background check |
| `/manifest.webmanifest` | none | 200 manifest JSON | dynamic theme colors; no-cache |
| `/theme.css` | none | 200 generated CSS | no-cache; server refreshes theme reading periodically |
| `/`, `/index.html` | none | 200 HTML | explicit static allowlist; no-cache |
| `/styles.css`, `/vendor/libs.js` | none | 200 CSS/JS | explicit static allowlist; no-cache |
| `/app.js`, `/select.js`, `/review.js`, `/ui.js`, `/sync.js`, `/control.js`, `/blocks.js`, `/ask.js`, `/teams.js`, `/day.js`, `/sounds.js`, `/projects.js`, `/progress.js`, `/worktrees.js`, `/views.js`, `/connections.js`, `/settings.js` | none | 200 JavaScript | legacy production entries removed together at cutover |
| `/icons/fleet-192.png`, `/icons/fleet-512.png` | none | 200 PNG | preserve installed-app identity |

### POST routes

| Path | Current JSON body | Success | Validation / conflict behavior |
| --- | --- | --- | --- |
| `/api/managed` | `{requestId,cwd,prompt,name?,engine?,teamId?,approvalMode?,model?,resumeSessionId?,fork?,projectId?,images?,kind?}` | 201 `{session}` | `kind:'day'` has special creation rules; requestId required; cwd required except Day fallback; capacity/100-session limit/resume/engine conflicts 409 |
| `/api/managed/:id/messages` | `{requestId,message,images?,references?}` | 200 `{session}` | queues during turn/holder/dispatch; admission is checked before the request ID or images are recorded (B02) and a Codex session refuses GIF; valid request ID required; supported Day/thread/project internal `runPrompt/background` are current server fields, not general UI inputs |
| `/api/managed/:id/stop` | `{}` | 200 `{session}` | available despite global storage latch; stop clears pending/queued work according to lifecycle |
| `/api/managed/:id/close` | `{}` | 200 `{closed}` | removes managed conversation; use lifecycle tests for worktree/attachment/thread cleanup |
| `/api/managed/:id/name` | `{name}` | 200 `{session}` | agents/initiatives only; 1 to 100 characters, sets renamed flag |
| `/api/managed/:id/project` | `{projectId:string|null}` | 200 `{session}` | agents/initiatives only; missing project 404 |
| `/api/managed/:id/mode` | `{mode:'ask'|'auto'|'all'}` | 200 `{session}` | invalid mode 400 |
| `/api/managed/:id/model` | `{model:string}` | 200 `{session}` | empty default allowed; validated model choice |
| `/api/managed/:id/limits` | `{maxAttempts:number}` | 200 `{session}` | initiative workflow only; integer 1 to 10; active manager 409; not a money limit |
| `/api/managed/:id/approvals/:approvalId` | `{decision:'allow'|'deny',reason?,answers?:Record<question,string>}` | 200 `{session}` | 409 stale/wrong-session approval; question answers required on allow |
| `/api/managed/:id/day` | discriminated `DayAction` below | 200 `{result,session}` | requires Day session; domain validation is 400, 404 or 409 with a `code` since #103 |
| `/api/projects` | `{name,note?,requestId?}` | 200 `{project}` with `project.setup` `{started:true}` or `{started:false,error}` | creates Markdown and starts the setup manager; since B01 a capacity refusal keeps the project, logs "Setup did not start" and reports `setup.started:false` with no storage-error latch (only real write failures latch); archived projects no longer count toward the 30-project cap (B06) |
| `/api/projects/:id/archive` | `{archived?:boolean}` | 200 `{project}` | defaults true; false restores; 404 unknown project |
| `/api/projects/:id/deliverable` | `{deliverableId,state?,note?}` | 200 `{deliverable}` | states `todo|doing|review|done`; absent deliverable 400 |
| `/api/projects/:id/ask` | `{message,requestId?}` | 200 `{session}` | capacity 409; server currently also accepts internal runPrompt; manager reused |
| `/api/projects/:id/today` | `{deliverableId}` | 200 `{item,existing:boolean}` | 409 no current Day; duplicate match is by project plus deliverable since B05 |
| `/api/projects/:id/comment` | `{deliverableId,message,requestId?}` | 200 `{session}` (the project manager) | message required, up to 8000 characters; unknown deliverable 400; logs the comment in the project and on the task's Today item, then runs the manager; capacity 409; requestId dedupes |
| `/api/worktrees/clear` | `{path}` | 200 `{cleared:{branchDeleted,…}}` | the server re-derives the verdict from git and refuses when the checkout is no longer merged, clean and pushed; the page only names the path |
| `/api/teams` | `TeamDefinition` | 200 `{team}` | built-ins read-only; custom save/update; validation 400; body limit 256000 bytes |
| `/api/search` | `{question,model?}` | 201 `{job}` | question 1 to 500 chars; replaces previous global search; no idempotency guarantee today |
| `/api/archive` | `{ids:string[],archived?:boolean}` | 200 `{changed:number,archived:number}` | defaults true; over 5000 valid unique IDs 413; latter count is explicit archive map size |
| `/api/archive/rule` | `{enabled,days}` | 200 `{rule:{enabled,days}}` | day number normalized/clamped 1 to 365 |
| `/api/queue` | `{enabled?,limit?,paused?}` | 200 `{queue}` | booleans; integer 1 to 8; disabling with waiters 409; pausing disabled queue invalid |
| `/api/settings/approval-mode` | `{mode}` | 200 `{defaultApprovalMode}` | invalid mode 400 |
| `/api/settings/gateway` | `{action:'save',apiKey}` or `{action:'remove'|'test'}` | 200 `{gateway,test?}` | invalid 400; write/read failures 503; synthetic test can incur gateway charge |
| `/api/connections` | `{action?:'check'|'reconnect'|'enable'|'disable'|'authenticate',sessionId?,cwd?,name?,connectionId?,source?}` | 200 `{connections:ConnectionResult}` | sessionId is Fleet managed ID; check defaults; 400 invalid, 404 absent server, 409 busy/stale target/unsupported, 502 transport/auth failure, 504 timeout |
| `/api/service` | `{enabled:boolean}` | 200 `{service,restarting:boolean}` | enabling may hand over to launchd after response; unsupported cases follow service domain errors |
| `/api/update` | `{}` | 200 `{update:UpdateStatus & {restarting:boolean}}` | schedules restart after response; remains available during storage failure |

`DayAction` is exactly the following browser-facing union; it is not the agent tool's generic `action` protocol:

```ts
type DayAction =
  | {op:'add'; item:{title:string; source:'me'; context?:string;
       links?:string[]; priority?:'must'|'should'|'could';
       mode?:'me'|'draft'|'agent'|'ask'; estimateMin?:number; projectId?:string}}
  | {op:'triage'; itemId:string; status?:'today'|'later'|'dropped'|'proposed'|'done';
       priority?:'must'|'should'|'could'; mode?:'me'|'draft'|'agent'|'ask'; projectId?:string|null}
  | {op:'answer'; itemId:string; needId:string; answer:string;
       decision?:'reply'|'approve'|'reject'|'edit'|'choose'|'info'; cwd?:string; teamId?:string}
  | {op:'sweep'}
  | {op:'thread'; itemId:string; message:string; requestId:string};
```

For answer, `decision:'reply'` never approves an outward action. Otherwise need kind and answer determine approve/reject/edit/choose/info. Launch cwd/team can override the proposed plan. Sweep returns `{queued:true}`; thread returns `{threadId}`; add/answer/triage return their domain result. Day needs are not interchangeable with managed tool approvals.

Generic existing HTTP rules:

- Only GET/POST; other methods 405 `{error}`. Unknown action/path 404 `{error}`.
- Host must exactly match `localhost:port` or `127.0.0.1:port`. Origin, when present, must equal the server's HTTP origin. Cross-site Fetch Metadata requests are rejected. Guard failures are 403.
- POST token is random per process; invalid/missing token produces 403 with “Reload Fleet before sending commands.” Its shape is currently indistinguishable by code from other 403 errors.
- Body limits: 40 MiB for creation/messages; 256000 bytes for teams; 65536 bytes otherwise. Non-JSON media type 415, excessive body 413, malformed/non-object JSON 400.
- Error body is `{error:string, code, retryable?, fieldErrors?}` since #103; `error.status` is retained and untyped exceptions still become a generic 500 with details only in server logs. Day validation is 400, 404 or 409 now (fixtures: `day-full/post-day-*`).
- Global storage latch currently rejects POST with 503 except update and managed stop. Reads still work. It is not a reliable domain-error classifier and must be corrected.
- Response security headers are nosniff, no-referrer, frame denial and same-origin CSP. Retain those for API, HTML and generated assets. No permissive CORS is introduced.

## 6. Entities, identity, and DTO definitions

Add explicit TypeScript response types and runtime boundary schemas. Current wire responses are not fully versioned DTOs: notably `ManagedSessions.detail()` returns a raw structured clone including persistence/internal fields. An explicit outward allowlist is a **proposed backend change**, not an existing guarantee. First capture fixtures from each branch, then type every field consumed in inventory F01 to F28; preserve optional/unknown values during old-state recovery. Never cast arbitrary JSON directly to a trusted type.

| Entity | Required consumed structure / semantics |
| --- | --- |
| `SessionSnapshot` | `{sessions,counts:{busy,idle,stale,dead},total,archived,archiveRule,queue,storageError,usage,generatedAt?,…collectorMetadata}`. Counts exclude archived external sessions; array still includes them. Managed/transcript dedup respects forkPending. |
| `SessionSummary` | Stable `managedId?`, transcript `sessionId?`, `engine:'claude'|'codex'`, `pid?`, name/title/shortId/cwd/cwdShort/branch, state/alive/managed/managedStatus, created/activity metadata, lastPrompt/latestResponse, model/contextTokens/contextLimit, approvals/counts, turn/links, archive/background/parent attribution, kind/team/task/day/project/thread metadata, queuePosition, holder/resume/fork flags, token usage and cost where known. |
| `ManagedDetail` | `id` is Fleet ID, `sessionId` is runtime transcript ID (nullable), `kind:'agent'|'initiative'|'day'|'thread'|'project'`, engine, status, identity/cwd/name timestamps, selected/actual model and routing data, approvalMode, messages, approvals, queue, error/currentTool, context/usage, teamSnapshot/taskBoard/subagents/dayBoard/dayChecks/worktree as relevant, parentDayId/itemId/projectId/holder and lifecycle metadata. Detail must not accidentally become the schema for list payloads. |
| `Message` | Stable id; role user/assistant/tool/event and supported system records; timestamp; text; optional attachments/references; tool/name/input/target/status/result/duration/truncation/approval/role attribution; streaming updates preserve message ID. Day display events/grouped board messages are derived view models, not new persisted messages. |
| `Attachment` | `{id,mediaType,bytes}` with generated UUID extension. Client upload has `{data:base64,mediaType?}`; server sniffs bytes. Never infer a server filesystem path from attachment id. |
| `Reference` | Input is bounded source ID list resolved server-side; output includes retained source identity/title/context metadata. Distinguish managed ID from external transcript ID and reject target's own managed/transcript identity. |
| `History` | `{messages,alive,…readerMetadata}`; preserve truncated/history state and engine-specific reader behavior. No arbitrary pathname parameter. |
| `Approval` | `{id,tool,input,at,reason,description,role?}`; pending only within the live process/run. Answers are keyed by question string in the existing request contract. |
| `QueueState` | `{enabled:boolean,limit:number,paused:boolean,running:number,waiting:number}`; waiting is a number, not a session array. Detailed queued messages are on the session. |
| `Delegation` | id/role/model/description/prompt/status/startedAt/finishedAt/report/output/activity/tokens and bounded steps; each step has id/tool/target/status/input/result/ms/truncated. Team delegations may be in taskBoard; Day/scout details may be in subagents. |
| `TeamDefinition` | `{id,name,description,manager,roles:Record<roleId,{description,prompt,model,maxTurns,effort,tools}>,workflow:{mode?,reviewers,maxAttempts}}`; summaries turn roles into a short array and add custom/mode. Normal team 3 to 8 roles; owner-review exactly two; 50 custom teams. |
| `DayBoard` | `{date,items,cursors,capacity?,focus?}`; 200 items; item has id/title/source/priority/status/mode/estimateMin/links/context/needs/log/createdAt/by plus project/deliverable/carryover/launched/thread data. Status includes proposed/today/in_progress/waiting_on_you/done/later/dropped. |
| `DayNeed` | id/kind/question/at; kind approve/choose/info/launch; options/draft/launch; optional answer/decision/answeredAt/seen. Limit 20 open needs; decisions and exact drafts matter for permission, not just display. |
| `ProjectView` | `{id,name,deadline,archived,repos,links,brief,deliverables,sections,log,file,updatedAt,setup?:{started,error?},progress:{total,done,doing},sessions:number,onToday:Record<deliverableId,{itemId,status}>,managerId}`. Markdown remains source of truth, arbitrary sections survive. |
| `Deliverable` | `{id,title,state,note,brief,links}` since 0.51; the id is stable and persisted since B04. Scope is project+deliverable, never title or list index. |
| `ProgressReport` | `{since,days,staleDays,shipped:{items,count,prs},stalled:{items,count},ran:{count,outcomes,sessions}}`; counts may exceed returned rows (50-row bound). |
| `SearchJob` | `{id,question,model,startedAt,status,terms,hits,sessions:number,passages:number,searchMs,ai,error,aiMs}`; thinking/done/error/stopped; UI-only searching state. Hit carries sessionId/title/project/lastAt/matches/snippets; ai contains answer and relevance/context/quote matches. |
| `Command` | Catalog name/kind/scope/description/hint fields consumed by picker. Insertion changes composer only; it does not execute the command. |
| `ConnectionResult` | `{cwd,source:'session'|'project',connectionId,checkedAt,servers,auth?}`. Server rows expose name/status/scope/internal/tools/capability booleans/auth kind/safe error. Optional auth `{name,url,opened,needsAction,callback}`; no raw config, environment or transport credentials. |
| `GatewayStatus` | `{configured:boolean,source:'saved'|'environment'|null}`; test result exposes safe status/message fields, never key. |
| `ServiceStatus` | `{supported,enabled,loaded,managed,file?,log?}`; unsupported returns booleans false. |
| `UpdateStatus` | `{name,current,latest,available,canInstall,channel,checkedAt,state,error,installed}` and POST restarting flag. Running version comes from server control, not local package text. |
| `Usage` | Account available/known/subscription/observedAt/stale/windows/binding/blocked values; reset times normalized server-side. Unknown is not 0%. Context counters and monetary session cost remain distinct. |

Brand ID types in frontend code (`ManagedId`, `TranscriptId`, `ProjectId`, `DayItemId`, `ApprovalId`) to stop accidental interchange. Qualify external cache keys by engine even if most transcript IDs are UUIDs. Preserve a managed ID through first runtime ID assignment and fork completion. A React key must never switch from managed ID to transcript ID when the latter appears.

## 7. Transport, cache, invalidation and recovery

### Existing protocol to preserve

`sync.js` computes an ETag from the semantic payload and can replace known array entries with `{h}`. Full entries carry `h`; current fingerprints are 16-character base64url SHA-1 slices of serialized items. Clients send `If-None-Match` and comma-separated `X-Fleet-Known`. Packed arrays are only sessions, managed messages/subagents, and external-history messages. A 304 returns no JSON body. Missing fingerprints require a full GET, not a partly reconstructed UI. Fingerprint maps are per resource, not a global cross-entity cache.

The SSE stream emits `event: sessions` with a JSON array of managed IDs or special values such as `projects`/`queue`, coalesced for 120 ms; `event: list` has `{}` data; heartbeats are comments every 15 seconds. There are no sequenced event IDs, replay guarantee, or delta payload today. Server external-list observation runs about every two seconds, with list checks throttled. Treat events as invalidations, never as authoritative domain updates.

### Target implementation

- A single conditional-fetch adapter sits beneath the query cache. It owns `{etag,itemMap,decodedValue}` per resource/generation and handles 200/304/schema errors before query cache publication. Do not let browser cache behavior or query library retries reinterpret a 304 as a failed JSON parse.
- Bound known-header output below the configured Node request-header allowance with room for all other headers. The existing 64000-byte application parser cap does not ensure Node accepts a header that large. On overflow omit `X-Fleet-Known` and still use ETag; on 431 or unresolved fingerprint retry once without conditional headers, then surface a protocol error. Never recurse unboundedly.
- Preserve array order/removals exactly from the latest response, retain references for unchanged items, and validate every packed path. Do not mutate old query data while unpacking.
- Dedupe each resource's in-flight fetch. If invalidated during that request, mark dirty and schedule one follow-up. Use AbortController and monotonically increasing request/generation epochs: a slower pre-mutation or old-generation response cannot overwrite an authoritative mutation result.
- On session events, invalidate affected detail, list, related Day/project and Progress resources through a documented dependency map. On list events refetch the list and selected relevant detail. On project events fetch projects; on queue events fetch the list/control queue. Hidden inactive details do not poll continuously.
- A selected active/approval/queued/stopping session keeps a conditional 2.5-second safety refresh; idle selected detail at most every 30 seconds. Visible list gets event-driven coalesced refresh and a conservative recovery poll. Search polls about 700 ms while thinking and stops when settled; Connections polls only while its dialog/action needs it. Progress defaults to its 15-second freshness window. Project files need periodic visible refresh because hand edits do not necessarily emit manager SSE events.
- A local low-frequency clock component updates durations and usage countdowns without refetching or rerendering the application root. Visibility return triggers bootstrap freshness and relevant GETs; hidden tabs suspend cosmetic timers and nonessential polling, not server work.
- Network failure retains last successful data with a stale/disconnected indicator and automatic bounded retry with jitter. Empty data, stale data and failed initial load are distinct. One failed feature request does not blank the shell. Retry controls retain form contents.

### Backend additions shipped with the migration

These are the only backend changes in the migration release. Both are merged (#103):

1. Add `apiVersion`, `instanceId` (new per server process), `buildId`, and explicit engine/feature capabilities to `/api/control`. Version incompatible clients get a readable reload state. Keep current fields for compatibility.
2. Add machine-readable errors while retaining `error`: `{error,code,retryable?,fieldErrors?}`. Codes distinguish token expiry, capacity, stale approval, missing entity, persistence failure and unsupported engine capability. Convert domain validation to meaningful 4xx without exposing raw exceptions.

Client behavior built on them:

- Ordering: frontend request epochs (section 7, target implementation) stop a response fetched before a mutation from replacing newer state. Server-side resource revisions are out of scope.
- On stale token (`code` says so, not any 403), refresh control once. Retry only when the server definitively rejected before execution, or the route already dedupes by `requestId` (create, message, Day thread). Never blindly repeat an update, authentication action, search, approval or other command after an ambiguous network failure; refetch and reconcile instead.
- On EventSource reconnect, refresh control and compare `instanceId`. When it changed, clear ETags, fingerprint maps, approvals and connection leases, then reconcile with current server state. Keep user drafts and selection. A disconnect alone is not proof of restart.
- Update/service handover waits for `instanceId`/`buildId` to change, not just an HTTP 200 from the still-running old process. Use a deadline and an actionable recovery error. Revalidate active selection and restore recoverable drafts after full asset reload.

Maintain a dependency table beside query keys and test it: message/stop/mode/model/approval/rename affect detail+list; close affects selection+list+projects+Day threads+Progress; Day mutations affect Day detail+list+projects+Progress; project changes affect projects+tag pickers+related Day; queue affects control/list/detail state; team save affects catalog and launch editor only; gateway changes affect gateway status and future Auto launches, not existing routing choices.

## 8. Phase 0: backend fixes before the migration

The following defects were reproduced in the preceding review. They are backend bugs, independent of the renderer, so each ships as its own PR against the current UI with a regression test, before migration work starts. A React-only workaround is insufficient; so is waiting for the migration.

| ID | Existing defect | Fix |
| --- | --- | --- |
| B01 | `managed.createProject()` catches setup-manager capacity errors and emits `storage-error`; `server.js` then latches all writes disabled | Capacity is a domain failure, never disk failure. Keep the created project, record that setup did not start, and return the project with that state (or a 409 if the project was not written). Asking the manager again later retries setup. Only real persistence failures emit `storage-error`. |
| B02 | `send()` records the request ID and may write images before the capacity check; a retry is then falsely accepted without a message | Reorder: validate and admit (or queue) first, then record the request ID and write attachments. A rejected attempt leaves no trace, so retrying the same ID tries admission again. Same accepted ID still produces one message. |
| B03 | Claude image prompt is an async iterable, but Codex execution receives it as stdin text and fails | Build engine-specific prompts: Claude uses the content-block iterable; Codex gets string text plus supported image file arguments. Reject unsupported formats before acceptance. Image-only Codex messages supply sensible text. |
| B04 | Project deliverable IDs derive from a lossy 60-character slug; distinct titles collide and hand-edited titles change identity | Persist stable deliverable IDs in Markdown (for example a trailing HTML comment), assign them once to legacy rows, preserve order/title/note/state/arbitrary sections. Migrate Day links with an unambiguous project+slug mapping; flag ambiguous collisions instead of guessing. The current parser treats trailing text as title/note, so test the previous release against migrated files and ship a lossless rollback (strip the comments) before calling rollback safe. |
| B05 | `planDeliverable()` finds duplicates by deliverable ID without project ID (`managed.js:522`) | Match `(projectId,deliverableId)`. Equal titles in different projects produce separate items. |
| B06 | Project cap counts archived projects, despite the "Archive one first" guidance | Count only active projects against `MAX_PROJECTS` (30). Archiving frees a slot; restoring at cap is a clear 409 and leaves the project archived. |
| B07 | Approval command denylist misses wrapped commands such as `env -i rm`, `git -C … push`, and `find … -delete` | Classify through wrappers and options, and treat ambiguous shell syntax conservatively. Auto mode asks on those; all mode unchanged. UI wording must not imply the denylist is an OS security boundary. |
| B08 | `public/ask.js:118` Open in Fleet assigns bare `selected`/`filter` inside a strict-mode IIFE (ReferenceError) | Small fix in the current UI now; the React version uses the typed navigation action (A18). |

Storage health should describe actual persistence failure. After B01, also make the banner clear only after a write succeeds again, not after any GET.

B04 is the only Phase 0 change to user-editable files. No other state file changes format.

Out of scope for both phases, reconsider only with profiling or a reproduced bug: a durable idempotency ledger with payload hashes, per-resource revisions, async serialized persistence, cached session summaries, and multi-store transactional intents. The existing `requestId` dedupe plus the B02 reordering covers the reproduced duplicate/false-accept cases. If the migration's performance traces (section 11) show the event loop blocking on `ManagedSessions.save()` or snapshot assembly, write that up as a separate proposal.

## 9. Design fidelity and accessibility

Capture the current dirty-tree launch modal and four workspace views before replacing markup. Build a visual reference set for desktop 1440×900, laptop 1280×800, tablet 900×900, and mobile 390×844. Include narrow modal height, long titles, busy sessions, pending approvals, a full Day board and open team editor. Use deterministic fixture text, clock, fonts, avatar seeds and animation settings. A screenshot pass requires human comparison with the current design, not just approval of a newly generated baseline.

Port the current tokens and component styles, then remove legacy selectors only once their replacement is verified. Preserve dynamic theme fallback and ensure generated app styles do not refer to unresolved `--w-*` variables. Keep existing minimalist charcoal presentation; no gratuitous cards, gradients, larger typography, new dashboard metrics or layout reorganization. Differences are permitted for identified usability defects and must be documented.

All actions need accessible names; statuses communicate with text, not color alone. Progress indicators use correct value/unknown semantics. Dialog errors use meaningful alert/status announcements without announcing every stream token. Preserve readable contrast, reduced-motion support, focus rings and touch target usability. A live conversation is not a constantly speaking screen-reader live region. Keyboard-only navigation covers list selection, delegated detail, comboboxes, approvals, splitters, modal close and focus return. Test browser zoom at 200% and mobile soft-keyboard composer behavior.

## 10. Build, packaging, development and release

Keep `node bin/claude-fleet.js …` and npm global installation working without TypeScript compilation or devDependencies on the user's machine. Production package includes compiled HTML/CSS/JS and all backend modules in the current `files` allowlist. Build tooling belongs to devDependencies; React and Markdown libraries are bundled into assets. Runtime agent SDK/Zod dependencies remain available to Node as needed.

Proposed scripts: `dev:frontend`, `build:frontend`, `typecheck`, `test:frontend`, `test:e2e`, and `test:package`; retain backend `npm test`. `prepack` must run the production frontend build (not only the current vendor script). Replace the legacy `npm run vendor` reproducibility CI check with the chosen asset build policy. Either keep generated assets checked in and verify a clean reproducible diff, or build them in CI/prepack and explicitly test tarball contents; choose one and document it. Recommended: build artifacts in CI/prepack, source-controlled manifest/build configuration, no manually maintained bundled JS. Update release workflow so publishing cannot skip the build/typecheck/acceptance gates.

Vite development should use a documented local Node fixture/backend arrangement. Because current backend validates exact Host and Origin, a proxy must deliberately set those for its local target and test SSE forwarding/token requests. Never weaken production guards to make HMR convenient. Production serves same-origin assets/API/SSE with no second server. Preserve local binding, CLI lock ownership and the state directory paths.

Static serving must accept only manifest-listed hashed assets plus existing exact icon/theme/manifest routes. Normalize and reject traversal/encoded separator requests; reject unknown assets as 404, not HTML. HTML is no-cache; hashed assets may be immutable. CSP stays self-only for scripts/connect/images with current data-image allowance; no unsafe-eval or inline executable scripts. Retain previous build assets for the running release or serve its immutable asset manifest so replacing disk files cannot give an old page mixed code. Restart/load compatibility is checked by instance/build ID.

Use an isolated worktree for implementation, branched from the `main` commit that contains the pending launch modal and Codex work (section 2). Branching from `3f5d300` would reintroduce the old inline draft and Codex hiding behavior.

Release runbook:

1. Freeze the feature inventory against the final branch and reconcile source changes since this plan.
2. Pass Node, contracts, TypeScript, component, browser, accessibility, visual and performance gates; audit final production HTML for a single React entry and no legacy controllers.
3. `npm pack`, inspect the package allowlist, install the tarball into a temporary prefix, and start it with a temporary Fleet home. Verify HTML/assets/control/SSE, creation and fake-runtime lifecycle, images, update/service response states, and startup without devDependencies.
4. Exercise restart and upgrade with synthetic saved state: active/queued/stopped sessions, canceled approvals, custom teams, archived sessions, Day carryover/threads, Markdown projects and attachments. The migration release changes no state format (B04 shipped and proved its rollback in Phase 0), so rolling back means reinstalling the previous package.
5. Review the concrete release diff and evidence; publishing/installing the live global app follows the user's authorization for that separate action. This planning task does not authorize publishing or restarting active agents.
6. Publish one complete package using the repository's established version/tag workflow. Verify installed version, manifest/assets and smoke journeys. Retain prior package and state backup instructions for full rollback.

## 11. Test strategy and acceptance matrix

Retain the existing backend suite. Legacy browser-source/VM tests encode valuable behaviors but are coupled to IIFE globals and string markup; replace their implementation-specific assertions with meaningful React interaction tests before removing them. Each removed test has a mapped replacement or a documented obsolete invariant, never just deletion to make CI green. Especially retain `draft.test.js`, `sync.test.js`, `views.test.js`, `select.test.js`, `teams-board.test.js`, `day-ui.test.js`, history/reference/dispatch/worktree/service/settings/usage tests and the uncommitted Codex/draft regression intent.

Use four layers: pure domain/transport tests with fake clock; React interactions with Testing Library and HTTP fixtures; Node HTTP contract tests against `createApp` with fake runtimes/temp homes; Playwright production-build journeys against that isolated fixture server. Browser tests must activate real handlers, not merely assert source text or mock away the implementation that previously failed. Never start real model jobs, authenticate real connectors, send messages to others or mutate actual project files in automated acceptance.

Fixture pack:

- `fleet-mixed`: managed Claude and Codex, live/offline external sessions, background observer attribution, archived row, fork-pending managed copy, externally held session, all status/count/filter combinations.
- `conversation-heavy`: 200 mixed messages, growing streaming message, code/diff/tool/truncated output, images/references, queued follow-ups, stale/current approvals and actual error.
- `teams-heavy`: normal team and owner-review snapshots, 25 delegations including selected oldest, 200 steps on one delegation, failed/interrupted/completed/running handoffs.
- `day-full`: 200 items spanning states/sources/modes, open approve/choose/info/launch needs, carried item/previous thread, active thread, scout history, calendar capacity and project links.
- `projects-collision`: two projects with equal deliverable titles, same-project punctuation/Unicode/60-character slug collisions, archived projects at cap, Markdown hand edit and arbitrary sections.
- `failure-lifecycle`: token rotation, SSE drop/duplicate/burst, 304/unknown fingerprint/431, reversed responses, dropped mutation response, request timeout, disk full/recovery, server restart, missing asset and incompatible build.

Rows P1 to P6 are Phase 0 regression tests, shipped with each bug-fix PR against the current UI (P6 is A08's backend half: Codex receives text plus image file arguments). Rows A01 to A33 are migration tests (A30 to A33 cover the features added after the plan was first written, F29 to F35).

Hard gates for the migration release: A03, A06, A07, A10, A24, A25, A26 and A29. These cover the places a rewrite most often loses data or input. The remaining rows must be checked before release, but a failing one can be triaged as a documented known issue rather than blocking.

| Test ID | Inventory / bug | Given → action → required result |
| --- | --- | --- |
| A01 | F01 to F04, F27 | Load mixed fixture → inspect counts, filters, rows and inspector → engine/state/count semantics match server; unknown usage/context stays unknown; title/cwd/links accurate. |
| A02 | F02 to F05 | Select oldest delegation among 25 → stream a newer one and fold/unfold parent → selected record remains reachable, correct parent, stable focus; folding moves selection to parent. |
| A03 | F06 to F07 | Open launch while viewing existing session → type/select/dismiss/reopen → draft and selection preserved, no POST yet; discard clears; unavailable Codex remains visible and blocks only its launch; availability recovers on reopen. |
| A04 | F06, F14 | Launch single/team/owner-review from each view → fake response → one session, correct engine/team/model/mode/cwd, selection moves to Sessions, modal closes; failed request preserves exact form and key. |
| A05 | F08 | External live Claude/offline Claude/live Codex/offline Codex → continue/copy → live Claude forks without merging source row; offline resumes correct transcript with history; live Codex refused without losing draft. |
| A06 | F09 | Append/update streaming message → copy/collapse tool/read earlier text → node identity and read anchor stable; user-above-tail does not jump; tail follower follows; unsafe Markdown cannot execute or spoof form controls. |
| A07 | F10 to F11 | Compose with IME, commands, reference chip and images → switch sessions while request is pending → no cross-session draft clearing; late response clears only submitted revision; shortcut insertion never sends by itself. |
| A08 | F11, B03 (P6 in Phase 0) | Paste/drop valid PNG/JPEG/GIF/WebP and invalid/oversize/seventh image → send both engines → accepted supported images reach correct runtime argument form; invalid data rejected before acceptance; image-only message works; no async-iterable stdin error. |
| A09 | F12 | Rename/change mode/model/tag/stop/close → session invalidation → correct next-turn settings and persisted title; close needs second click; stop cancels queued work; held message waits for release. |
| A10 | F13 | Partially answer multi-choice/free text → unrelated SSE refresh → values/focus retained; allow/deny once; stale approval 409 refreshes and explains; restart never approves automatically. |
| A11 | F14 to F15 | Edit built-in copy/custom/owner-review → role changes and save → constraints preserved, forbidden tools removed, active snapshots unchanged, reports and evidence tied to correct session. |
| A12 | F16 | Start Day twice on same date → one server Day; next-day fixture → unfinished work/needs carry over, completed/dropped do not, old threads close appropriately; dates remain local. |
| A13 | F17 | Add/triage/bulk Must/move Later/mark done → update → proper statuses and logs; attempted done with unanswered needs rejected; partial bulk failure is visible, not a false all-success toast. |
| A14 | F18 | Edit approval draft/reply/choose/info/launch brief → submit → exact approved text and cwd/team transmitted; reply never authorizes send; launch creates one child; failures retain input. |
| A15 | F18 | Open item thread and older scout run → stream new latest scout → selected historical run stays selected, thread belongs to correct Day/item, no composer appears for scout. |
| A16 | F19 | Create project/ask manager/change deliverable/plan Today/copy path/archive/hand-edit Markdown → refresh → correct rollups, manager selection, arbitrary sections and exact file authority preserved. |
| A17 | F20 | Week boundary with repeated carried IDs/done/reopened/stalled sessions → read Progress → dedup and totals match `progress.js`, PR count distinct, max rows bounded, no fabricated merge verification. |
| A18 | F21 | Submit search A then B; resolve A late → B remains current; keyword results survive answer failure; activate Open in Fleet → correct view/filter/selection with no ReferenceError; missing live session gives resume command. |
| A19 | F22 | Check target then replace transport → reconnect/toggle/auth → stale lease 409 forces recheck, no action hits replacement; private data excluded; pending auth and callback polling stop/clean up correctly. |
| A20 | F23 | Queue limit/pause/disable/default mode/service/gateway actions → success/failure → authoritative state restored, invalid disable explained, future defaults only, no key in query persistence/logs/storage; service handover waits for new instance. |
| A21 | F24 | Archive old external session/restore under enabled age rule → refresh/restart → restoration exemption holds; managed sessions are closed instead; archive never deletes transcript or removes searchability. |
| A22 | F25 | Install update response while old server still returns 200 → restart/new build → wait until identity changes; load coherent new assets; timeout shows recovery; source checkout never pretends npm install is available. |
| A23 | F26 | Keyboard, 390px viewport, 200% zoom, reduced motion, long dialog → navigation/resize/select/close → controls remain reachable, focus trapped/restored, native touch choices work, persisted sizes clamped. |
| A24 | F28 | 304/full/packed/unknown hash/431 response sequence → reconstruct → exact latest arrays, no missing item, bounded full retry, no parsing 304; unchanged items retain reference identity. |
| A25 | F28 | SSE burst while GET pending; stale GET after mutation; selection swap; visibility return → reconcile → one in-flight fetch per key, necessary follow-up retained, old result cannot overwrite newer state, no wrong-pane error. |
| A26 | F28 | Offline/reconnect/new token/new instance → recover → last-good state retained then replaced, old conditional/approval leases cleared, drafts retained, no blind duplicate POST. |
| P1 | B01 | Fill agent capacity, create project → typed pending/conflict outcome → global storageError remains null and unrelated writes still work; setup retry creates one manager and honest status. |
| P2 | B02 | Queue off/full capacity, send request R → 409 and nothing recorded (no request ID, no attachment files); free slot and retry R → exactly one accepted message; repeat R after acceptance → no duplicate. |
| P3 | B04 to B05 | Equal slug across/within projects → migrate/edit/plan Today → stable distinct IDs and correct project-scoped item; duplicate retry same pair returns existing; ambiguous legacy link is never silently remapped. |
| P4 | B06 | 30 active projects → archive one/create/restore → create succeeds after archive; restore at cap fails clearly; no data discarded. |
| P5 | B07 | Auto mode commands `env -i rm`, `git -C repo push`, `find . -delete` plus harmless controls → classification → risky cases request approval; safe controls retain intended handling; ask/all semantics unchanged. |
| P6 | B03 | Send text+image and image-only messages to a fake Codex runtime → runtime receives string text and image file arguments, never a stringified iterable; unsupported format rejected before acceptance. |
| A27 | F12, F28 | Inject disk failure → send/create/plan → error shown, draft retained, real storage banner, stop still allowed; banner clears only after a write succeeds. |
| A28 | F01 to F28 | Mount/unmount/switch 100 times in StrictMode with active fixtures → inspect resources → one stream per app, no orphan timers/listeners/observers/object URLs, bounded caches and no steadily growing heap. |
| A29 | F25, build | Install packed release without devDependencies → start fixture backend → all assets 200 correct MIME, unknown/traversal assets 404, CSP enforced, no legacy scripts, correct app icon/manifest, fake-runtime lifecycle works. |
| A30 | F29 | Worktrees fixture (merged and clean, dirty, unpushed, open PR, running session, locked, main checkout, session outside any checkout) → filter, open a row, press Clear... → only clearable rows offer it; the confirmation lists what is removed and left alone; a server refusal shows its reason and the list catches up; filter and open rows survive redraws and a refresh. |
| A31 | F30 | Agent session with three PR links, one CI-failing → one line each with state and CI pills, failing checks in the tooltip, gh problems explained; Feedback preset "CI failed, fix it" fills the message, send posts through the message route and queues during a turn; draft kept per session when switching; Day, project manager and thread sessions show no strip; Fleet-only sessions show state but no form. |
| A32 | F31, F33, F34 | Open a project task → brief, sources and comment box; Enter sends, Shift+Enter breaks the line, empty comment is refused with its toast; a sent comment logs on the project and the task's Today item and runs the manager; a manager write tool shows an approval card, messaging tools are denied; Plan on Today hands over the bounded brief and a long context folds on the board. |
| A33 | F32 | Snapshot sequence (agent running to idle, session reaching approval, Day waiting count rising, a report need appearing) → at most one tone per update, none on the first snapshot, none when sounds are off, Day/project/thread idle transitions are silent; report-back toast text and optional notification only with permission; Settings toggles persist per browser. |

Add route-level schema coverage for every GET/POST matrix row, including invalid JSON/content type/size/token/host/origin/method and missing entities. Assert persistence and runtime effects, not merely HTTP status. Contract tests must demonstrate the `instanceId`/`buildId` and error-code additions before the frontend depends on them. A test that mocks `send()` to always succeed cannot cover B02.

### Proposed performance gates

Record the old implementation first on the same machine/browser/profile and fixture, then compare the production React build. Save a trace and request count per scenario. Use fixed viewport, clock and synthetic engine event rate; exclude real model latency. Three warm runs plus one cold start, reporting the median, are enough for a local single-user tool. Heap measurement is covered by A28.

| Metric | Proposed initial acceptance target |
| --- | --- |
| Cold fixture startup | usable selected conversation within 1.5 seconds on a documented reference laptop; no regression greater than 10% against measured old baseline without explanation |
| Interaction responsiveness | p95 click/key-to-paint below 100 ms during heavy fixture streaming; no input-loss or focus-loss events |
| Streaming render | at most one visual batch per animation frame; nonselected row components do not commit unless their visible data/clock changes |
| Main-thread work | no repeated long tasks over 50 ms during steady text streaming; expensive initial Markdown parse measured separately and optimized if blocking |
| Request coordination | one in-flight GET per resource; invalidation bursts coalesce; settled resources use 304, not repeated full body transfer |
| Idle page | no continuous animation-frame polling and no root-wide second-by-second redraw; hidden tab cosmetic work near zero |
| Bundle | target initial compressed JS ≤250 KiB, with Markdown/highlight work split if necessary; measure actual output and justify exceptions before release |
| Memory | after 100 selection/modal cycles and GC stabilization, heap within 10% of post-warm-up steady state; cache/URL/listener counts bounded |

Targets are deliberately measurable, not promises that React alone will improve speed. If the old page already beats a target, do not use the target to justify regression. Do not optimize by omitting messages, tools, controls, project sections or accessibility behavior.

## 12. Implementation work packages and completion gates

1. **Baseline and fixtures.** Inventory current dirty-tree changes and browser screenshots, capture API fixtures/errors, map old tests, produce measured baseline. Gate: all F IDs have fixture coverage and pending behavior explicitly preserved.
2. **Contracts.** Phase 0 PRs (B01 to B08) are merged. Add `instanceId`/`buildId`/capabilities and typed error codes; define frontend schemas from captured fixtures. Gate: route contracts pass; frontend assumptions are true.
3. **Build and transport foundation.** Vite/TypeScript/React shell, styles/token port, query client, conditional cache, SSE/recovery, preferences, test harness and manifest serving. Gate: isolated app boots under production security headers and packages successfully.
4. **Complete application surfaces.** Build shell/list/inspector/delegations, launch/team editor, conversation/composer/approvals, then Today/Projects/Progress, then Search/Connections/Settings/archive/update. Share primitives and domain selectors, not mutable feature state. Gate: each F item and A01 to A23 passes before claiming parity.
5. **Stress and cutover readiness.** Race/reconnect/storage tests A24 to A28, browser/visual/a11y/performance gates, package/startup test A29, saved-state upgrade rehearsal. Gate: no unresolved data-loss, duplicate-action, hidden-write, inaccessible-control or critical rendering failure.
6. **Single production entry and release.** Delete obsolete browser globals/scripts and stale vendor build after mapped tests exist; update docs/CI/prepack/static allowlist; verify no mixed legacy view path. Gate: all production views are React, all acceptance evidence reviewed, complete tarball passes.

Completion means behavior parity for the entire inventory, merged Phase 0 fixes, retained minimalist design, quantified responsiveness, coherent package assets, and safe operational recovery. Partial tab migration, a green typecheck alone, static screenshots without working actions, or removal of failing old tests do not satisfy this plan.

## 13. Review decisions and remaining evidence

Architecture, React+TypeScript, retained Node backend, minimalist design and single production cutover are treated as the user's decisions. Splitting backend fixes into Phase 0 and keeping the durability rework out of scope are review decisions from 2026-10-06. Implementation-level choices in this document (query cache option, `dist/` manifest-backed Vite build, typed additions, active-project cap, deliverable ID format and benchmark budgets) are proposed concrete defaults to review with the code, not claims of existing functionality.

Before coding, the remaining evidence to collect is a real browser baseline, exact final working-tree revision, fixture schema snapshots for less common lifecycle variants, dependency versions compatible with Node 22, and the TanStack-vs-store spike result. Proof of rollback for deliverable identity belongs to the B04 PR. These are implementation prerequisites that can be gathered autonomously in an isolated environment; they do not justify silently reducing scope or shipping an incomplete frontend.
