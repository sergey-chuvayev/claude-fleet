// Session list selectors, ported from public/app.js (render, status, turnRow,
// matchesDate, sweepTargets). Pure: the caller passes `now` from the shared clock.
//
// Which rows a view shows is decided here once per snapshot, so the list, its counts
// and the filter menu can never disagree about what "foreground" means.
import { type SessionRow, type SessionSnapshot, type SessionSummary, sessionRowOf } from '../transport/contracts'

export const STATES = ['busy', 'idle', 'stale', 'dead'] as const
export type RowState = (typeof STATES)[number]
export const STATE_LABELS: Readonly<Record<RowState, string>> = { busy: 'Working', idle: 'Waiting', stale: 'Stale', dead: 'Offline' }

export type StatusFilter = 'all' | RowState | 'background' | 'archived'
export type DateFilter = 'all' | 'today' | 'week'
export const DATE_FILTERS: readonly DateFilter[] = ['all', 'today', 'week']
export const DATE_LABELS: Readonly<Record<DateFilter, string>> = { all: 'All time', today: 'Today', week: 'This week' }

const DAY_MS = 86_400_000

// ── Row facts ───────────────────────────────────────────────────────────────

/** Working right now: a terminal holding it, else Fleet's own status, else the process. */
export function isWorking(row: SessionRow): boolean {
  if (row.openElsewhere) return row.openElsewhere.state === 'busy'
  if (row.managed) return ['starting', 'running', 'stopping'].includes(row.managedStatus ?? '')
  return row.state === 'busy'
}

/** How full the context window is, 0 to 100, or null when it is not known. Unknown is not 0. */
export function contextPercent(row: Pick<SessionRow, 'contextTokens' | 'contextLimit'>): number | null {
  if (row.contextTokens == null || !row.contextLimit) return null
  return Math.min(100, Math.max(0, (row.contextTokens / row.contextLimit) * 100))
}

/** The pressure class: hot from 90%, warn from 75%. */
export const heat = (percent: number | null): '' | 'warn' | 'hot' =>
  percent === null ? '' : percent >= 90 ? 'hot' : percent >= 75 ? 'warn' : ''

/** 1 → 1st. Only ever sees a queue position, so the teens rule is enough. */
export const ordinal = (n: number): string =>
  `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] || 'th'}`

export interface StatusBadge {
  readonly label: string
  /** The badge's class after `badge`: a state, or elsewhere (busy). */
  readonly className: string
  readonly title?: string
}

const MANAGED_LABEL: Readonly<Record<string, string>> = {
  starting: 'Starting',
  running: 'Working',
  approval: 'Needs approval',
  stopping: 'Stopping',
  stopped: 'Stopped',
  error: 'Error',
  idle: 'Ready',
}

/** The status badge, as legacy status() drew it. */
export function statusBadge(row: SessionRow): StatusBadge {
  // A Fleet conversation resumed in a terminal is driven there, whatever Fleet last recorded.
  if (row.managed && row.openElsewhere) {
    const held = row.openElsewhere
    const cli = held.entrypoint === 'cli'
    const busy = held.state === 'busy'
    return {
      label: cli ? 'In terminal' : 'Elsewhere',
      className: `elsewhere${busy ? ' busy' : ''}`,
      title: `Open ${cli ? 'in a terminal' : 'in another program'}${held.name ? ` (${held.name})` : ''}${busy ? ', working' : ', idle'}`,
    }
  }
  const status = row.managedStatus ?? ''
  // Queued keeps state idle (the four counts stay four), so the badge says otherwise.
  const label = row.managed
    ? status === 'queued'
      ? `Queued${row.queuePosition ? ` · ${ordinal(row.queuePosition)}` : ''}`
      : (MANAGED_LABEL[status] ?? STATE_LABELS[row.state])
    : STATE_LABELS[row.state]
  const className = status === 'approval' ? 'stale' : status === 'error' ? 'hot' : status === 'queued' ? 'dead' : row.state
  return { label, className }
}

/** The avatar's status dot: an approval reads stale, otherwise the process state. */
export const avatarStatus = (row: SessionRow): string => (row.managedStatus === 'approval' ? 'stale' : row.state)

// ── The turn line ───────────────────────────────────────────────────────────

