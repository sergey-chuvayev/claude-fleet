// Time and size formatting, ported unchanged from public/app.js so every surface
// prints the same "2m", "1h 4m" and "12:00" the legacy UI did. Pure: the caller passes
// `now`, which comes from the shared clock (components/clock.ts), never Date.now() in
// render.

const toMs = (at: number | string | Date): number => (at instanceof Date ? at.getTime() : new Date(at).getTime())

/** How long ago: 42s, 5m, 3h, 2d. An absent timestamp is an em dash, as before. */
export function age(at: number | string | null | undefined, now: number): string {
  if (!at) return '—'
  const secs = Math.max(0, Math.floor((now - toMs(at)) / 1000))
  return secs < 60
    ? `${secs}s`
    : secs < 3600
      ? `${Math.floor(secs / 60)}m`
      : secs < 86400
        ? `${Math.floor(secs / 3600)}h`
        : `${Math.floor(secs / 86400)}d`
}

/** A duration: 4s, 3m 07s, 1h 12m. Never 0s: a turn that just began reads 1s. */
export function elapsed(ms: number): string {
  return ms < 60000
    ? `${Math.max(1, Math.round(ms / 1000))}s`
    : ms < 3600000
      ? `${Math.floor(ms / 60000)}m ${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s`
      : `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`
}

/** Wall-clock time in the operator's locale: 12:00. */
export const clockAt = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** Wall-clock time with seconds: 10:00:00. */
export const clockAtSeconds = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** Time left until a reset: any moment, 12m, 3h 5m. */
export function untilReset(ms: number, now: number): string {
  const left = ms - now
  if (left <= 0) return 'any moment'
  return left < 3600000
    ? `${Math.max(1, Math.round(left / 60000))}m`
    : `${Math.floor(left / 3600000)}h ${Math.round((left % 3600000) / 60000)}m`
}

/** Token counts: 950, 12k, 1.2m. */
export const tokens = (n: number): string =>
  n >= 1000000 ? `${(n / 1000000).toFixed(1)}m` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
