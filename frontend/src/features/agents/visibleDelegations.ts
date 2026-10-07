// Which delegation rows a team session shows (F05), from public/app.js childTailHtml
// and childToggleHtml. Pure.
import type { DelegationSummary } from '../../transport/contracts'

/** An initiative that runs long accumulates delegations without bound; the list shows the tail. */
export const DELEGATION_ROW_LIMIT = 20

export const DELEGATION_LABEL: Readonly<Record<string, string>> = {
  running: 'Working',
  completed: 'Done',
  failed: 'Failed',
  interrupted: 'Interrupted',
}
export const DELEGATION_BADGE: Readonly<Record<string, string>> = {
  running: 'busy',
  completed: 'idle',
  failed: 'hot',
  interrupted: 'stale',
}

export const formatModel = (model: string | null | undefined): string => (model ? String(model).replace('claude-', '') : 'Model pending')

export interface VisibleDelegations {
  /** In display order: a selected row that aged out of the tail first, then the tail. */
  readonly shown: readonly DelegationSummary[]
  /** How many older rows are not drawn ("+N earlier"). */
  readonly earlier: number
}

/**
 * The most recent `limit` delegations, plus the selected one wherever it sits: the
 * parent row hands its pressed state to the child, so a selected delegation must be
 * drawn however old it is, or nothing in the list reads as selected.
 */
export function visibleDelegations(
  all: readonly DelegationSummary[],
  selectedId: string | null,
  limit = DELEGATION_ROW_LIMIT,
): VisibleDelegations {
  const recent = all.length > limit ? all.slice(-limit) : all
  const outside = selectedId && !recent.some(d => d.id === selectedId) ? all.find(d => d.id === selectedId) : undefined
  const shown = outside ? [outside, ...recent] : recent
  return { shown, earlier: all.length - shown.length }
}

/** "25 sub-agents · 1 working · 1 failed" */
export function delegationCounts(all: readonly DelegationSummary[]): string {
  const running = all.filter(d => d.status === 'running').length
  const failed = all.filter(d => d.status === 'failed').length
  return [`${all.length} sub-agent${all.length === 1 ? '' : 's'}`, running ? `${running} working` : '', failed ? `${failed} failed` : '']
    .filter(Boolean)
    .join(' · ')
}

/** The group's element id, from the parent's legacy key. */
export const delegationGroupId = (legacyKey: string): string => `children-${legacyKey.replace(/[^\w-]/g, '_')}`