export const STEP_ICON: Readonly<Record<string, string>> = { inspect: '▤', change: '✎', run: '⚡', delegate: '✳', ask: '?', other: '▸' }
const STEP_WORD: Readonly<Record<string, string>> = {
  inspect: 'inspecting',
  change: 'changing files',
  run: 'running commands',
  delegate: 'delegating',
  ask: 'asking',
  other: 'other',
}

export function stepCategory(name: string): string {
  if (['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch'].includes(name)) return 'inspect'
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) return 'change'
  if (['Bash', 'BashOutput', 'KillShell'].includes(name)) return 'run'
  if (['Task', 'Skill', 'Agent'].includes(name)) return 'delegate'
  if (['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode'].includes(name)) return 'ask'
  return 'other'
}

/** "This turn: 2 inspecting, 1 running commands, 1 failed. Now: Bash npm test" */
export function turnAriaLabel(row: SessionRow): string | null {
  const turn = row.turn
  if (!turn || (!turn.steps.length && !turn.current && !turn.last)) return null
  const failed = turn.steps.filter(step => !step.ok).length
  const tally = new Map<string, number>()
  for (const step of turn.steps) tally.set(step.k ?? 'other', (tally.get(step.k ?? 'other') ?? 0) + 1)
  const spoken = [...tally].map(([k, n]) => `${n} ${STEP_WORD[k] ?? k}`).join(', ') + (failed ? `, ${failed} failed` : '')
  const step = turn.current || turn.last
  const now = step ? `. ${isWorking(row) ? 'Now' : 'Last'}: ${step.t}${step.target ? ` ${step.target}` : ''}` : ''
  return `This turn: ${spoken || 'no tool steps'}${now}`
}

// ── Dates ───────────────────────────────────────────────────────────────────

const toMs = (at: number | string): number => (typeof at === 'number' ? at : new Date(at).getTime())

