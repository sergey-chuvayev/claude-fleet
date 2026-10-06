// Pure helpers for the Day board, ported from public/day.js and public/ui.js. No
// React here: what the board says about an item, its time, its links and its state.
import type { DayItem, DayNeed, DaySubagent, SessionSummary } from '../../transport/contracts'

export const SOURCE: Readonly<Record<string, string>> = {
  slack: 'Slack',
  linear: 'Linear',
  granola: 'Granola',
  github: 'GitHub',
  calendar: 'Calendar',
  me: 'You',
}
export const MODE = { me: 'I do it', draft: 'Draft for me', agent: 'Agent does it', ask: 'Find out' } as const
export const MODE_SHORT = { me: 'You', draft: 'Draft', agent: 'Agent', ask: 'Find out' } as const
export const PRIORITY = { must: 'Must', should: 'Should', could: 'Could' } as const
export const PRIORITY_ORDER = ['must', 'should', 'could'] as const

/** The statuses that put an item on today's list. */
export const ON_TODAY = new Set(['today', 'in_progress', 'waiting_on_you'])

/** The local calendar date, YYYY-MM-DD. Never UTC: a Day starts at the operator's midnight. */
export function localDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Noon on a YYYY-MM-DD date, so a time zone change can never move it a day. */
const noonOf = (date: string) => new Date(`${date}T12:00:00`)

/** The board's heading: Tuesday 6 October. */
export const dayHeading = (date: string): string =>
  noonOf(date).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })

/** The weekday a carried item came from: Mon. */
export const weekdayOf = (date: string): string => noonOf(date).toLocaleDateString([], { weekday: 'short' })

/** Questions on an item still waiting for the operator. */
export const openNeeds = (item: DayItem): DayNeed[] => item.needs.filter(n => n.answer === undefined)

export const minutesOf = (items: readonly DayItem[]): number => items.reduce((sum, i) => sum + (i.estimateMin || 0), 0)

/** 45m, 1h, 1h 30m. */
export const duration = (n: number): string => (n >= 60 ? `${Math.floor(n / 60)}h${n % 60 ? ` ${n % 60}m` : ''}` : `${n}m`)

/** Short enough for a chip: the first `max - 1` characters and an ellipsis. */
export const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** A link as the thing it points at: TECH-5163, api-allo#4638, Slack, Notion. */
export function linkLabel(url: string): string {
  const linear = /linear\.app\/[^/]+\/issue\/([A-Za-z]+-\d+)/.exec(url)
  if (linear?.[1]) return linear[1].toUpperCase()
  const pr = /github\.com\/[^/]+\/([^/]+)\/(?:pull|issues)\/(\d+)/.exec(url)
  if (pr?.[1] && pr[2]) return `${pr[1]}#${pr[2]}`
  const named: ReadonlyArray<readonly [RegExp, string]> = [
    [/slack\.com/, 'Slack'],
    [/notion\.(so|site)/, 'Notion'],
    [/granola\.ai/, 'Granola'],
    [/figma\.com/, 'Figma'],
    [/docs\.google\.com/, 'Google Doc'],
    [/usepylon\.com|pylon/, 'Pylon'],
  ]
  for (const [pattern, name] of named) if (pattern.test(url)) return name
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return 'Link'
  }
}

