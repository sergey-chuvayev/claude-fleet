import { describe, expect, it } from 'vitest'
import type { ManagedId, ProjectId, TranscriptId } from '../domain/ids'
import { sessionKey } from '../domain/ids'
import { AppStore } from './AppStore'
import { PreferenceStore } from './preferences'
import { MemoryStorage } from '../test/shell'
import { shortcutFor } from './shortcuts'
import { type AppState, type Selection, type SelectionCandidate, appReducer, initialState, reconcile, selectionKey, selectionOf } from './state'

const managed = (id: string): Selection => ({ kind: 'managed', managedId: id as ManagedId })
const row = (id: string, delegations?: string[]): SelectionCandidate => ({ selection: managed(id), ...(delegations ? { delegations } : {}) })
const keys = (rows: SelectionCandidate[]) => rows.map(r => selectionKey(r.selection))

describe('selection identity', () => {
  it('matches the list key for managed and external rows; pid only without a transcript', () => {
    const rows = [
      { managedId: 'm1', sessionId: 't1' },
      { sessionId: 't2', engine: 'codex' as const },
      { sessionId: 't3' },
      { pid: 42 },
    ]
    for (const r of rows) expect(selectionKey(selectionOf(r))).toBe(sessionKey(r))
    expect(selectionOf({ sessionId: 't3' })).toEqual({ kind: 'external', engine: 'claude', transcriptId: 't3' as TranscriptId, pid: null })
  })
})

describe('reconcile (selection fallback)', () => {
  const list = [row('a'), row('b', ['d1', 'd2']), row('c')]

  it('keeps a selection that is still listed, as the same object', () => {
    const current = managed('b')
    expect(reconcile(current, list, keys(list))).toBe(current)
  })

  it('selects the first row when nothing is selected, unless asked not to', () => {
    expect(reconcile(null, list, [])).toEqual(managed('a'))
    expect(reconcile(null, list, [], 'none')).toBeNull()
    expect(reconcile(managed('a'), [], ['a'])).toBeNull()
  })

  it('falls back to the row now at the lost one’s position, clamped to the end', () => {
    const before = keys([row('a'), row('b'), row('c')])
    expect(reconcile(managed('b'), [row('a'), row('c')], before)).toEqual(managed('c'))
    expect(reconcile(managed('c'), [row('a'), row('b')], before)).toEqual(managed('b'))
    // Never seen before: the first row.
    expect(reconcile(managed('zz'), [row('a'), row('b')], before)).toEqual(managed('a'))
  })

  it('a delegation falls back to its parent, and with the parent gone to the parent’s neighbour', () => {
    const delegation: Selection = { kind: 'delegation', parent: 'b' as ManagedId, delegationId: 'd2' }
    expect(reconcile(delegation, list, keys(list))).toBe(delegation)
    expect(reconcile(delegation, [row('a'), row('b', ['d1']), row('c')], keys(list))).toEqual(managed('b'))
    expect(reconcile(delegation, [row('a'), row('c')], keys(list))).toEqual(managed('c'))
  })
})

