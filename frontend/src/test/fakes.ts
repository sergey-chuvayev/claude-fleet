// Test doubles for the transport: the server's real sync.js behind a fake fetch, a
// controllable EventSource, and promises the test resolves by hand.
import { createRequire } from 'node:module'
import type { FetchLike } from '../transport/conditional'
import type { EventSourceLike } from '../transport/events'

interface SyncModule {
  pack(value: unknown, paths: readonly string[], known: Set<string>): unknown
  tagOf(value: unknown, volatile?: readonly string[]): string
  knownFrom(req: { headers: Record<string, string | undefined> }): Set<string>
}
// The server's half of the protocol, loaded as the CommonJS module it is.
const sync = createRequire(import.meta.url)('../../../sync.js') as SyncModule

export interface WireRecord {
  readonly url: string
  readonly ifNoneMatch: string | null
  readonly known: string | null
  readonly status: number
}

/**
 * A fake Fleet route answering exactly as server.js `respond()` does. `next` lets a
 * test replace the following answers (to inject a 431, a drifted `{h}` and so on).
 */
export function syncRoute(paths: readonly string[], volatile: readonly string[] = []) {
  let value: unknown = null
  const wire: WireRecord[] = []
  const overrides: Array<() => Response> = []
  const fetch: FetchLike = async (url, init) => {
    const headers = new Headers(init?.headers)
    const record = (status: number) =>
      wire.push({ url, ifNoneMatch: headers.get('if-none-match'), known: headers.get('x-fleet-known'), status })
    const override = overrides.shift()
    if (override) {
      const response = override()
      record(response.status)
      return response
    }
    const tag = sync.tagOf(value, volatile)
    if (headers.get('if-none-match') === tag) {
      record(304)
      return notModified(tag)
    }
    const known = sync.knownFrom({ headers: { 'x-fleet-known': headers.get('x-fleet-known') ?? undefined } })
    record(200)
    return jsonResponse(sync.pack(value, paths, known), 200, { etag: tag })
  }
  return {
    fetch,
    wire,
    set(next: unknown) {
      value = next
    },
    /** The plain, unpacked answer, for comparison. */
    plain: () => JSON.parse(JSON.stringify(value)) as unknown,
    next(...responses: Array<() => Response>) {
      overrides.push(...responses)
    },
  }
}

/** Drop the protocol's `h` markers and volatile keys, to compare with a plain answer. */
export const strip = (value: unknown, volatile: readonly string[] = []): unknown =>
  JSON.parse(JSON.stringify(value, (key, v: unknown) => (key === 'h' || volatile.includes(key) ? undefined : v)))

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })
}

/** A 304 whose body must never be read: reading it fails the test. */
export function notModified(tag: string): Response {
  const response = new Response(null, { status: 304, headers: { etag: tag } })
  const fail = () => {
    throw new Error('a 304 body was read')
  }
  Object.defineProperty(response, 'json', { value: fail })
  Object.defineProperty(response, 'text', { value: fail })
  return response
}

export interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Let pending promise callbacks run. */
export const flush = async (times = 5): Promise<void> => {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

type Listener = (event: MessageEvent<string>) => void

export class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = []
  readyState = 0
  onopen: ((ev: Event) => unknown) | null = null
  onerror: ((ev: Event) => unknown) | null = null
  closed = false
  private readonly listeners = new Map<string, Listener[]>()

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  close(): void {
    this.closed = true
    this.readyState = 2
  }

  open(): void {
    this.readyState = 1
    this.onopen?.(new Event('open'))
  }

  emit(type: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener(new MessageEvent(type, { data }))
  }

  /** A dropped connection the browser will retry (readyState CONNECTING) or has given up on (CLOSED). */
  fail(giveUp = false): void {
    this.readyState = giveUp ? 2 : 0
    this.onerror?.(new Event('error'))
  }
}

export class FakeVisibility {
  hidden = false
  private readonly listeners = new Set<() => void>()
  addEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners.add(listener)
  }
  removeEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners.delete(listener)
  }
  set(hidden: boolean): void {
    this.hidden = hidden
    for (const listener of this.listeners) listener()
  }
}
