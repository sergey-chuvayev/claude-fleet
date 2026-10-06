// Pure helpers of the review loop strip (F30), ported unchanged from public/review.js
// (prLinks, ciFeedback, problem, names) with the same tests.
import type { PrStatus, SessionLink } from '../../../transport/contracts'

const LISTED = 5
// A Day, a project manager or an item thread mentions PRs other sessions opened, and
// feedback sent to them would reach the wrong agent.
const COORDINATORS = ['day', 'project', 'thread']

/** The pull requests worth tracking for a session: the latest three GitHub PR links it mentioned. */
export function prLinks(session: { kind?: string | null | undefined; links?: readonly SessionLink[] | null | undefined } | null | undefined): SessionLink[] {
  if (!session || COORDINATORS.includes(session.kind ?? '')) return []
  return (session.links ?? []).filter(link => link.kind === 'pr' && /^https:\/\/github\.com\//.test(link.url)).slice(-3)
}

export const names = (list: readonly string[]): string =>
  list.length > LISTED ? `${list.slice(0, LISTED).join(', ')} and ${list.length - LISTED} more` : list.join(', ')

/** "CI failed on build, lint (PR #12). Fix it and push." for every PR whose CI is red. */
export function ciFeedback(statuses: readonly (PrStatus | null | undefined)[]): string {
  const failed = statuses.filter((s): s is Extract<PrStatus, { ok: true }> => !!s && s.ok && s.ci.result === 'fail')
  if (!failed.length) return ''
  return failed.map(s => `CI failed on ${names(s.ci.failing)}${s.number ? ` (PR #${s.number})` : ''}. Fix it and push.`).join(' ')
}

const PROBLEM: Readonly<Record<string, string>> = {
  missing: 'The gh CLI is not installed, so PR status is unavailable.',
  unauthenticated: 'gh is not signed in. Run gh auth login to see PR status.',
  'rate-limited': 'GitHub is rate limiting gh. PR status will retry in a few minutes.',
  'not-found': 'gh cannot see this pull request.',
  invalid: 'This is not a GitHub pull request link.',
  failed: 'gh could not read this pull request.',
}
export const problem = (reason: string | null | undefined): string => PROBLEM[reason ?? ''] ?? PROBLEM.failed!

export const STATE: Readonly<Record<string, readonly [string, string]>> = {
  open: ['Open', 'running'],
  merged: ['Merged', 'done'],
  closed: ['Closed', 'hot'],
  unknown: ['Unknown', 'idle'],
}
export const CI_LABEL: Readonly<Record<string, readonly [string, string]>> = {
  pass: ['CI passing', 'done'],
  fail: ['CI failing', 'hot'],
  pending: ['CI running', 'needs'],
  none: ['No CI', 'idle'],
}
