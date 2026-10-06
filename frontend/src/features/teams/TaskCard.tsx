// One task on the initiative board (F15): its verification state, owner and attempt,
// acceptance criteria, owner-review evidence (the reviewed commit and how many
// implementations and review errors the request has used), blocker, dependencies,
// and the handoffs made for it.
import { memo } from 'react'
import { Disclosure } from '../../components/Disclosure'
import type { BoardDelegation, BoardTask, TeamSnapshot } from '../../transport/contracts'
import { Handoff } from './Handoff'

export interface TaskCardProps {
  readonly task: BoardTask
  readonly team: TeamSnapshot
  readonly ownerReview: boolean
  /** The request's implementation limit: the session's limits, else the team's workflow. */
  readonly maxAttempts: number | undefined
  /** Titles of every task on the board, for "After: …". */
  readonly titles: ReadonlyMap<string, string>
  readonly delegations: readonly BoardDelegation[]
}

export const TaskCard = memo(function TaskCard({ task: t, team, ownerReview, maxAttempts, titles, delegations }: TaskCardProps) {
  return (
    <li>
      <Disclosure
        data-evidence={t.id}
        summary={
          <>
            <span className="task-state" data-state={t.status}>
              {t.status.replaceAll('_', ' ')}
            </span>
            <strong>{t.title}</strong>
            <small>
              {t.owner ?? ''} · {ownerReview ? 'reviewed implementation' : 'attempt'} {t.attempt ?? 0}
            </small>
          </>
        }
      >
        <ul>
          {(t.criteria ?? []).map((criterion, i) => (
            <li key={`${i}:${criterion}`}>{criterion}</li>
          ))}
        </ul>
        {ownerReview && t.snapshot ? (
          <p className="note">
            Review commit: {t.snapshot.commit.slice(0, 12)} · {t.attempt ?? 0}/{maxAttempts ?? '?'} implementations submitted · {t.reviewErrors ?? 0}/2 review
            execution errors
          </p>
        ) : null}
        {t.blocker ? <p className="form-error">{t.blocker}</p> : null}
        {t.dependencies?.length ? <p className="note">After: {t.dependencies.map(id => titles.get(id) ?? id).join(', ')}</p> : null}
        {delegations.map(d => (
          <Handoff key={d.id} team={team} delegation={d} />
        ))}
      </Disclosure>
    </li>
  )
})
