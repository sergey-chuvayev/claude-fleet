import { describe, expect, it } from 'vitest'
import { COLLAPSED_LIMIT, PreferenceStore, SEEN_LIMIT, STORAGE_KEYS, type StorageLike, readPreferences } from './preferences'

function memory(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: key => void data.delete(key),
  }
}

const throwing: StorageLike = {
  getItem: () => {
    throw new Error('SecurityError')
  },
  setItem: () => {
    throw new Error('QuotaExceededError')
  },
  removeItem: () => {
    throw new Error('SecurityError')
  },
}

describe('readPreferences', () => {
  it('gives defaults when storage is missing or throws', () => {
    for (const storage of [null, throwing]) {
      const prefs = readPreferences(storage)
      expect(prefs.view).toBe('sessions')
      expect(prefs.seen).toEqual({})
      expect(prefs.childrenCollapsed).toEqual([])
      expect(prefs.split).toBeNull()
      expect(prefs.detailsOpen).toBeNull()
    }
  })

  it('falls back to Sessions for a removed or garbage view, and keeps current ones', () => {
    expect(readPreferences(memory({ 'fleet:view': 'queue' })).view).toBe('sessions')
    expect(readPreferences(memory({ 'fleet:view': '<script>' })).view).toBe('sessions')
    for (const view of ['today', 'projects', 'progress', 'worktrees', 'sessions']) {
      expect(readPreferences(memory({ 'fleet:view': view })).view).toBe(view)
    }
  })

  it('clamps sizes and rejects nonsense', () => {
    const prefs = readPreferences(
      memory({
        'fleet:minimal-split': '30.5',
        'fleet:today-split': '250',
        'fleet:minimal-composer-height': '40',
        'fleet:overview-height': 'NaN',
      }),
    )
    expect(prefs.split).toBe(30.5)
    expect(prefs.todaySplit).toBeNull()
    expect(prefs.composerHeight).toBe(110)
    expect(prefs.overviewHeight).toBeNull()
    expect(readPreferences(memory({ 'fleet:minimal-composer-height': '99999' })).composerHeight).toBe(4000)
    expect(readPreferences(memory({ 'fleet:minimal-split': '-4' })).split).toBeNull()
  })

  it('reads corrupted JSON as empty, and bounds the maps to their newest entries', () => {
    expect(readPreferences(memory({ 'fleet:seen': '{not json' })).seen).toEqual({})
    expect(readPreferences(memory({ 'fleet:children-collapsed': '{"a":1}' })).childrenCollapsed).toEqual([])
    const seen = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`s${i}`, i]))
    const read = readPreferences(memory({ 'fleet:seen': JSON.stringify({ ...seen, bad: 'x' }) })).seen
    expect(Object.keys(read)).toHaveLength(SEEN_LIMIT)
    expect(read.s299).toBe(299)
    expect(read.s0).toBeUndefined()
    expect(read.bad).toBeUndefined()
    const folds = Array.from({ length: 250 }, (_, i) => `k${i}`)
    const collapsed = readPreferences(memory({ 'fleet:children-collapsed': JSON.stringify([...folds, 7, 'k249']) })).childrenCollapsed
    expect(collapsed).toHaveLength(COLLAPSED_LIMIT)
    expect(collapsed.at(-1)).toBe('k249')
  })

  it('accepts only plausible project ids, cwd text and worktree filters', () => {
    const prefs = readPreferences(
      memory({ 'fleet:project': 'p-1_a', 'fleet:launch-cwd': '~/projects/x', 'fleet:worktrees-filter': 'merged', 'fleet:minimal-details-open': '0' }),
    )
    expect(prefs).toMatchObject({ project: 'p-1_a', launchCwd: '~/projects/x', worktreesFilter: 'merged', detailsOpen: false })
    expect(readPreferences(memory({ 'fleet:project': '../etc' })).project).toBeNull()
    expect(readPreferences(memory({ 'fleet:worktrees-filter': 'everything' })).worktreesFilter).toBe('all')
    expect(readPreferences(memory({ 'fleet:launch-cwd': 'x'.repeat(5000) })).launchCwd).toBeNull()
  })
})

describe('PreferenceStore', () => {
  it('reads once and writes only deliberate changes, in the legacy format', () => {
    const storage = memory({ 'fleet:view': 'today' })
    const prefs = new PreferenceStore(storage)
    expect(storage.data.size).toBe(1)
    prefs.set('view', 'projects')
    prefs.set('detailsOpen', true)
    prefs.set('split', 25)
    expect(storage.data.get(STORAGE_KEYS.view)).toBe('projects')
    expect(storage.data.get(STORAGE_KEYS.detailsOpen)).toBe('1')
    expect(storage.data.get(STORAGE_KEYS.split)).toBe('25')
    prefs.set('detailsOpen', null)
    expect(storage.data.has(STORAGE_KEYS.detailsOpen)).toBe(false)
  })

  it('validates on write: an out-of-range value is dropped rather than stored', () => {
    const storage = memory({ 'fleet:minimal-split': '30' })
    const prefs = new PreferenceStore(storage)
    prefs.set('split', 500)
    expect(prefs.get().split).toBeNull()
    expect(storage.data.has(STORAGE_KEYS.split)).toBe(false)
    prefs.set('composerHeight', 20)
    expect(storage.data.get(STORAGE_KEYS.composerHeight)).toBe('110')
  })

  it('keeps working in memory when storage refuses writes', () => {
    const prefs = new PreferenceStore(throwing)
    prefs.set('view', 'progress')
    expect(prefs.get().view).toBe('progress')
  })

  it('bounds seen and collapsed maps as the legacy UI did', () => {
    const storage = memory()
    const prefs = new PreferenceStore(storage)
    for (let i = 0; i < 210; i++) prefs.markSeen(`s${i}`, i)
    expect(Object.keys(JSON.parse(storage.data.get(STORAGE_KEYS.seen) ?? '{}'))).toHaveLength(SEEN_LIMIT)
    prefs.setChildrenCollapsed('a', true)
    prefs.setChildrenCollapsed('b', true)
    prefs.setChildrenCollapsed('a', false)
    expect(JSON.parse(storage.data.get(STORAGE_KEYS.childrenCollapsed) ?? '[]')).toEqual(['b'])
  })
})
