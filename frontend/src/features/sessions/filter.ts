// The session list's filter: a status and a creation date. Not remembered between
// visits (legacy kept it in memory too), but shared, so another feature (Search's
// "Open in Fleet", B08) can reset it to All before selecting a session without
// reaching into this pane's state.
import { useSyncExternalStore } from 'react'
import type { DateFilter, StatusFilter } from '../../domain/sessions'

export interface SessionFilter {
  readonly status: StatusFilter
  readonly date: DateFilter
}

const ALL: SessionFilter = { status: 'all', date: 'all' }
let current: SessionFilter = ALL
const listeners = new Set<() => void>()

export const getSessionFilter = (): SessionFilter => current

export function setSessionFilter(next: Partial<SessionFilter>): void {
  const merged = { ...current, ...next }
  if (merged.status === current.status && merged.date === current.date) return
  current = merged
  for (const listener of [...listeners]) listener()
}

/** Show every foreground session again (Search's Open in Fleet). */
export const showAllSessions = (): void => setSessionFilter(ALL)

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useSessionFilter(): SessionFilter {
  return useSyncExternalStore(subscribe, getSessionFilter, getSessionFilter)
}

/** Tests: start every case from All. */
export const resetSessionFilter = (): void => {
  current = ALL
}