/** The distinct links in a note, as the add form sends them (at most 20). */
export const linksIn = (text: string): string[] => [...new Set(text.match(/https?:\/\/[^\s<>)"']+/g) ?? [])].slice(0, 20)

/** A long or structured context (a project's hand-off) folds; a short note reads in place. */
export const contextFolds = (text: string): boolean => text.length > 400 || /\n#{1,3} /.test(text)

export const isWorking = (status: string | null | undefined): boolean =>
  status === 'starting' || status === 'running' || status === 'approval' || status === 'stopping'

/** Minutes since `at`, as the board says it: 4m, 1h 12m. */
export function since(at: number, now: number): string {
  const m = Math.max(1, Math.round((now - at) / 60000))
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`
}

// ── Session rows, as far as the Day reads them ─────────────────────────────

export interface RowInfo {
  readonly managedId: string | null
  readonly kind: string | null
  readonly dayDate: string | null
  readonly archived: boolean
  readonly status: string | null
  readonly name: string
  readonly parentDayId: string | null
  readonly itemId: string | null
  readonly threadOpen: boolean
  readonly progress: { readonly verified: number; readonly total: number } | null
}

const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)

/** The fields of a list row the Day uses, read defensively (the row schema is loose). */
export function rowInfo(row: SessionSummary): RowInfo {
  const record = row as Record<string, unknown>
  const p = record.taskProgress as { verified?: unknown; total?: unknown } | null | undefined
  return {
    managedId: row.managedId ?? null,
    kind: str(record.kind),
    dayDate: str(record.dayDate),
    archived: row.archived === true,
    status: str(row.managedStatus),
    name: str(record.teamName) ?? row.title ?? row.name ?? 'Agent',
    parentDayId: str(record.parentDayId),
    itemId: str(record.itemId),
    threadOpen: record.threadOpen === true,
    progress: p && typeof p.total === 'number' && typeof p.verified === 'number' ? { verified: p.verified, total: p.total } : null,
  }
}

/** How a launched session's state reads on its chip. */
export const LAUNCH_STATE: Readonly<Record<string, string>> = {
  starting: 'starting',
  running: 'working',
  approval: 'needs you',
  stopping: 'stopping',
  stopped: 'stopped',
  error: 'failed',
  idle: 'ready',
  queued: 'queued',
}

// ── Where an item actually is ──────────────────────────────────────────────

export type LiveTone = 'working' | 'running' | 'needs' | 'queued' | 'idle'
export type LiveStatus = readonly [LiveTone, string]

export interface LiveContext {
  /** The Day session's own status. */
  readonly dayStatus: string | null
  readonly focus: { readonly itemId?: string | null | undefined; readonly at: number } | null | undefined
  readonly subagents: readonly DaySubagent[]
  readonly rows: ReadonlyMap<string, RowInfo>
  readonly now: number
}

/**
 * Where an item is, in words: being worked on now and by whom, running in its own
 * session, waiting for a launch, queued behind the Day's current work, or not
 * started. The plan alone ("today", "Agent does it") never said whether anything moved.
 */
export function liveStatus(item: DayItem, ctx: LiveContext): LiveStatus | null {
  if (!ON_TODAY.has(item.status)) return null
  const working = isWorking(ctx.dayStatus)
  const subs = ctx.subagents.filter(d => d.itemId === item.id && d.status === 'running')
  if (subs.length) {
    const roles = [...new Set(subs.map(d => d.role))].join(', ')
    return ['working', `Working now · ${roles} · ${since(Math.min(...subs.map(d => d.startedAt ?? ctx.now)), ctx.now)}`]
  }
  if (working && ctx.focus?.itemId === item.id) return ['working', `Working now · Day agent · ${since(ctx.focus.at, ctx.now)}`]
  const launched = (item.launched ?? []).map(id => ctx.rows.get(id)).filter((x): x is RowInfo => !!x)
  if (launched.some(x => x.status === 'approval')) return ['needs', 'Its session needs you']
  if (launched.some(x => x.status === 'starting' || x.status === 'running' || x.status === 'queued')) return ['running', 'Running in its own session']
  const asks = openNeeds(item)
  if (asks.some(n => n.kind === 'launch')) return ['needs', 'Launch brief ready · approve it above']
  if (asks.length) return ['needs', 'Waiting on you']
  if (launched.length) return null
  if (item.mode === 'agent') return ['queued', working ? 'Launch brief coming' : 'Launch brief at the next run']
  if (item.mode === 'me') return null
  return working ? ['queued', 'Queued for the Day'] : ['idle', 'Not started']
}

/** The row's orb tone: what is moving or waiting outranks the plan. */
export function rowTone(item: DayItem, live: LiveStatus | null): string {
  if (live && (live[0] === 'working' || live[0] === 'running' || live[0] === 'needs')) return live[0]
  if (item.status === 'waiting_on_you') return 'needs'
  if (item.status === 'in_progress') return 'progress'
  return live?.[0] ?? 'todo'
}

/** The orb's tooltip. */
export function rowOrbTitle(item: DayItem, live: LiveStatus | null): string {
  if (item.status === 'waiting_on_you') return 'Needs you'
  if (item.status === 'in_progress') return 'In progress'
  return live?.[1] ?? 'Not started'
}

// ── The page head: when the Day last looked and when it will next ──────────

/** What an automatic run is called, by the message it was started with. */
export const AUTO_RUN: Readonly<Record<string, string>> = {
  'Start my day': 'Morning intake',
  Sweep: 'Auto check',
  'Pick up answers': 'Picked up your answers',
}

const clockOf = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** "Checked 09:40 · next 10:10", or "next tomorrow 08:00" past the Day's hours. */
export function checkedLine(checks: { lastAt?: number | null | undefined; everyMin: number; hours?: readonly [number, number] | undefined } | null | undefined, now: number): string {
  if (!checks?.lastAt) return ''
  const next = new Date(checks.lastAt + checks.everyMin * 60000)
  const [from, to] = checks.hours ?? [8, 20]
  const later = next.getHours() >= to || next.toDateString() !== new Date(now).toDateString()
  const morning = new Date(now)
  morning.setDate(morning.getDate() + 1)
  morning.setHours(from, 0, 0, 0)
  const at = later ? `tomorrow ${clockOf(morning.getTime())}` : next.getHours() < from ? clockOf(new Date(next).setHours(from, 0, 0, 0)) : clockOf(next.getTime())
  return `Checked ${clockOf(checks.lastAt)} · next ${at}`
}

/** While the Day works: what it is on ("Working on Reply to Thomas +1"), or what started the run. */
export function workingLine(items: readonly DayItem[], focusItemId: string | null | undefined, subagents: readonly DaySubagent[], lastUser: { text?: string | null | undefined; runPrompt?: unknown } | undefined): { text: string; titles: string[] } {
  const title = (id: string) => items.find(i => i.id === id)?.title
  const running = subagents.filter(d => d.status === 'running')
  const ids = [...new Set([focusItemId, ...running.map(d => d.itemId)].filter((x): x is string => !!x))]
  const on = ids.map(title).filter((x): x is string => !!x)
  const what = on.length
    ? `Working on ${clip(on[0] ?? '', 40)}${on.length > 1 ? ` +${on.length - 1}` : ''}`
    : lastUser?.runPrompt
      ? (AUTO_RUN[lastUser.text ?? ''] ?? 'Checking')
      : 'Working'
  const subs = running.length ? ` · ${running.length} subagent${running.length === 1 ? '' : 's'}` : ''
  return { text: `${what}${subs}…`, titles: on }
}

// ── Scouts ─────────────────────────────────────────────────────────────────

const SCOUT_ORDER = ['slack-scout', 'linear-scout', 'github-scout', 'granola-scout', 'calendar-scout']
const SCOUT_NAME: Readonly<Record<string, string>> = {
  'slack-scout': 'Slack',
  'linear-scout': 'Linear',
  'github-scout': 'GitHub',
  'granola-scout': 'Granola',
  'calendar-scout': 'Calendar',
}
export const scoutName = (role: string): string => SCOUT_NAME[role] ?? role

export interface RoleGroup {
  readonly role: string
  /** Oldest first. */
  readonly runs: readonly DaySubagent[]
  readonly latest: DaySubagent
}

/**
 * Every check sends the same scouts out again, so the strip shows one tab per role,
 * holding its latest run; its earlier runs today are listed inside it. Scouts come in
 * their usual order, other roles after them, most recent first.
 */
export function byRole(list: readonly DaySubagent[]): RoleGroup[] {
  const groups = new Map<string, DaySubagent[]>()
  for (const d of [...list].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))) {
    const runs = groups.get(d.role)
    if (runs) runs.push(d)
    else groups.set(d.role, [d])
  }
  const rank = (role: string) => {
    const i = SCOUT_ORDER.indexOf(role)
    return i < 0 ? SCOUT_ORDER.length : i
  }
  return [...groups.entries()]
    .map(([role, runs]) => ({ role, runs, latest: runs[runs.length - 1] as DaySubagent }))
    .sort((a, b) => rank(a.role) - rank(b.role) || (b.latest.startedAt || 0) - (a.latest.startedAt || 0))
}

/** The dot class a subagent's state wears. */
export const AGENT_STATE: Readonly<Record<string, string>> = { running: 'busy', completed: 'idle', failed: 'hot', interrupted: 'stale' }

/** One line about a run, for the list of runs today. */
export function runGist(run: DaySubagent): string {
  if (run.status === 'running') return 'running now'
  return String(run.report ?? '').replace(/\s+/g, ' ').trim().slice(0, 90) || (run.status === 'failed' ? 'failed' : 'no report')
}
