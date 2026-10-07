// The strip above the Day's console: the Day agent, each open item thread, and one
// tab per subagent role holding its latest run. It earns its row only once there is
// something to switch to.
import { PixelRun } from '../../components/PixelRun'
import type { DayItem, DaySubagent } from '../../transport/contracts'
import { AGENT_STATE, type RowInfo, byRole, clip, scoutName } from './day'

const THREAD_DOT: Readonly<Record<string, string>> = { starting: 'busy', running: 'busy', approval: 'stale', error: 'hot' }

export interface DayTabsProps {
  readonly dayId: string
  readonly items: readonly DayItem[]
  readonly subagents: readonly DaySubagent[]
  readonly rows: ReadonlyMap<string, RowInfo>
  readonly threadId: string | null
  readonly agentId: string | null
  readonly onDay: () => void
  readonly onThread: (itemId: string) => void
  readonly onAgent: (id: string) => void
}

export function DayTabs({ items, subagents, rows, threadId, agentId, onDay, onThread, onAgent }: DayTabsProps) {
  const threads = items.filter(i => i.thread && !i.thread.closed)
  const groups = byRole(subagents)
  const shownRole = agentId ? subagents.find(d => d.id === agentId)?.role : undefined
  const running = subagents.filter(d => d.status === 'running').length
  return (
    <nav id="day-agents" aria-label="Day agent, item threads and subagents" hidden={!subagents.length && !threads.length}>
      <button type="button" className="day-agent-tab" aria-pressed={!threadId && !agentId} onClick={onDay}>
        Day agent
      </button>
      {threads.map(item => {
        const id = item.thread?.sessionId ?? ''
        return (
          <button
            key={id}
            type="button"
            className="day-agent-tab is-thread"
            data-thread={id}
            aria-pressed={threadId === id}
            title={`Your conversation about: ${item.title}`}
            onClick={() => onThread(item.id)}
          >
            <span className={`dot ${THREAD_DOT[rows.get(id)?.status ?? ''] ?? 'idle'}`} />
            {clip(item.title, 28)}
          </button>
        )
      })}
      {groups.map(group => {
        const live = group.latest.status === 'running'
        const count = group.runs.length
        return (
          <button
            key={group.role}
            type="button"
            className={`day-agent-tab${live ? ' is-live' : ''}`}
            data-agent={group.latest.id}
            aria-pressed={shownRole === group.role}
            title={`${group.latest.description || group.role} · ${count} run${count === 1 ? '' : 's'} today`}
            onClick={() => onAgent(group.latest.id)}
          >
            {live ? <PixelRun label={`${scoutName(group.role)} is running`} /> : <span className={`dot ${AGENT_STATE[group.latest.status] ?? ''}`} />}
            {scoutName(group.role)}
            {count > 1 ? <span className="ui-count">{count}</span> : null}
          </button>
        )
      })}
      {running ? <span className="note day-agents-running">{running} running</span> : null}
    </nav>
  )
}
