// The server-state cache (plan section 4, option B): a small keyed store read through
// useSyncExternalStore. It owns, per resource key:
//   - the last good data, kept through later failures (stale data beats a blank pane);
//   - the conditional-GET state (ETag and fingerprints) behind that data;
//   - at most one request in flight, with a "dirty" flag that buys exactly one
//     follow-up when the resource is invalidated while that request runs;
//   - a write epoch, so a response to a request that started before a newer write
//     (a mutation result passed to `set`) is dropped instead of overwriting it.
//
// Components never fetch on their own. They read a key; the store decides when to ask.
import type { ConditionalState } from './conditional'
import { isAbortError } from './errors'

export type ResourceStatus = 'idle' | 'loading' | 'success' | 'error'

/** What a component sees. A new object only when something it shows changed. */
export interface ResourceState<T> {
  readonly data: T | undefined
  readonly error: Error | null
  /** idle: never asked. loading: first request, no data yet. error: last attempt failed (data may still be present). */
  readonly status: ResourceStatus
}

export interface LoadContext<T> {
  readonly signal: AbortSignal
  /** Conditional state from the last successful load, or undefined when there is none to offer. */
  readonly conditional: ConditionalState | undefined
  /** The data currently held, to hand back on a 304. */
  readonly current: T | undefined
}

export interface LoadResult<T> {
  /** Return `ctx.current` unchanged for "not modified": the store then publishes nothing. */
  readonly data: T
  readonly conditional?: ConditionalState | undefined
}

/** A resource definition. `key` must uniquely identify the entity (and engine, where relevant). */
export interface Resource<T> {
  readonly key: string
  load(ctx: LoadContext<T>): Promise<LoadResult<T>>
}

interface Entry {
  resource: Resource<unknown>
  state: ResourceState<unknown>
  conditional: ConditionalState | undefined
  inflight: { controller: AbortController; epoch: number; promise: Promise<void> } | undefined
  /** Invalidated while a request was in flight: run one more when it settles. */
  dirty: boolean
  /** Invalidated with nobody watching: load on next subscribe. */
  stale: boolean
  /** Epoch of the newest write (load result or `set`) published to `state`. */
  written: number
  listeners: Set<() => void>
}

/** Unwatched keys kept with their data; older ones are dropped and load again when next watched. */
export const KEEP_UNWATCHED = 48

const IDLE: ResourceState<never> = Object.freeze({ data: undefined, error: null, status: 'idle' })

export class ResourceStore {
  private readonly entries = new Map<string, Entry>()
  private epoch = 0

  /** Current state for a key; stable reference between changes. */
  get<T>(resource: Resource<T>): ResourceState<T> {
    return (this.entries.get(resource.key)?.state ?? IDLE) as ResourceState<T>
  }

  /** Subscribe to a key. The first subscriber triggers a load when the key has no data or is stale. */
  subscribe<T>(resource: Resource<T>, listener: () => void): () => void {
    const entry = this.entry(resource)
    // Shown again after its last load failed (a session chosen again): try again rather
    // than keep showing that failure until some event happens to name it.
    const retry = entry.listeners.size === 0 && entry.state.status === 'error'
    entry.listeners.add(listener)
    if (entry.state.status === 'idle' || entry.stale || retry) void this.refresh(resource)
    return () => {
      entry.listeners.delete(listener)
      if (!entry.listeners.size) this.retire(entry)
    }
  }

  /** Load now unless a request for this key is already running; then share it. */
  refresh<T>(resource: Resource<T>): Promise<void> {
    const entry = this.entry(resource)
    if (entry.inflight) return entry.inflight.promise
    return this.start(entry)
  }

  /**
   * Mark keys out of date. Watched keys reload (or, if already loading, reload once
   * more afterwards); unwatched keys reload when next watched.
   */
  invalidate(...keys: readonly string[]): void {
    for (const key of keys) {
      const entry = this.entries.get(key)
      if (!entry) continue
      if (entry.inflight) entry.dirty = true
      else if (entry.listeners.size) void this.start(entry)
      else entry.stale = true
    }
  }

  /** Invalidate every key somebody is watching (visibility return, reconnect). */
  invalidateWatched(): void {
    this.invalidate(...this.watchedKeys())
  }

  /** Keys with at least one subscriber, i.e. on screen. */
  watchedKeys(): string[] {
    return [...this.entries.values()].filter(e => e.listeners.size).map(e => e.resource.key)
  }

