// The app reducer: which view is showing, what is selected in each view, which modal
// is open and whether the operator chose to show or hide the inspector. Nothing from
// the server lives here (that is the transport store's job); only identities.
//
// Pure. Persistence of the deliberate choices (view, project, inspector) happens in
// AppStore.dispatch, once per action, never inside the reducer.
import type { DayItemId, ManagedId, ProjectId, TranscriptId } from '../domain/ids'
import type { Engine, SessionSummary } from '../transport/contracts'
import { VIEWS, type View } from './preferences'

// ── Selection ───────────────────────────────────────────────────────────────

/**
 * What the operator is looking at. PID is metadata, not identity: an external row is
 * its engine plus transcript id, and only a live process that has not reported a
 * transcript yet falls back to its pid.
 */
export type Selection =
  | { readonly kind: 'managed'; readonly managedId: ManagedId }
  | {
      readonly kind: 'external'
      readonly engine: Engine
      readonly transcriptId: TranscriptId | null
      readonly pid: number | null
    }
  | { readonly kind: 'delegation'; readonly parent: ManagedId; readonly delegationId: string }
  /** An item's conversation on the Day board. */
  | { readonly kind: 'day-thread'; readonly itemId: DayItemId }
  | { readonly kind: 'project-manager'; readonly projectId: ProjectId }

export type SelectionKind = Selection['kind']

/** The views that hold a selection, and which one each selection belongs to. */
export const SELECTION_SLOTS = ['sessions', 'today', 'projects'] as const
export type SelectionSlot = (typeof SELECTION_SLOTS)[number]

export function slotOf(selection: Selection): SelectionSlot {
  switch (selection.kind) {
    case 'day-thread':
      return 'today'
    case 'project-manager':
      return 'projects'
    default:
      return 'sessions'
  }
}

/**
 * A string identity for a selection. For managed and external sessions it equals
 * `sessionKey(row)` from domain/ids, so a row and its selection compare directly.
 */
export function selectionKey(selection: Selection): string {
  switch (selection.kind) {
    case 'managed':
      return `managed:${selection.managedId}`
    case 'external':
      return selection.transcriptId ? `${selection.engine}:${selection.transcriptId}` : `pid:${selection.pid ?? 'unknown'}`
    case 'delegation':
      return `delegation:${selection.parent}:${selection.delegationId}`
    case 'day-thread':
      return `day-thread:${selection.itemId}`
    case 'project-manager':
      return `project:${selection.projectId}`
  }
}

/** The selection a session row stands for. */
export function selectionOf(session: Pick<SessionSummary, 'managedId' | 'sessionId' | 'engine' | 'pid'>): Selection {
  if (session.managedId) return { kind: 'managed', managedId: session.managedId as ManagedId }
  return {
    kind: 'external',
    engine: session.engine ?? 'claude',
    transcriptId: (session.sessionId ?? null) as TranscriptId | null,
    pid: session.pid ?? null,
  }
}

export const sameSelection = (a: Selection | null, b: Selection | null): boolean =>
  a === b || (!!a && !!b && selectionKey(a) === selectionKey(b))

/**
 * A row the current view can select, in display order. A managed row lists the
 * delegations nested under it, so a selected delegation can be checked for.
 */
export interface SelectionCandidate {
  readonly selection: Selection
  readonly delegations?: readonly string[]
}

// ── Modals ──────────────────────────────────────────────────────────────────

export type ModalState =
  | { readonly kind: 'launch' }
  | { readonly kind: 'search' }
  /** From the toolbar (no session) or from a managed session's header. */
  | { readonly kind: 'connections'; readonly managedId: ManagedId | null }
  | { readonly kind: 'settings' }
  | { readonly kind: 'clear-worktree'; readonly path: string }

export type ModalKind = ModalState['kind']

// ── State and actions ───────────────────────────────────────────────────────

export interface AppState {
  readonly view: View
  /** One remembered selection per view that has one, so switching views keeps each. */
  readonly selection: { readonly [S in SelectionSlot]: Selection | null }
  /** The order the last reconcile saw per view, for the nearby fallback. */
  readonly order: { readonly [S in SelectionSlot]: readonly string[] }
  /** One modal layer at most. Opening another replaces it. */
  readonly modal: ModalState | null
  /** The operator's explicit inspector choice; null follows the viewport width. */
  readonly inspector: boolean | null
}

