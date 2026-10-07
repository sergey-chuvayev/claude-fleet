// The three ways a request can fail, kept apart so callers can tell them apart:
// the server answered with an error status, the answer broke the sync protocol, or
// the answer arrived but does not have the shape this client relies on.

/**
 * The server answered with a non-2xx status. `message` is the server's `error` text;
 * `code` and `retryable` are its machine-readable fields (server.js ERROR_CODES), null
 * and false when the answer did not carry them. Branch on `code`, never on the text.
 */
export class HttpError extends Error {
  override readonly name = 'HttpError'
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown = null,
    readonly code: string | null = null,
    readonly retryable = false,
  ) {
    super(message)
  }
}

/** The conditional-GET protocol could not be completed (unplaceable fingerprints, unexpected 304, unreadable JSON). */
export class ProtocolError extends Error {
  override readonly name = 'ProtocolError'
}

/** A response parsed as JSON but failed runtime validation at the boundary. */
export class ContractError extends Error {
  override readonly name = 'ContractError'
  constructor(
    readonly resource: string,
    readonly issues: string,
  ) {
    super(`Unexpected ${resource} response from Fleet: ${issues}`)
  }
}

export const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError'

/** The text to show for a failed request. */
export const errorText = (error: unknown, fallback = 'The request failed.'): string =>
  error instanceof Error && error.message ? error.message : fallback

export const isNotFound = (error: unknown): boolean => error instanceof HttpError && error.status === 404

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Read `{error}` from a failed response without trusting its body. */
export async function httpErrorFrom(response: Response): Promise<HttpError> {
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  const record: Record<string, unknown> = isRecord(body) ? body : {}
  const text = typeof record.error === 'string' ? record.error : `HTTP ${response.status}`
  const code = typeof record.code === 'string' ? record.code : null
  return new HttpError(response.status, text, body, code, record.retryable === true)
}

/**
 * One signal that aborts when the caller's signal does or when `ms` elapses.
 * The timeout aborts with a TimeoutError, so it surfaces as a failure, not as a cancel.
 */
export function withTimeout(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal?.reason)
  if (signal?.aborted) controller.abort(signal.reason)
  else signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    const error = new Error(`Fleet did not answer within ${Math.round(ms / 1000)} seconds.`)
    error.name = 'TimeoutError'
    controller.abort(error)
  }, ms)
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}