  /**
   * Publish an authoritative value, typically a mutation's response. Any request
   * already in flight for the key started before this write, so its answer is dropped
   * and one follow-up reconciles. The ETag is cleared so the next GET cannot 304 back
   * to the older server copy; fingerprints stay, since they name content, not time.
   */
  set<T>(resource: Resource<T>, data: T): void {
    const entry = this.entry(resource)
    entry.written = ++this.epoch
    if (entry.conditional) entry.conditional = { tag: null, items: entry.conditional.items }
    if (entry.inflight) entry.dirty = true
    this.publish(entry, { data, error: null, status: 'success' })
  }

  /**
   * Forget conditional state for every key (a new server instance never saw our ETags)
   * and restart watched loads. Data is kept until the fresh answers replace it.
   */
  forgetConditional(): void {
    for (const entry of this.entries.values()) {
      entry.conditional = undefined
      if (entry.inflight) {
        entry.inflight.controller.abort()
        entry.inflight = undefined
        entry.dirty = false
      }
    }
    this.invalidateWatched()
    for (const entry of this.entries.values()) if (!entry.listeners.size) entry.stale = true
  }

  /** Drop a key entirely (an entity that no longer exists). Aborts its request. */
  remove(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    entry.inflight?.controller.abort()
    this.entries.delete(key)
    for (const listener of entry.listeners) listener()
  }

  /** Abort everything; used on shutdown. */
  dispose(): void {
    for (const entry of this.entries.values()) entry.inflight?.controller.abort()
    this.entries.clear()
  }

  /** True while a request for the key runs. Not reactive; for tests and diagnostics. */
  isFetching(key: string): boolean {
    return !!this.entries.get(key)?.inflight
  }

  // Nobody watches this key any more. Keep it (most recently left last) for a quick
  // return, but only the newest KEEP_UNWATCHED such keys: sessions come and go all day.
  private retire(entry: Entry): void {
    const key = entry.resource.key
    if (this.entries.get(key) !== entry) return
    this.entries.delete(key)
    this.entries.set(key, entry)
    let unwatched = 0
    for (const e of this.entries.values()) if (!e.listeners.size) unwatched++
    for (const [k, e] of this.entries) {
      if (unwatched <= KEEP_UNWATCHED) break
      if (e.listeners.size || e.inflight) continue
      this.entries.delete(k)
      unwatched--
    }
  }

  private entry(resource: Resource<unknown>): Entry {
    let entry = this.entries.get(resource.key)
    if (!entry) {
      entry = {
        resource,
        state: IDLE,
        conditional: undefined,
        inflight: undefined,
        dirty: false,
        stale: false,
        written: 0,
        listeners: new Set(),
      }
      this.entries.set(resource.key, entry)
    }
    return entry
  }

  private start(entry: Entry): Promise<void> {
    const controller = new AbortController()
    const epoch = ++this.epoch
    entry.stale = false
    entry.dirty = false
    if (entry.state.data === undefined && entry.state.status !== 'loading') {
      this.publish(entry, { data: undefined, error: null, status: 'loading' })
    }
    const current = entry.state.data
    // Registered before the load runs, so a load that fails synchronously still clears it.
    const inflight = { controller, epoch, promise: Promise.resolve() }
    entry.inflight = inflight
    inflight.promise = (async () => {
      try {
        const result = await entry.resource.load({
          signal: controller.signal,
          // Offer conditional state only alongside the data it describes.
          conditional: current === undefined ? undefined : entry.conditional,
          current,
        })
        if (controller.signal.aborted || this.entries.get(entry.resource.key) !== entry) return
        if (entry.written > epoch) return // a newer write landed while this was in flight
        entry.written = epoch
        entry.conditional = result.conditional
        this.publish(entry, { data: result.data, error: null, status: 'success' })
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) return
        if (entry.written > epoch) return
        const failure = error instanceof Error ? error : new Error(String(error))
        this.publish(entry, { data: entry.state.data, error: failure, status: 'error' })
      } finally {
        if (entry.inflight?.epoch === epoch) entry.inflight = undefined
        if (entry.dirty && !controller.signal.aborted && this.entries.get(entry.resource.key) === entry) {
          void this.start(entry)
        }
      }
    })()
    return inflight.promise
  }

  private publish(entry: Entry, next: ResourceState<unknown>): void {
    const previous = entry.state
    if (previous.data === next.data && previous.error === next.error && previous.status === next.status) return
    entry.state = Object.freeze(next)
    for (const listener of [...entry.listeners]) listener()
  }
}