export type AppAction =
  | { readonly type: 'navigate'; readonly view: View }
  /**
   * Select in the view the selection belongs to. `reveal` also switches to that view
   * (a Today launch chip opening its session). null clears the given view's selection.
   */
  | { readonly type: 'select'; readonly selection: Selection; readonly reveal?: boolean }
  | { readonly type: 'clear-selection'; readonly slot: SelectionSlot }
  /**
   * The rows a view currently shows, in order. Keeps the selection when it is still
   * there, otherwise falls back deterministically (see `reconcile`).
   */
  | {
      readonly type: 'reconcile'
      readonly slot: SelectionSlot
      readonly rows: readonly SelectionCandidate[]
      /** 'first' (the session list) selects the first row when nothing is selected; 'none' leaves it empty. */
      readonly empty?: 'first' | 'none'
    }
  | { readonly type: 'open-modal'; readonly modal: ModalState }
  /** Close the open modal; with `kind`, only when that modal is the open one. */
  | { readonly type: 'close-modal'; readonly kind?: ModalKind }
  | { readonly type: 'set-inspector'; readonly open: boolean }

export interface InitialState {
  readonly view?: View
  readonly project?: string | null
  readonly inspector?: boolean | null
}

export function initialState(init: InitialState = {}): AppState {
  return {
    view: init.view && VIEWS.includes(init.view) ? init.view : 'sessions',
    selection: {
      sessions: null,
      today: null,
      projects: init.project ? { kind: 'project-manager', projectId: init.project as ProjectId } : null,
    },
    order: { sessions: [], today: [], projects: [] },
    modal: null,
    inspector: init.inspector ?? null,
  }
}

/**
 * Where a selection goes when what it pointed at is gone.
 *
 * - Still present: kept, the same object.
 * - A delegation whose parent is still listed: the parent (a finished sub-agent hands
 *   focus back to its manager; an aged-out one is the list's job to keep drawing).
 * - Otherwise the row now at the index the lost one had, clamped to the end of the
 *   list, so focus stays where the operator's eyes were; null when the list is empty.
 * - Nothing selected: the first row (`empty: 'first'`) or nothing.
 */
export function reconcile(
  current: Selection | null,
  rows: readonly SelectionCandidate[],
  previousOrder: readonly string[],
  empty: 'first' | 'none' = 'first',
): Selection | null {
  if (!rows.length) return null
  if (!current) return empty === 'first' ? rows[0]!.selection : null
  const key = selectionKey(current)
  if (current.kind === 'delegation') {
    const parentKey = `managed:${current.parent}`
    const parent = rows.find(row => selectionKey(row.selection) === parentKey)
    if (parent) return parent.delegations?.includes(current.delegationId) ? current : parent.selection
    return nearby(parentKey, rows, previousOrder)
  }
  if (rows.some(row => selectionKey(row.selection) === key)) return current
  return nearby(key, rows, previousOrder)
}

function nearby(lostKey: string, rows: readonly SelectionCandidate[], previousOrder: readonly string[]): Selection {
  const index = previousOrder.indexOf(lostKey)
  const at = index < 0 ? 0 : Math.min(index, rows.length - 1)
  return rows[at]!.selection
}

function withSelection(state: AppState, slot: SelectionSlot, next: Selection | null): AppState {
  const current = state.selection[slot]
  // The same identity keeps the same object, so selectors comparing by reference hold.
  if (sameSelection(current, next)) return state
  return { ...state, selection: { ...state.selection, [slot]: next } }
}

const sameOrder = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((k, i) => k === b[i])

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'navigate': {
      const view = VIEWS.includes(action.view) ? action.view : 'sessions'
      return view === state.view ? state : { ...state, view }
    }
    case 'select': {
      const slot = slotOf(action.selection)
      const next = withSelection(state, slot, action.selection)
      return action.reveal && next.view !== slot ? { ...next, view: slot } : next
    }
    case 'clear-selection':
      return withSelection(state, action.slot, null)
    case 'reconcile': {
      const order = action.rows.map(row => selectionKey(row.selection))
      const next = reconcile(state.selection[action.slot], action.rows, state.order[action.slot], action.empty)
      const selected = withSelection(state, action.slot, next)
      if (sameOrder(state.order[action.slot], order)) return selected
      return { ...selected, order: { ...selected.order, [action.slot]: order } }
    }
    case 'open-modal':
      return state.modal && state.modal.kind === action.modal.kind && sameModal(state.modal, action.modal)
        ? state
        : { ...state, modal: action.modal }
    case 'close-modal':
      if (!state.modal || (action.kind && state.modal.kind !== action.kind)) return state
      return { ...state, modal: null }
    case 'set-inspector':
      return state.inspector === action.open ? state : { ...state, inspector: action.open }
  }
}

const sameModal = (a: ModalState, b: ModalState) => JSON.stringify(a) === JSON.stringify(b)