describe('appReducer', () => {
  const start = initialState()

  it('keeps one selection per view and returns the same state for no-ops', () => {
    let state: AppState = appReducer(start, { type: 'select', selection: managed('a') })
    state = appReducer(state, { type: 'select', selection: { kind: 'project-manager', projectId: 'p1' as ProjectId } })
    expect(state.selection.sessions).toEqual(managed('a'))
    expect(state.selection.projects).toEqual({ kind: 'project-manager', projectId: 'p1' })
    expect(state.view).toBe('sessions')
    expect(appReducer(state, { type: 'select', selection: managed('a') })).toBe(state)
    expect(appReducer(state, { type: 'navigate', view: 'sessions' })).toBe(state)
    expect(appReducer(state, { type: 'close-modal' })).toBe(state)
  })

  it('reveal switches to the view the selection belongs to', () => {
    const state = appReducer(start, { type: 'select', selection: { kind: 'day-thread', itemId: 'i1' as never }, reveal: true })
    expect(state.view).toBe('today')
  })

  it('reconcile records the order, so a later loss falls back nearby', () => {
    let state = appReducer(start, { type: 'reconcile', slot: 'sessions', rows: [row('a'), row('b'), row('c')] })
    expect(state.selection.sessions).toEqual(managed('a'))
    state = appReducer(state, { type: 'select', selection: managed('b') })
    state = appReducer(state, { type: 'reconcile', slot: 'sessions', rows: [row('a'), row('c')] })
    expect(state.selection.sessions).toEqual(managed('c'))
  })

  it('holds one modal; opening another replaces it; close by kind only closes that kind', () => {
    let state = appReducer(start, { type: 'open-modal', modal: { kind: 'search' } })
    state = appReducer(state, { type: 'open-modal', modal: { kind: 'launch' } })
    expect(state.modal).toEqual({ kind: 'launch' })
    expect(appReducer(state, { type: 'close-modal', kind: 'search' })).toBe(state)
    expect(appReducer(state, { type: 'close-modal', kind: 'launch' }).modal).toBeNull()
    // Opening a modal never touches the selection.
    expect(state.selection).toBe(start.selection)
  })

  it('an unknown view falls back to Sessions', () => {
    const state = appReducer({ ...start, view: 'today' }, { type: 'navigate', view: 'work' as never })
    expect(state.view).toBe('sessions')
  })
})

describe('AppStore persistence', () => {
  it('reads fleet:view, fleet:project and fleet:minimal-details-open, and writes only deliberate changes', () => {
    const storage = new MemoryStorage({ 'fleet:view': 'projects', 'fleet:project': 'p1', 'fleet:minimal-details-open': '0' })
    const store = new AppStore(new PreferenceStore(storage))
    expect(store.getState().view).toBe('projects')
    expect(store.getState().selection.projects).toEqual({ kind: 'project-manager', projectId: 'p1' })
    expect(store.getState().inspector).toBe(false)

    store.dispatch({ type: 'navigate', view: 'today' })
    expect(storage.getItem('fleet:view')).toBe('today')
    store.dispatch({ type: 'select', selection: { kind: 'project-manager', projectId: 'p2' as ProjectId } })
    expect(storage.getItem('fleet:project')).toBe('p2')
    // A reconcile fallback is not a choice: fleet:project stays.
    store.dispatch({ type: 'reconcile', slot: 'projects', rows: [{ selection: { kind: 'project-manager', projectId: 'p3' as ProjectId } }] })
    expect(store.getState().selection.projects).toEqual({ kind: 'project-manager', projectId: 'p3' })
    expect(storage.getItem('fleet:project')).toBe('p2')
    store.dispatch({ type: 'set-inspector', open: true })
    expect(storage.getItem('fleet:minimal-details-open')).toBe('1')
  })

  it('notifies once per change and not for no-ops', () => {
    const store = new AppStore(new PreferenceStore(new MemoryStorage()))
    let calls = 0
    store.subscribe(() => calls++)
    store.dispatch({ type: 'navigate', view: 'sessions' })
    store.dispatch({ type: 'navigate', view: 'today' })
    expect(calls).toBe(1)
  })
})

describe('shortcutFor', () => {
  const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods })
  it('maps Cmd/Ctrl+N and Cmd/Ctrl+K, nothing else', () => {
    expect(shortcutFor(key('n', { metaKey: true }))).toBe('launch')
    expect(shortcutFor(key('N', { ctrlKey: true }))).toBe('launch')
    expect(shortcutFor(key('k', { metaKey: true }))).toBe('search')
    expect(shortcutFor(key('k'))).toBeNull()
    expect(shortcutFor(key('k', { metaKey: true, shiftKey: true }))).toBeNull()
    expect(shortcutFor(key('n', { ctrlKey: true, altKey: true }))).toBeNull()
    expect(shortcutFor(key('j', { metaKey: true }))).toBeNull()
  })
})
