// One clock for the whole app. Ages ("5m ago") and running-turn timers are worked
// out from it when drawn. It ticks once a second, only while something listens and
// the page is visible, and a component re-renders only when the time rounded to the
// resolution it asked for changes: a "3h ago" label re-renders once a minute, a
// running timer once a second, and nothing re-renders the root.
import { createContext, useCallback, useContext, useSyncExternalStore } from 'react'
import { age, elapsed } from '../domain/format'

type Listener = () => void

export interface ClockOptions {
  readonly now?: () => number
  readonly intervalMs?: number
  readonly visibility?: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'> | null
}

export class Clock {
  private readonly listeners = new Set<Listener>()
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly readNow: () => number
  private readonly intervalMs: number
  private readonly visibility: ClockOptions['visibility']

  constructor(options: ClockOptions = {}) {
    this.readNow = options.now ?? (() => Date.now())
    this.intervalMs = options.intervalMs ?? 1000
    this.visibility = options.visibility === undefined ? (typeof document === 'undefined' ? null : document) : options.visibility
  }

  now = (): number => this.readNow()

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1) this.start()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.stop()
    }
  }

  /** Active listeners, for leak tests. */
  get size(): number {
    return this.listeners.size
  }

  private start(): void {
    this.timer = setInterval(this.tick, this.intervalMs)
    this.visibility?.addEventListener('visibilitychange', this.onVisibility)
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.visibility?.removeEventListener('visibilitychange', this.onVisibility)
  }

  private readonly tick = (): void => {
    if (this.visibility?.hidden) return
    for (const listener of [...this.listeners]) listener()
  }

  private readonly onVisibility = (): void => {
    if (!this.visibility?.hidden) this.tick()
  }
}

const defaultClock = new Clock()
const ClockContext = createContext<Clock>(defaultClock)
export const ClockProvider = ClockContext.Provider

export function useClock(): Clock {
  return useContext(ClockContext)
}

/** The current time, rounded down to `resolutionMs`; re-renders only when that changes. */
export function useNow(resolutionMs = 1000): number {
  const clock = useClock()
  const read = useCallback(() => Math.floor(clock.now() / resolutionMs) * resolutionMs, [clock, resolutionMs])
  return useSyncExternalStore(clock.subscribe, read, read)
}

/** Seconds matter for the first minute; after that a quarter minute, then a minute. */
const resolutionFor = (ms: number): number => (ms < 60_000 ? 1000 : ms < 3_600_000 ? 15_000 : 60_000)

const toMs = (at: number | string): number => (typeof at === 'number' ? at : new Date(at).getTime())

export interface RelativeTimeProps {
  readonly at: number | string | null | undefined
  /** Appended after the age, e.g. " ago". */
  readonly suffix?: string
  readonly className?: string
}

/** "5m ago": the legacy age() format, live, with the exact time on hover. */
export function RelativeTime({ at, suffix = '', className }: RelativeTimeProps) {
  const clock = useClock()
  const ms = at === null || at === undefined || at === '' ? null : toMs(at)
  const now = useNow(ms === null ? 60_000 : resolutionFor(Math.max(0, clock.now() - ms)))
  if (ms === null || !Number.isFinite(ms)) return <span className={className}>{age(null, now)}</span>
  const date = new Date(ms)
  return (
    <time className={className} dateTime={date.toISOString()} title={date.toLocaleString()}>
      {age(ms, now)}
      {suffix}
    </time>
  )
}

/** A running duration since `since` (a turn in progress): 4s, 3m 07s. */
export function Elapsed({ since, until, className }: { since: number; until?: number | null; className?: string }) {
  const now = useNow(1000)
  return <span className={className}>{elapsed((until ?? now) - since)}</span>
}
