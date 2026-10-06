// The browser-remembered preferences, under the same `fleet:*` keys and in the same
// string formats the legacy UI wrote, so switching UIs loses nothing. Read once at
// boot, validated and clamped; written only on a deliberate change. Storage that is
// missing, blocked (private window) or full costs the remembered value, nothing else.
// Credentials and the control token never belong here.

export const VIEWS = ['today', 'projects', 'sessions', 'progress', 'worktrees'] as const
export type View = (typeof VIEWS)[number]

export const WORKTREE_FILTERS = ['all', 'clearable', 'merged', 'pr', 'care'] as const
export type WorktreeFilter = (typeof WORKTREE_FILTERS)[number]

export const STORAGE_KEYS = {
  view: 'fleet:view',
  project: 'fleet:project',
  launchCwd: 'fleet:launch-cwd',
  seen: 'fleet:seen',
  childrenCollapsed: 'fleet:children-collapsed',
  split: 'fleet:minimal-split',
  todaySplit: 'fleet:today-split',
  composerHeight: 'fleet:minimal-composer-height',
  overviewHeight: 'fleet:overview-height',
  detailsOpen: 'fleet:minimal-details-open',
  worktreesFilter: 'fleet:worktrees-filter',
} as const

/** Both maps are bounded the way the legacy UI bounded them. */
export const SEEN_LIMIT = 200
export const COLLAPSED_LIMIT = 200
/** Panel minimums from the legacy splitters; the upper bound only rejects nonsense. */
export const COMPOSER_MIN = 110
export const OVERVIEW_MIN = 90
const PANEL_MAX = 4000
const TEXT_MAX = 4096

export interface Preferences {
  readonly view: View
  readonly project: string | null
  readonly launchCwd: string | null
  /** Legacy session key to the activity timestamp last seen. */
  readonly seen: Readonly<Record<string, number>>
  /** Legacy session keys whose delegation rows are folded. */
  readonly childrenCollapsed: readonly string[]
  /** Percent of the workspace; null means "use the view default". Pixel clamping happens at layout time. */
  readonly split: number | null
  readonly todaySplit: number | null
  readonly composerHeight: number | null
  readonly overviewHeight: number | null
  /** null means "no explicit choice": the inspector follows the viewport width. */
  readonly detailsOpen: boolean | null
  readonly worktreesFilter: WorktreeFilter
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** The browser's localStorage, or null when touching it throws. */
export function browserStorage(): StorageLike | null {
  try {
    const storage = globalThis.localStorage
    return storage ?? null
  } catch {
    return null
  }
}

function read(storage: StorageLike | null, key: string): string | null {
  if (!storage) return null
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

function json(raw: string | null): unknown {
  if (raw === null) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

const oneOf = <T extends string>(values: readonly T[], raw: string | null, fallback: T): T =>
  values.find(value => value === raw) ?? fallback

function text(raw: string | null): string | null {
  return raw && raw.length <= TEXT_MAX ? raw : null
}

const PROJECT_ID = /^[\w-]{1,200}$/

function percent(raw: string | null): number | null {
  if (raw === null) return null
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 && value <= 100 ? value : null
}

function pixels(raw: string | null, min: number): number | null {
  if (raw === null) return null
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return null
  return Math.min(Math.max(Math.round(value), min), PANEL_MAX)
}

/** Keep the newest `limit` entries by timestamp, as markSeen did. */
export function boundSeen(seen: Readonly<Record<string, number>>, limit = SEEN_LIMIT): Record<string, number> {
  return Object.fromEntries(
    Object.entries(seen)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit),
  )
}

function seenMap(raw: unknown): Record<string, number> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key && typeof value === 'number' && Number.isFinite(value)) out[key] = value
  }
  return boundSeen(out)
}

function keyList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.filter((key): key is string => typeof key === 'string' && key.length > 0))].slice(-COLLAPSED_LIMIT)
}

/** Read and validate every preference. Never throws. */
export function readPreferences(storage: StorageLike | null): Preferences {
  const project = read(storage, STORAGE_KEYS.project)
  const details = read(storage, STORAGE_KEYS.detailsOpen)
  return {
    // A removed view (the old Work queue) or garbage falls back to Sessions.
    view: oneOf(VIEWS, read(storage, STORAGE_KEYS.view), 'sessions'),
    project: project && PROJECT_ID.test(project) ? project : null,
    launchCwd: text(read(storage, STORAGE_KEYS.launchCwd)),
    seen: seenMap(json(read(storage, STORAGE_KEYS.seen))),
    childrenCollapsed: keyList(json(read(storage, STORAGE_KEYS.childrenCollapsed))),
    split: percent(read(storage, STORAGE_KEYS.split)),
    todaySplit: percent(read(storage, STORAGE_KEYS.todaySplit)),
    composerHeight: pixels(read(storage, STORAGE_KEYS.composerHeight), COMPOSER_MIN),
    overviewHeight: pixels(read(storage, STORAGE_KEYS.overviewHeight), OVERVIEW_MIN),
    detailsOpen: details === '1' ? true : details === '0' ? false : null,
    worktreesFilter: oneOf(WORKTREE_FILTERS, read(storage, STORAGE_KEYS.worktreesFilter), 'all'),
  }
}

type Key = keyof Preferences

/** How each preference is written back, in the legacy format; null removes the key. */
const writers: { readonly [K in Key]: (value: Preferences[K]) => string | null } = {
  view: value => value,
  project: value => value,
  launchCwd: value => value,
  seen: value => JSON.stringify(boundSeen(value)),
  childrenCollapsed: value => JSON.stringify(value.slice(-COLLAPSED_LIMIT)),
  split: value => (value === null ? null : String(value)),
  todaySplit: value => (value === null ? null : String(value)),
  composerHeight: value => (value === null ? null : String(value)),
  overviewHeight: value => (value === null ? null : String(value)),
  detailsOpen: value => (value === null ? null : value ? '1' : '0'),
  worktreesFilter: value => value,
}

/**
 * Preferences held in memory after one read. `set` validates through the same rules
 * as reading (by round-tripping the serialized value), updates memory, then writes.
 */
export class PreferenceStore {
  private current: Preferences
  private readonly listeners = new Set<() => void>()

  constructor(private readonly storage: StorageLike | null = browserStorage()) {
    this.current = readPreferences(storage)
  }

  get = (): Preferences => this.current

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  set<K extends Key>(key: K, value: Preferences[K]): void {
    const storageKey = STORAGE_KEYS[key]
    // Validate by reading the written form back through the same rules as boot.
    const parsed = readPreferences({
      getItem: k => (k === storageKey ? writers[key](value) : null),
      setItem: () => {},
      removeItem: () => {},
    })[key]
    this.current = { ...this.current, [key]: parsed }
    const raw = writers[key](parsed)
    try {
      if (raw === null) this.storage?.removeItem(storageKey)
      else this.storage?.setItem(storageKey, raw)
    } catch {
      // Full or blocked storage: the value still holds for this page.
    }
    for (const listener of [...this.listeners]) listener()
  }

  /** Mark a session's activity as seen; bounded to the newest SEEN_LIMIT. */
  markSeen(legacyKey: string, at: number): void {
    if (!legacyKey || !Number.isFinite(at) || this.current.seen[legacyKey] === at) return
    this.set('seen', { ...this.current.seen, [legacyKey]: at })
  }

  setChildrenCollapsed(legacyKey: string, collapsed: boolean): void {
    const rest = this.current.childrenCollapsed.filter(key => key !== legacyKey)
    this.set('childrenCollapsed', collapsed ? [...rest, legacyKey] : rest)
  }
}
