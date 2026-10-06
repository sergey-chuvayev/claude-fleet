// The one EventSource the app owns (/api/events). Events are invalidations, never
// data: `sessions` carries the ids that changed (managed ids, or 'projects' /
// 'queue'), `list` says the session list's tag moved. There is no replay, so every
// (re)open is followed by a refetch of what is on screen.
//
// The browser reconnects a dropped stream by itself. It gives up only when the
// server refuses the stream (429 past 20 dashboards, or a non-stream answer); then
// this retries with capped, jittered backoff.

export interface EventSourceLike {
  readonly readyState: number
  onopen: ((ev: Event) => unknown) | null
  onerror: ((ev: Event) => unknown) | null
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void
  close(): void
}
export type EventSourceFactory = (url: string) => EventSourceLike

export type StreamStatus = 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface EventStreamHandlers {
  /** Ids from a `sessions` event. Malformed payloads are dropped. */
  onSessions(ids: readonly string[]): void
  onList(): void
  /** Every open, the first one included. `reopened` is true from the second on. */
  onOpen(reopened: boolean): void
  onStatus(status: StreamStatus): void
}

const CLOSED = 2

export function parseSessionsEvent(data: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(data)
    if (!Array.isArray(parsed)) return null
    return parsed.filter((id): id is string => typeof id === 'string')
  } catch {
    return null
  }
}

export class EventStream {
  private source: EventSourceLike | null = null
  private opened = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private status: StreamStatus = 'closed'

  constructor(
    private readonly url: string,
    private readonly create: EventSourceFactory,
    private readonly handlers: EventStreamHandlers,
    private readonly random: () => number = Math.random,
  ) {}

  get current(): StreamStatus {
    return this.status
  }

  start(): void {
    if (this.source || this.retryTimer) return
    this.connect()
  }

  stop(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.source?.close()
    this.source = null
    this.setStatus('closed')
  }

  private connect(): void {
    this.retryTimer = null
    this.setStatus(this.opened || this.attempt ? 'reconnecting' : 'connecting')
    const source = this.create(this.url)
    this.source = source
    source.onopen = () => {
      if (this.source !== source) return
      this.attempt = 0
      this.opened++
      this.setStatus('open')
      this.handlers.onOpen(this.opened > 1)
    }
    source.onerror = () => {
      if (this.source !== source) return
      if (source.readyState === CLOSED) {
        // The browser will not retry this one; schedule our own attempt.
        source.close()
        this.source = null
        this.scheduleRetry()
      } else {
        this.setStatus('reconnecting')
      }
    }
    source.addEventListener('sessions', event => {
      if (this.source !== source) return
      const ids = parseSessionsEvent(event.data)
      if (ids) this.handlers.onSessions(ids)
    })
    source.addEventListener('list', () => {
      if (this.source === source) this.handlers.onList()
    })
  }

  private scheduleRetry(): void {
    this.setStatus('reconnecting')
    const base = Math.min(30_000, 1000 * 2 ** this.attempt++)
    const delay = base / 2 + this.random() * (base / 2)
    this.retryTimer = setTimeout(() => this.connect(), delay)
  }

  private setStatus(status: StreamStatus): void {
    if (status === this.status) return
    this.status = status
    this.handlers.onStatus(status)
  }
}
