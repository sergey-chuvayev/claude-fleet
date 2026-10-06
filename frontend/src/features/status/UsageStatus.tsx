// The account's plan windows in the status bar (F27), ported from usageHtml in
// public/app.js. They belong to the account, not to a session: every Claude process
// on this machine draws on them. One gauge on whichever window is closest to stopping
// the fleet; the others are bare numbers. Unknown is not zero: with nothing measured
// (or an API key, where plan limits do not apply) nothing is drawn.
import { z } from 'zod'
import { useNow } from '../../components/clock'
import { clockAt, untilReset } from '../../domain/format'

const windowSchema = z.looseObject({
  name: z.string(),
  label: z.string(),
  utilization: z.number(),
  resetsAt: z.number().nullable().optional(),
})
const usageSchema = z.looseObject({
  available: z.boolean(),
  known: z.boolean(),
  windows: z.array(windowSchema),
  binding: z.string().nullable().optional(),
  subscription: z.string().nullable().optional(),
  observedAt: z.number().nullable().optional(),
  stale: z.boolean().optional(),
  blocked: z
    .looseObject({ rateLimitType: z.string().nullable().optional(), resetsAt: z.number(), reason: z.string().nullable().optional() })
    .nullable()
    .optional(),
})
export type Usage = z.infer<typeof usageSchema>

/** The usage reading, or null when it is missing or not shaped as expected. */
export function parseUsage(raw: unknown): Usage | null {
  const result = usageSchema.safeParse(raw)
  return result.success ? result.data : null
}

const WINDOW_WORD: Record<string, string> = {
  five_hour: 'five-hour',
  seven_day: 'weekly',
  seven_day_opus: 'weekly Opus',
  seven_day_sonnet: 'weekly Sonnet',
  seven_day_oauth_apps: 'weekly apps',
}
const BLOCK_REASON: Record<string, string> = {
  org_spend_cap_reached: 'organisation spend cap reached',
  out_of_credits: 'out of credits',
  overage_not_provisioned: 'no overage configured',
  org_level_disabled: 'overage off for this organisation',
  member_level_disabled: 'overage off for this member',
  no_limits_configured: 'no overage limits set',
  fetch_error: 'usage lookup failed',
}
const windowWord = (name: string | null | undefined) => WINDOW_WORD[name ?? ''] || String(name || '').replace(/_/g, ' ')
const blockReason = (reason: string | null | undefined) => (reason ? BLOCK_REASON[reason] || reason.replace(/_/g, ' ') : null)
/** Same thresholds and colours as context pressure. */
export const heat = (percent: number | null) => (percent === null ? '' : percent >= 90 ? 'hot' : percent >= 75 ? 'warn' : '')

export function UsageStatus({ usage: raw }: { usage: unknown }) {
  const now = useNow(60_000)
  const usage = parseUsage(raw)
  if (!usage || !usage.available || !usage.known) return null
  const blocked = usage.blocked
  const reason = blocked ? blockReason(blocked.reason) : null
  const blockedLine = blocked ? (
    <span
      className="usage-blocked hot"
      title="A request was refused by this window. Every Claude session on this machine is affected until it resets."
    >
      ⊘ Rate limited · {windowWord(blocked.rateLimitType)} window · resets {clockAt(blocked.resetsAt)} ({untilReset(blocked.resetsAt, now)})
      {reason ? ` · ${reason}` : ''}
    </span>
  ) : null
  const binding = usage.windows.find(w => w.name === usage.binding) ?? usage.windows[0]
  // A block with no window reading has no number to draw, and a made-up one is worse.
  if (!binding) return blockedLine
  const cls = heat(binding.utilization)
  // Past 90% the countdown is the decision, so it replaces the reset clock.
  const critical = binding.utilization >= 90
  const reset = binding.resetsAt ? (critical ? `${untilReset(binding.resetsAt, now)} left` : `resets ${clockAt(binding.resetsAt)}`) : ''
  const detail = [
    usage.subscription ? `Plan: ${usage.subscription}.` : '',
    'Account-wide, including the terminal sessions Fleet only watches.',
    usage.observedAt ? `Last read ${clockAt(usage.observedAt)}.` : '',
  ]
    .filter(Boolean)
    .join(' ')
  const others = usage.windows.filter(w => w !== binding)
  return (
    <>
      <span className={`usage-window${cls ? ` ${cls}` : ''}${usage.stale ? ' is-stale' : ''}`} title={detail}>
        <b>{binding.label}</b>
        <span
          className={`usage-gauge${cls ? ` ${cls}` : ''}`}
          role="meter"
          aria-label={`${windowWord(binding.name)} usage`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={binding.utilization}
        >
          <i style={{ width: `${binding.utilization}%` }} />
        </span>
        <span className="usage-pct">{binding.utilization}%</span>
        <small className={`usage-reset${critical ? ' is-critical' : ''}`}>{reset}</small>
      </span>
      {others.map(w => (
        <span key={w.name} className={`usage-other${heat(w.utilization) ? ` ${heat(w.utilization)}` : ''}`}>
          <b>{w.label}</b> {w.utilization}%
        </span>
      ))}
      {blockedLine}
      {usage.stale && usage.observedAt ? (
        <small className="usage-stale" title="Utilisation only updates while a Fleet agent is running.">
          as of {clockAt(usage.observedAt)}
        </small>
      ) : null}
    </>
  )
}
