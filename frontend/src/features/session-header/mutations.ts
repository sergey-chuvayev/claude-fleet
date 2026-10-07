// Commands on one managed session: POST, publish the authoritative `{session}` answer
// into the store, invalidate what the change makes out of date. Never retried: after a
// failure the caller shows why and the session is refetched to reconcile, so an
// ambiguous network error never sends a command twice (plan section 7).
import type { FleetClient } from '../../transport/client'
import { type ManagedDetail, parseSessionAnswer } from '../../transport/contracts'
import { HttpError, isAbortError } from '../../transport/errors'
import { keys, mutationInvalidates } from '../../transport/resources'

export interface SessionCommandOptions {
  /** Keys beyond the session and the list (projects, for a tag change). */
  readonly also?: readonly string[]
  readonly signal?: AbortSignal
}

/** POST /api/managed/:id/<action>. Resolves with the session the server answered, if it sent one. */
export async function sessionCommand(
  client: FleetClient,
  managedId: string,
  action: string,
  body: Readonly<Record<string, unknown>>,
  options: SessionCommandOptions = {},
): Promise<ManagedDetail | null> {
  const path = `/api/managed/${encodeURIComponent(managedId)}/${action}`
  let raw: unknown
  try {
    raw = await client.post(path, body, options.signal ? { signal: options.signal } : {})
  } catch (error) {
    // Whether or not it landed, the server's copy is the truth: read it again.
    client.store.invalidate(keys.managed(managedId))
    throw error
  }
  const detail = parseSessionAnswer(raw)
  if (detail && detail.session.id === managedId) {
    client.store.set(client.resources.managed(managedId), detail)
    client.store.invalidate(keys.sessions, ...(options.also ?? []))
  } else {
    client.store.invalidate(...mutationInvalidates.sessionChange(managedId), ...(options.also ?? []))
  }
  return detail
}

/** The error code the server sent, if any. */
export const codeOf = (error: unknown): string | null => (error instanceof HttpError ? error.code : null)

/**
 * Words for a failed command. A server answer carries its own sentence; a timeout or
 * a dropped connection is ambiguous, so it says the outcome is being checked instead
 * of claiming nothing happened.
 */
export function failureText(error: unknown): string {
  if (error instanceof HttpError) return error.message
  if (error instanceof Error && error.name === 'TimeoutError') return `${error.message} Checking what happened.`
  if (isAbortError(error)) return 'Cancelled.'
  if (error instanceof Error && error.name !== 'TypeError') return error.message
  return 'Fleet did not answer. Check that it is still running; the conversation is being read again.'
}
