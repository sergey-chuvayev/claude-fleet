// Conditional GET over Fleet's sync protocol (sync.js on the server). The page says
// what it holds; the server answers 304 when nothing changed, and otherwise sends
// list items the page already has as `{h}` (their fingerprint) alone. This module
// rebuilds the full answer from the previous one.
//
// Rules carried over from public/sync.js, plus the ones the migration plan adds:
//   - a 304 is never parsed as JSON; it means "keep what you have";
//   - a fingerprint that cannot be placed means the copies drifted: ask once more
//     without any conditional headers, then give up with a ProtocolError;
//   - a 431 (headers too large) gets the same single unconditional retry;
//   - the X-Fleet-Known header is bounded; past the bound it is left out and only
//     the ETag is sent;
//   - unchanged items keep their object identity, so React can skip them;
//   - previous values are never mutated.
import { HttpError, ProtocolError, httpErrorFrom, withTimeout } from './errors'

/** What one resource remembers between requests. Per resource, never shared across resources. */
export interface ConditionalState {
  /** The ETag of the last full answer, or null when the next request must not be a 304 candidate. */
  readonly tag: string | null
  /** Fingerprint to item, for every item in the packed arrays of the last answer. */
  readonly items: ReadonlyMap<string, unknown>
}

export type ConditionalOutcome =
  | { readonly kind: 'not-modified' }
  | { readonly kind: 'ok'; readonly value: unknown; readonly state: ConditionalState }

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface ConditionalRequest {
  readonly url: string
  /** Dotted paths of the arrays the server packs, e.g. `sessions` or `session.messages`. */
  readonly paths: readonly string[]
  /** State from the last successful answer. Pass it only while the caller still holds that answer. */
  readonly previous?: ConditionalState | undefined
  readonly fetch: FetchLike
  readonly signal?: AbortSignal | undefined
  readonly timeoutMs?: number
  readonly maxKnownBytes?: number
}

/**
 * Node's default limit is 16 KiB for the whole request head, and the browser adds its
 * own headers (and any localhost cookies) to it. 8000 bytes is about 470 fingerprints,
 * well above a session list or a 200-message window, and leaves the rest of the head
 * room to spare. The server's own parser cap (64000) is not what Node enforces.
 */
export const MAX_KNOWN_BYTES = 8000
const FINGERPRINT = /^[\w-]{16}$/

/** The X-Fleet-Known value for these items, or null when it would exceed the bound. */
export function knownHeader(items: ReadonlyMap<string, unknown>, maxBytes = MAX_KNOWN_BYTES): string | null {
  if (!items.size) return null
  const value = [...items.keys()].join(',')
  return value.length > maxBytes ? null : value
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function at(value: unknown, path: string): unknown {
  let current = value
  for (const key of path.split('.')) {
    if (!isRecord(current)) return undefined
    current = current[key]
  }
  return current
}

// Copy-on-write replacement along a dotted path; untouched branches keep identity.
function withAt(value: unknown, keys: readonly string[], replacement: unknown): unknown {
  const [key, ...rest] = keys
  if (key === undefined || !isRecord(value) || !(key in value)) return value
  return { ...value, [key]: rest.length ? withAt(value[key], rest, replacement) : replacement }
}

const fingerprintOnly = (item: unknown): string | null =>
  isRecord(item) && typeof item.h === 'string' && Object.keys(item).length === 1 ? item.h : null

/**
 * Put packed arrays back together. Returns `lost: true` when some `{h}` names an item
 * the previous answer did not have. Full items whose fingerprint matches a previous
 * item are replaced by that previous object, so identity survives even an
 * unconditional refetch.
 */
export function reconstruct(
  data: unknown,
  paths: readonly string[],
  previous: ReadonlyMap<string, unknown> | undefined,
): { value: unknown; items: Map<string, unknown>; lost: boolean } {
  const items = new Map<string, unknown>()
  let value = data
  let lost = false
  for (const path of paths) {
    const list = at(data, path)
    if (!Array.isArray(list)) continue
    const rebuilt = list.map((item: unknown) => {
      const packed = fingerprintOnly(item)
      if (packed !== null) {
        const kept = previous?.get(packed)
        if (kept === undefined) {
          lost = true
          return item
        }
        items.set(packed, kept)
        return kept
      }
      if (isRecord(item) && typeof item.h === 'string' && FINGERPRINT.test(item.h)) {
        const same = previous?.get(item.h)
        const chosen = same === undefined ? item : same
        items.set(item.h, chosen)
        return chosen
      }
      return item
    })
    value = withAt(value, path.split('.'), rebuilt)
  }
  return { value, items, lost }
}

const RETRY = Symbol('retry')

/** One conditional GET, with at most one unconditional retry. */
export async function conditionalGet(request: ConditionalRequest): Promise<ConditionalOutcome> {
  const { url, paths, previous, signal, timeoutMs = 8000, maxKnownBytes = MAX_KNOWN_BYTES } = request

  const attempt = async (conditional: boolean): Promise<ConditionalOutcome | typeof RETRY> => {
    const headers: Record<string, string> = {}
    if (conditional && previous) {
      if (previous.tag) headers['if-none-match'] = previous.tag
      const known = knownHeader(previous.items, maxKnownBytes)
      if (known) headers['x-fleet-known'] = known
    }
    const timed = withTimeout(signal, timeoutMs)
    try {
      const response = await request.fetch(url, { cache: 'no-store', headers, signal: timed.signal })
      if (response.status === 304) {
        // Only meaningful when we offered a tag; otherwise the server and page disagree.
        return headers['if-none-match'] ? { kind: 'not-modified' } : RETRY
      }
      if (response.status === 431) {
        if (conditional) return RETRY
        throw new HttpError(431, 'Fleet refused the request headers as too large.')
      }
      if (!response.ok) throw await httpErrorFrom(response)
      let data: unknown
      try {
        data = await response.json()
      } catch {
        throw new ProtocolError(`Fleet sent an unreadable answer for ${url}.`)
      }
      const rebuilt = reconstruct(data, paths, previous?.items)
      if (rebuilt.lost) return RETRY
      return { kind: 'ok', value: rebuilt.value, state: { tag: response.headers.get('etag'), items: rebuilt.items } }
    } finally {
      timed.done()
    }
  }

  const first = await attempt(true)
  if (first !== RETRY) return first
  const second = await attempt(false)
  if (second !== RETRY) return second
  throw new ProtocolError(`Fleet's answer for ${url} could not be reconstructed, even unconditionally.`)
}
