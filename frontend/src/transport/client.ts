// FleetClient: the one object that talks to the server. It owns the resource store,
// the control token, the event stream, the visibility listener and the recovery
// poll. The app creates exactly one, starts it once outside React (so StrictMode's
// double mount cannot double-subscribe), and hands it to components through context.
//
//   client.store                 keyed server state (see store.ts)
//   client.resources.control     /api/control, without the token
//   client.resources.sessions    /api/sessions snapshot, conditional
//   client.post(path, body)      POST with X-Fleet-Token; returns unvalidated JSON
//   client.start() / stop()      event stream, visibility, timers
import type { FetchLike } from './conditional'
import { type ControlInfo, type SessionSnapshot, parseControl, parseSessionSnapshot } from './contracts'
import { HttpError, ProtocolError, httpErrorFrom, withTimeout } from './errors'
import { type EventSourceFactory, EventStream, type StreamStatus } from './events'
import { conditionalResource, isManagedKey, keys, keysForSessionsEvent } from './resources'
import { type Resource, ResourceStore } from './store'

export interface VisibilitySource {
  readonly hidden: boolean
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

export interface FleetClientOptions {
  readonly fetch: FetchLike
  /** Null where EventSource is unavailable; the recovery poll then carries freshness. */
  readonly eventSource: EventSourceFactory | null
  readonly visibility?: VisibilitySource | null
  /** A burst of `list` events refetches the list at most once per this many ms. */
  readonly listCoalesceMs?: number
  /** Safety poll of the list while visible, for a stream that dropped silently. */
  readonly recoveryPollMs?: number
  readonly postTimeoutMs?: number
}

export interface PostOptions {
  readonly signal?: AbortSignal
  /** Keys to invalidate after a successful answer. */
  readonly invalidate?: readonly string[]
}

type Listener = () => void

export class FleetClient {
  readonly store = new ResourceStore()
  readonly resources: { readonly control: Resource<ControlInfo>; readonly sessions: Resource<SessionSnapshot> }

  private readonly fetch: FetchLike
  private readonly stream: EventStream | null
  private readonly visibility: VisibilitySource | null
  private readonly listCoalesceMs: number
  private readonly recoveryPollMs: number
  private readonly postTimeoutMs: number
  private token: string | null = null
  private instanceId: string | null = null
  private streamStatus: StreamStatus = 'closed'
  private readonly streamListeners = new Set<Listener>()
  private listTimer: ReturnType<typeof setTimeout> | null = null
  private lastListAt = 0
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private started = false

  constructor(options: FleetClientOptions) {
    this.fetch = options.fetch
    this.visibility = options.visibility ?? null
    this.listCoalesceMs = options.listCoalesceMs ?? 1000
    this.recoveryPollMs = options.recoveryPollMs ?? 30_000
    this.postTimeoutMs = options.postTimeoutMs ?? 15_000
    this.resources = {
      control: { key: keys.control, load: ({ signal, current }) => this.loadControl(signal, current) },
      sessions: conditionalResource(this.fetch, {
        key: keys.sessions,
        url: '/api/sessions',
        paths: ['sessions'],
        parse: parseSessionSnapshot,
      }),
    }
    this.stream = options.eventSource
      ? new EventStream('/api/events', options.eventSource, {
          onSessions: ids => this.store.invalidate(...keysForSessionsEvent(ids)),
          onList: () => this.scheduleList(),
          onOpen: reopened => this.onStreamOpen(reopened),
          onStatus: status => {
            this.streamStatus = status
            for (const listener of [...this.streamListeners]) listener()
          },
        })
      : null
  }

  /** Begin live updates. Idempotent. */
  start(): void {
    if (this.started) return
    this.started = true
    this.stream?.start()
    this.visibility?.addEventListener('visibilitychange', this.onVisibility)
    this.pollTimer = setInterval(() => {
      if (!this.hidden()) this.store.invalidate(keys.sessions)
    }, this.recoveryPollMs)
  }

  /** Stop everything this client started and abort its requests. */
  stop(): void {
    if (!this.started) return
    this.started = false
    this.stream?.stop()
    this.visibility?.removeEventListener('visibilitychange', this.onVisibility)
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.listTimer) clearTimeout(this.listTimer)
    this.pollTimer = null
    this.listTimer = null
    this.store.dispose()
  }

