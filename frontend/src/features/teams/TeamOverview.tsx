// The initiative's overview above the conversation (F15): the team and who is active,
// the task board with verification state, handoffs with their assignment and report,
// and for owner + review the evidence that a reviewer passed the submitted tree. No
// budget or money controls: an initiative's only limit is its attempt count.
//
// Disclosures, the body's scroll position and focus survive refreshes because every
// task and handoff keeps its React key; nothing is redrawn from a string.
import { type RefObject, useMemo } from 'react'
import type { BoardDelegation, ControlFields, TaskBoard, TeamSnapshot } from '../../transport/contracts'
import { TaskCard } from './TaskCard'

export interface TeamOverviewProps {
  readonly fields: ControlFields
  readonly working: boolean
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly panelRef?: RefObject<HTMLDetailsElement | null>
}

const EMPTY_BOARD: TaskBoard = { tasks: [], delegations: [] }

/** The board to show, or null when this session is not a team initiative. */
export const overviewOf = (fields: ControlFields): TeamSnapshot | null => (fields.teamSnapshot?.workflow ? fields.teamSnapshot : null)

export function TeamOverview({ fields, working, open, onOpenChange, panelRef }: TeamOverviewProps) {
  const team = overviewOf(fields)
  const board = fields.taskBoard ?? EMPTY_BOARD
  const titles = useMemo(() => new Map(board.tasks.map(t => [t.id, t.title])), [board.tasks])
  const byTask = useMemo(() => {
    const map = new Map<string, BoardDelegation[]>()
    for (const d of board.delegations) {
      if (!d.taskId) continue
      const list = map.get(d.taskId) ?? []
      list.push(d)
      map.set(d.taskId, list)
    }
    return map
  }, [board.delegations])
  if (!team) return null
  const ownerReview = team.workflow?.mode === 'owner-review'
  const done = board.tasks.filter(t => t.status === 'verified').length
  const running = board.delegations.find(d => d.status === 'running')
  const activeRole = running?.role ?? (working ? team.manager : null)
  const maxAttempts = fields.limits?.maxAttempts ?? team.workflow?.maxAttempts
  const roles = Object.entries(team.roles)
  const managerModel = (fallback: string) =>
    fields.selectedModel ? (fields.selectedModel === 'auto-jev' ? fields.modelRouting?.model || 'Auto · Jev' : fields.selectedModel) : fallback

  return (
    <details
      ref={panelRef}
      id="initiative-board"
      open={open}
      onToggle={event => {
        if (event.currentTarget.open !== open) onOpenChange(event.currentTarget.open)
      }}
    >
      <summary>
        <strong>{fields.teamName ?? ''}</strong>
        <span>
          {done}/{board.tasks.length} verified
        </span>
      </summary>
      <div className="initiative-body">
        <div className="initiative-roster" aria-label="Team and active agent">
          {roles.map(([name, role], i) => (
            <RosterRole
              key={name}
              name={name}
              first={i === 0}
              active={activeRole === name}
              model={name === team.manager ? managerModel(role.model ?? '') : (role.model ?? '')}
              note={name === team.manager ? ' · your contact' : running?.role === name ? ' · working' : ''}
            />
          ))}
        </div>
        {board.tasks.length ? (
          <ol className="initiative-tasks">
            {board.tasks.map(task => (
              <TaskCard
                key={task.id}
                task={task}
                team={team}
                ownerReview={ownerReview}
                maxAttempts={maxAttempts}
                titles={titles}
                delegations={byTask.get(task.id) ?? NO_DELEGATIONS}
              />
            ))}
          </ol>
        ) : (
          <p className="note">
            {ownerReview
              ? 'Your owner is investigating the request. Acceptance criteria and review evidence will appear here.'
              : 'The manager is shaping your brief. Tasks and handoffs will appear here as work begins.'}
          </p>
        )}
        <p className="note">
          {ownerReview
            ? 'Verified means the reviewer passed the submitted Git tree. Later code changes make that review stale. PR delivery is reported by the owner.'
            : 'Verified means all configured verifiers returned passing reports for that task’s attempt.'}{' '}
          Expand a task to inspect the evidence.
        </p>
      </div>
    </details>
  )
}

const NO_DELEGATIONS: readonly BoardDelegation[] = []

function RosterRole({ name, first, active, model, note }: { name: string; first: boolean; active: boolean; model: string; note: string }) {
  return (
    <>
      {first ? null : (
        <span className="team-connector" aria-hidden="true">
          ·
        </span>
      )}
      <div className={`initiative-role${active ? ' is-active' : ''}`}>
        <strong>{name}</strong>
        <small>
          {model}
          {note}
        </small>
      </div>
    </>
  )
}
