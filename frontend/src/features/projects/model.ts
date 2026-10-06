// What the Projects page knows about its data: labels, tones and the few derived
// facts (working days left, a project's members). Pure; the clock comes from the caller.
import type { Project, SessionSummary } from '../../transport/contracts'

export const STATE: Readonly<Record<string, string>> = { todo: 'To do', doing: 'Doing', review: 'In review', done: 'Done' }
export const STATE_TONE: Readonly<Record<string, string>> = { todo: 'todo', doing: 'progress', review: 'review', done: 'done' }
export const DAY_STATUS: Readonly<Record<string, string>> = {
  today: 'planned',
  in_progress: 'in progress',
  waiting_on_you: 'waiting on you',
  done: 'done',
  later: 'later',
  proposed: 'proposed',
}
export const SESSION_TONE: Readonly<Record<string, string>> = {
  starting: 'working',
  running: 'working',
  approval: 'needs',
  stopping: 'idle',
  stopped: 'idle',
  error: 'hot',
  idle: 'idle',
  queued: 'queued',
}
export const SESSION_STATE: Readonly<Record<string, string>> = {
  starting: 'starting',
  running: 'working',
  approval: 'needs you',
  stopping: 'stopping',
  stopped: 'stopped',
  error: 'failed',
  idle: 'ready',
  queued: 'queued',
}
/** The statuses in which a manager is still on its first run (the "Setting up" callout). */
export const MANAGER_BUSY = ['starting', 'running', 'approval', 'queued'] as const

/** Working days (Monday to Friday) from today to the end of the deadline day, as the legacy page counted them. */
export function daysLeft(deadline: string | null | undefined, now: number): number | null {
  if (!deadline) return null
  const end = new Date(`${deadline}T23:59:59`)
  if (Number.isNaN(end.getTime())) return null
  let count = 0
  for (const day = new Date(now); day < end; day.setDate(day.getDate() + 1)) {
    if (day.getDay() !== 0 && day.getDay() !== 6) count++
  }
  return count
}

/** A session tagged to a project; the project's own manager is not a member. */
export function membersOf(sessions: readonly SessionSummary[], projectId: string): SessionSummary[] {
  return sessions.filter(s => s.projectId === projectId && s.kind !== 'project')
}

export function managerOf(sessions: readonly SessionSummary[], project: Pick<Project, 'managerId'>): SessionSummary | undefined {
  return project.managerId ? sessions.find(s => s.managedId === project.managerId) : undefined
}

/** A project's file path as a link label: no scheme, no www, at most 60 characters. */
export const linkText = (url: string): string => url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60)

/** Keys for sections whose headings repeat: the second "Notes" is "Notes#2". */
export function sectionKeys(headings: readonly string[]): string[] {
  const seen = new Map<string, number>()
  return headings.map(heading => {
    const n = (seen.get(heading) ?? 0) + 1
    seen.set(heading, n)
    return n === 1 ? heading : `${heading}#${n}`
  })
}