  /** Event-stream status, for useSyncExternalStore. */
  getStreamStatus = (): StreamStatus => this.streamStatus
  subscribeStreamStatus = (listener: Listener): (() => void) => {
    this.streamListeners.add(listener)
    return () => this.streamListeners.delete(listener)
  }

  /**
   * POST a JSON object with the control token. Returns the parsed JSON body, which the
   * caller must validate. Never retried here: a command after an ambiguous failure is
   * reconciled by refetching, not by sending it again. A 403 refreshes the token for
   * the next deliberate attempt (the server cannot yet say which 403 is a stale token).
   */
  async post(path: string, body: Readonly<Record<string, unknown>>, options: PostOptions = {}): Promise<unknown> {
    const token = await this.controlToken()
    const timed = withTimeout(options.signal, this.postTimeoutMs)
    try {
      const response = await this.fetch(path, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json', 'x-fleet-token': token },
        body: JSON.stringify(body),
        signal: timed.signal,
      })
      if (!response.ok) {
        const error = await httpErrorFrom(response)
        if (error.status === 403) {
          this.token = null
          void this.store.refresh(this.resources.control)
        }
        throw error
      }
      let data: unknown
      try {
        data = await response.json()
      } catch {
        throw new ProtocolError(`Fleet sent an unreadable answer for ${path}.`)
      }
      if (options.invalidate?.length) this.store.invalidate(...options.invalidate)
      return data
    } finally {
      timed.done()
    }
  }

  private async controlToken(): Promise<string> {
    if (!this.token) await this.store.refresh(this.resources.control)
    if (!this.token) {
      throw this.store.get(this.resources.control).error ?? new HttpError(0, 'Agent controls are unavailable.')
    }
    return this.token
  }

  private async loadControl(signal: AbortSignal, current: ControlInfo | undefined) {
    const timed = withTimeout(signal, 8000)
    try {
      const response = await this.fetch('/api/control', { cache: 'no-store', signal: timed.signal })
      if (!response.ok) throw await httpErrorFrom(response)
      let raw: unknown
      try {
        raw = await response.json()
      } catch {
        throw new ProtocolError('Fleet sent an unreadable answer for /api/control.')
      }
      const { token, ...info } = parseControl(raw)
      this.token = token
      // A new server process (once it reports instanceId) never saw our ETags.
      if (info.instanceId && this.instanceId && info.instanceId !== this.instanceId) this.store.forgetConditional()
      this.instanceId = info.instanceId ?? this.instanceId
      // Control carries no ETag; keep the old object when nothing in it moved.
      const same = current !== undefined && JSON.stringify(current) === JSON.stringify(info)
      return { data: same ? current : info }
    } finally {
      timed.done()
    }
  }

  private hidden(): boolean {
    return this.visibility?.hidden ?? false
  }

  private readonly onVisibility = (): void => {
    if (this.hidden()) return
    this.store.invalidateWatched()
  }

  // The list changed. Coalesce bursts; while hidden, wait for the page to return.
  private scheduleList(): void {
    // Hidden: the visibility return refetches everything watched, the list included.
    if (this.hidden() || this.listTimer) return
    const wait = Math.max(0, this.listCoalesceMs - (Date.now() - this.lastListAt))
    this.listTimer = setTimeout(() => {
      this.listTimer = null
      if (this.hidden()) return
      this.lastListAt = Date.now()
      // A terminal driving a managed session changes it without a `sessions` event,
      // so whatever detail is on screen is refreshed with the list.
      const watched = this.watchedManagedKeys()
      this.store.invalidate(keys.sessions, ...watched)
    }, wait)
  }

  private watchedManagedKeys(): string[] {
    return this.store.watchedKeys().filter(isManagedKey)
  }

  // Events have no replay: whatever happened while the stream was down is unknown.
  // A reopen may also be a new server, which never saw our ETags.
  private onStreamOpen(reopened: boolean): void {
    if (reopened) this.store.forgetConditional()
    else this.store.invalidateWatched()
  }
}
