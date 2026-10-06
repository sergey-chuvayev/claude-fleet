// Branded identifiers, so a managed id cannot be passed where a transcript id is
// expected. Brands exist only at compile time; on the wire they are plain strings.
import type { Engine, SessionSummary } from '../transport/contracts'

declare const brand: unique symbol
type Brand<T, B extends string> = T & { readonly [brand]: B }

export type ManagedId = Brand<string, 'ManagedId'>
export type TranscriptId = Brand<string, 'TranscriptId'>
export type ProjectId = Brand<string, 'ProjectId'>
export type DayItemId = Brand<string, 'DayItemId'>
export type ApprovalId = Brand<string, 'ApprovalId'>

/** Stable React key and selection identity for a list row. */
export type SessionKey = Brand<string, 'SessionKey'>

export const engineOf = (session: Pick<SessionSummary, 'engine'>): Engine => session.engine ?? 'claude'

/**
 * A managed session keeps its managed id for life, so its key never switches to the
 * transcript id when one appears. External rows are qualified by engine. A PID is a
 * last resort for a live process that has not reported a transcript yet.
 */
export function sessionKey(session: Pick<SessionSummary, 'managedId' | 'sessionId' | 'engine' | 'pid'>): SessionKey {
  if (session.managedId) return `managed:${session.managedId}` as SessionKey
  if (session.sessionId) return `${engineOf(session)}:${session.sessionId}` as SessionKey
  return `pid:${session.pid ?? 'unknown'}` as SessionKey
}

/**
 * The key the legacy UI stored in `fleet:seen` and `fleet:children-collapsed`
 * (managedId, else sessionId, else `session:<pid>`). Use it only to read and write
 * those preferences, so a remembered fold survives the migration.
 */
export function legacySessionKey(session: Pick<SessionSummary, 'managedId' | 'sessionId' | 'pid'>): string {
  return session.managedId || session.sessionId || `session:${session.pid ?? ''}`
}

/** What a row is called: the renamed or AI title, the name, the short id. */
export function sessionLabel(session: Pick<SessionSummary, 'title' | 'name' | 'shortId'>): string {
  return session.title || session.name || session.shortId || 'Untitled session'
}
