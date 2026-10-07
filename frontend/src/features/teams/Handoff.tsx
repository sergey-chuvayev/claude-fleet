// One handoff from the manager to a role (F15): its state, the model the delegation
// actually ran on, and the assignment and report, each behind its own disclosure that
// starts collapsed and stays as the operator left it through every refresh.
import { memo } from 'react'
import { Disclosure } from '../../components/Disclosure'
import type { BoardDelegation, TeamSnapshot } from '../../transport/contracts'

/**
 * The model a delegation reported wins; the role's configured model is only a fallback
 * for one that has not reported yet (still running, or resumed before its first event).
 */
export const handoffModel = (team: TeamSnapshot, delegation: BoardDelegation): string =>
  delegation.model || team.roles[delegation.role]?.model || ''

export interface HandoffProps {
  readonly team: TeamSnapshot
  readonly delegation: BoardDelegation
}

export const Handoff = memo(function Handoff({ team, delegation: d }: HandoffProps) {
  const model = handoffModel(team, d)
  return (
    <Disclosure
      className="initiative-handoff"
      data-evidence={d.id}
      summary={
        <>
          {team.manager} → {d.role}{' '}
          <span>
            {d.status}
            {d.activity && d.status === 'running' ? ` · ${d.activity}` : ''}
          </span>
          {model ? <small>{model}</small> : null}
        </>
      }
    >
      <Disclosure className="handoff-mandate" data-evidence={`${d.id}-mandate`} summary="Assignment">
        <pre>{d.prompt ?? ''}</pre>
      </Disclosure>
      <Disclosure className="handoff-report" data-evidence={`${d.id}-report`} summary={`Report to ${team.manager}`}>
        <pre>{d.report || 'Waiting for the agent’s report.'}</pre>
      </Disclosure>
    </Disclosure>
  )
}, sameHandoff)

function sameHandoff(a: HandoffProps, b: HandoffProps): boolean {
  if (a.delegation === b.delegation && a.team === b.team) return true
  return (
    a.team.manager === b.team.manager &&
    handoffModel(a.team, a.delegation) === handoffModel(b.team, b.delegation) &&
    JSON.stringify(a.delegation) === JSON.stringify(b.delegation)
  )
}
