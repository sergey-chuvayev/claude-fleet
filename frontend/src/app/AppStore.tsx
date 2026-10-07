// The app reducer behind a small external store, read through useSyncExternalStore
// with a selector, so a component re-renders only when the slice it reads changes
// (switching the modal does not re-render the session list). Dispatch runs the
// reducer once and then persists deliberate choices through the PreferenceStore.
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { PreferenceStore, Preferences } from './preferences'
import {
  type AppAction,
  type AppState,
  type ModalState,
  type Selection,
  type SelectionCandidate,
  type SelectionSlot,
  appReducer,
  initialState,
} from './state'

type Listener = () => void

export class AppStore {
  private state: AppState
  private readonly listeners = new Set<Listener>()

  constructor(readonly preferences: PreferenceStore) {
    const prefs = preferences.get()
    this.state = initialState({ view: prefs.view, project: prefs.project, inspector: prefs.detailsOpen })
  }

  getState = (): AppState => this.state

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispatch = (action: AppAction): void => {
    const next = appReducer(this.state, action)
    if (next === this.state) return
    const previous = this.state
    this.state = next
    this.persist(previous, next, action)
    for (const listener of [...this.listeners]) listener()
  }

  // Only what the operator chose: a reconcile fallback never rewrites fleet:project.
  private persist(previous: AppState, next: AppState, action: AppAction): void {
    if (next.view !== previous.view) this.preferences.set('view', next.view)
    if (action.type === 'select' && action.selection.kind === 'project-manager') {
      this.preferences.set('project', action.selection.projectId)
    }
    if (action.type === 'set-inspector') this.preferences.set('detailsOpen', action.open)
  }
}

const StoreContext = createContext<AppStore | null>(null)

export function AppStoreProvider({ store, children }: { store: AppStore; children: ReactNode }) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
}

export function useAppStore(): AppStore {
  const store = useContext(StoreContext)
  if (!store) throw new Error('useAppStore needs an AppStoreProvider above it.')
  return store
}

/** Read a slice of app state. The selector must return a stable value (a field, not a new object). */
export function useAppState<T>(selector: (state: AppState) => T): T {
  const store = useAppStore()
  const read = useCallback(() => selector(store.getState()), [store, selector])
  return useSyncExternalStore(store.subscribe, read, read)
}

export function useDispatch(): (action: AppAction) => void {
  return useAppStore().dispatch
}

export function usePreferences(): PreferenceStore {
  return useAppStore().preferences
}

/** One preference, re-rendering only when it changes. */
export function usePreference<K extends keyof Preferences>(key: K): Preferences[K] {
  const preferences = usePreferences()
  const read = useCallback(() => preferences.get()[key], [preferences, key])
  return useSyncExternalStore(preferences.subscribe, read, read)
}

// ── Selectors and intents, for feature code ─────────────────────────────────

const selectView = (s: AppState) => s.view
const selectModal = (s: AppState) => s.modal
const selectInspector = (s: AppState) => s.inspector
const selectionSelectors: { readonly [S in SelectionSlot]: (s: AppState) => Selection | null } = {
  sessions: s => s.selection.sessions,
  today: s => s.selection.today,
  projects: s => s.selection.projects,
}

export const useView = () => useAppState(selectView)
export const useModal = () => useAppState(selectModal)
export const useInspectorChoice = () => useAppState(selectInspector)
export const useSelection = (slot: SelectionSlot = 'sessions') => useAppState(selectionSelectors[slot])

/** The everyday intents, bound once. */
export function useActions() {
  const dispatch = useDispatch()
  return useMemo(
    () => ({
      navigate: (view: AppState['view']) => dispatch({ type: 'navigate', view }),
      select: (selection: Selection, options: { reveal?: boolean } = {}) =>
        dispatch({ type: 'select', selection, ...(options.reveal ? { reveal: true } : {}) }),
      clearSelection: (slot: SelectionSlot) => dispatch({ type: 'clear-selection', slot }),
      openModal: (modal: ModalState) => dispatch({ type: 'open-modal', modal }),
      closeModal: (kind?: ModalState['kind']) => dispatch(kind ? { type: 'close-modal', kind } : { type: 'close-modal' }),
      setInspector: (open: boolean) => dispatch({ type: 'set-inspector', open }),
    }),
    [dispatch],
  )
}

/**
 * Keep a view's selection pointing at something it shows. Call from the component
 * that owns the visible rows, with a memoized `rows` array.
 */
export function useReconcileSelection(
  slot: SelectionSlot,
  rows: readonly SelectionCandidate[] | null,
  empty: 'first' | 'none' = 'first',
): void {
  const dispatch = useDispatch()
  useEffect(() => {
    if (rows) dispatch({ type: 'reconcile', slot, rows, empty })
  }, [dispatch, slot, rows, empty])
}
