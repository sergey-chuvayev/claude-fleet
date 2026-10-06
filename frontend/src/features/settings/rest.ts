// GET helper for the routes the FleetClient does not own (search jobs, update, service,
// settings). The client only exposes POST; these reads are small, uncached and have
// no conditional protocol, so they go through the page's fetch, looked up at call
// time so a test can replace it. TODO: fold into FleetClient as `client.get` and
// delete this file.
import { HttpError, ProtocolError, httpErrorFrom, withTimeout } from '../../transport/errors'

export async function getJson(path: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
  const timed = withTimeout(options.signal, options.timeoutMs ?? 8000)
  try {
    const response = await globalThis.fetch(path, { cache: 'no-store', signal: timed.signal })
    if (!response.ok) throw await httpErrorFrom(response)
    try {
      return await response.json()
    } catch {
      throw new ProtocolError(`Fleet sent an unreadable answer for ${path}.`)
    }
  } finally {
    timed.done()
  }
}

/** The text to show for a failed request. */
export const errorText = (error: unknown, fallback = 'The request failed.'): string =>
  error instanceof Error && error.message ? error.message : fallback

export const isNotFound = (error: unknown): boolean => error instanceof HttpError && error.status === 404