/** Local midnight today. */
export function startOfToday(now: number): number {
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

/** "Today" resets at local midnight; "This week" is a rolling seven days. */
export function matchesDate(row: Pick<SessionRow, 'startedAt'>, when: DateFilter, now: number): boolean {
  if (when === 'all') return true
  if (row.startedAt == null || row.startedAt === '') return false
  const started = toMs(row.startedAt)
  return when === 'today' ? started >= startOfToday(now) : started >= now - 7 * DAY_MS
}

// ── The list ────────────────────────────────────────────────────────────────

export interface SessionPartition {
  /** Every row, typed, in server order (approval, then busy, then most recent). */
  readonly rows: readonly SessionRow[]
  readonly archived: readonly SessionRow[]
  /** Not archived: what the status bar and Today/Projects read. */
  readonly live: readonly SessionRow[]
  /** Live rows that belong in Sessions: no Day, no project manager, no open item thread. */
  readonly agents: readonly SessionRow[]
  readonly background: readonly SessionRow[]
  readonly foreground: readonly SessionRow[]
  /** Foreground rows per state, for the filter menu. */
  readonly counts: Readonly<Record<RowState, number>>
  /** How many background sessions each pid runs, for its row badge. */
  readonly spawnCounts: ReadonlyMap<number, number>
}

const partitions = new WeakMap<readonly SessionSummary[], SessionPartition>()

/** Split a snapshot into the pools the list reads. Cached per sessions array. */
export function partitionSessions(snapshot: Pick<SessionSnapshot, 'sessions'>): SessionPartition {
  const cached = partitions.get(snapshot.sessions)
  if (cached) return cached
  const rows = snapshot.sessions.map(sessionRowOf)
  // Archived sessions are put away, not deleted: they leave every count and filter but their own.
  const archived = rows.filter(row => row.archived)
  const live = rows.filter(row => !row.archived)
  // A Day lives in Today and a project's manager in Projects. An item's thread belongs
  // to Today while its item is open; once settled it is an ordinary past conversation.
  const agents = live.filter(row => row.kind !== 'day' && row.kind !== 'project' && !(row.kind === 'thread' && row.threadOpen))
  const background = agents.filter(row => row.background)
  const foreground = agents.filter(row => !row.background)
  const counts: Record<RowState, number> = { busy: 0, idle: 0, stale: 0, dead: 0 }
  for (const row of foreground) counts[row.state] += 1
  const spawnCounts = new Map<number, number>()
  for (const row of background) if (row.spawnedByPid) spawnCounts.set(row.spawnedByPid, (spawnCounts.get(row.spawnedByPid) ?? 0) + 1)
  const partition = { rows, archived, live, agents, background, foreground, counts, spawnCounts }
  partitions.set(snapshot.sessions, partition)
  return partition
}

/** The archived filter with nothing archived is the full list, so a last restore never strands the operator. */
export const effectiveFilter = (filter: StatusFilter, partition: SessionPartition): StatusFilter =>
  filter === 'archived' && !partition.archived.length ? 'all' : filter

/** The rows the list shows for a status and a date filter. */
export function shownSessions(partition: SessionPartition, filter: StatusFilter, date: DateFilter, now: number): SessionRow[] {
  const status = effectiveFilter(filter, partition)
  const pool = status === 'archived' ? partition.archived : status === 'background' ? partition.background : partition.foreground
  const byState = status === 'all' || status === 'background' || status === 'archived' ? null : status
  return pool.filter(row => (byState === null || row.state === byState) && matchesDate(row, date, now))
}

/** Date counts sit against the foreground pool, the same base the status counts use. */
export function dateCounts(partition: SessionPartition, now: number): Readonly<Record<DateFilter, number>> {
  return {
    all: partition.foreground.length,
    today: partition.foreground.filter(row => matchesDate(row, 'today', now)).length,
    week: partition.foreground.filter(row => matchesDate(row, 'week', now)).length,
  }
}

/** The trigger names the active combination, not every count. */
export function filterLabel(filter: StatusFilter, date: DateFilter): string {
  const base =
    filter === 'all' ? 'All sessions' : filter === 'background' ? 'Background' : filter === 'archived' ? 'Archived' : STATE_LABELS[filter]
  return date === 'all' ? base : `${base} · ${DATE_LABELS[date]}`
}

/** What an empty list says. `total` is the snapshot's total, so a quiet fleet reads differently from a filtered one. */
export function emptyListText(filter: StatusFilter, total: number): readonly string[] {
  if (filter === 'background') return ['No background sessions right now.']
  if (total) return ['No sessions match your filters.', 'Try another search or select All sessions.']
  return ['Your fleet is quiet.', 'Start a Claude Code session and it will appear here automatically.']
}

// ── The archive ─────────────────────────────────────────────────────────────

export const SWEEP_DAYS = [3, 7, 14, 30] as const
export const DEFAULT_ARCHIVE_RULE = { enabled: false, days: 14 } as const

/**
 * Offline external sessions older than the rule's age: what "Archive N" puts away.
 * Managed sessions are closed, never archived; a row needs a transcript id to archive.
 */
export function sweepTargets(rows: readonly SessionRow[], days: number, now: number): SessionRow[] {
  const cutoff = now - days * DAY_MS
  return rows.filter(row => !row.archived && !row.managed && row.state === 'dead' && !!row.sessionId && !!row.lastActivity && row.lastActivity < cutoff)
}

/** The day choices: the presets plus the stored rule, so the select never shows a different number than the rule uses. */
export const sweepDayChoices = (days: number): number[] => [...new Set<number>([...SWEEP_DAYS, days])].sort((a, b) => a - b)

/** The model's short name, as legacy printed it. */
export const shortModel = (model: string | null | undefined): string | null => (model ? model.replace('claude-', '') : null)

/**
 * The filter that shows a row the current filter hides, or null when the row is shown
 * already or belongs to no Sessions pool (a Day, a project manager). An archived row
 * opens on Archived, a background one on Background, anything else on All.
 */
export function revealFilter(
  partition: SessionPartition,
  shown: readonly SessionRow[],
  key: string,
  keyOf: (row: SessionRow) => string,
): { status: StatusFilter; date: DateFilter } | null {
  if (shown.some(row => keyOf(row) === key)) return null
  const row = partition.rows.find(candidate => keyOf(candidate) === key)
  if (!row) return null
  if (row.archived) return { status: 'archived', date: 'all' }
  if (!partition.agents.includes(row)) return null
  return { status: row.background ? 'background' : 'all', date: 'all' }
}
