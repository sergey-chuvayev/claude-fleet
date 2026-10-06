// The Today tab's console (shell slot, inside aside#detail): the Day agent's
// conversation, or one item's thread, or one of its subagents' runs. Tabs above it
// switch between them. A thread is an app selection ('day-thread', by item); a
// subagent tab is local to the console, and a selected earlier run stays selected
// when a newer run of the same scout arrives. Subagents answer to the Day, not to
// you, so a subagent view is read-only: no composer.
import { useEffect, useState } from 'react'
import { useActions, useSelection } from '../../app/AppStore'
import type { DayItemId, ManagedId } from '../../domain/ids'
import { useToast } from '../../components/Toast'
import type { DayItem, DaySubagent } from '../../transport/contracts'
import { Conversation, toolLabel } from '../conversation'
import { clip, isWorking, type RowInfo } from './day'
import { DayComposer } from './DayComposer'
import { DayTabs } from './DayTabs'
import { groupBoardEvents } from './groupBoardEvents'
import { ScoutView } from './ScoutView'
import { useDayDetail, useTodayRows } from './useDay'
import '../../styles/today.css'

export function DayConsole() {
  const today = useTodayRows()
  const dayId = today.day?.managedId
  if (!dayId) {
    return (
      <div className="console-empty">
        <strong>Your Day agent</strong>
        <span>Its conversation appears here once you start your day.</span>
      </div>
    )
  }
  return <DayConsoleView key={dayId} dayId={dayId} rows={today.rows} />
}

const NO_ITEMS: readonly DayItem[] = []
const NO_SUBAGENTS: readonly DaySubagent[] = []

/** The open thread an item selection points at, when it belongs to this Day. */
function threadOf(itemId: string | null, items: readonly DayItem[], rows: ReadonlyMap<string, RowInfo>, dayId: string): string | null {
  if (!itemId) return null
  const thread = items.find(i => i.id === itemId)?.thread
  if (!thread || thread.closed) return null
  const row = rows.get(thread.sessionId)
  // A thread the list already knows must still be open and be this Day's own.
  if (row && (!row.threadOpen || row.parentDayId !== dayId)) return null
  return thread.sessionId
}

function DayConsoleView({ dayId, rows }: { dayId: string; rows: ReadonlyMap<string, RowInfo> }) {
  const toast = useToast()
  const { select, clearSelection, openModal } = useActions()
  const selection = useSelection('today')
  const { session, detail, items } = useDayDetail(dayId)
  const [agentId, setAgentId] = useState<string | null>(null)

  const loaded = !!detail
  const board = loaded ? items : NO_ITEMS
  const subagents = detail?.subagents ?? NO_SUBAGENTS
  const selectedItem = selection?.kind === 'day-thread' ? selection.itemId : null
  const threadId = threadOf(selectedItem, board, rows, dayId)

  // A thread that closed (its item settled) or never belonged to this Day hands the
  // console back to the Day agent.
  useEffect(() => {
    if (loaded && selectedItem && !threadId) clearSelection('today')
  }, [loaded, selectedItem, threadId, clearSelection])

  // A subagent shown is one that still exists; a thread outranks it.
  const shownAgent = !threadId && agentId ? (subagents.find(d => d.id === agentId) ?? null) : null
  const shownId = threadId ?? dayId
  const threadItem = threadId ? board.find(i => i.thread?.sessionId === threadId) : undefined
  const threadRow = threadId ? rows.get(threadId) : undefined

  const showDay = () => {
    setAgentId(null)
    clearSelection('today')
  }
  const showThread = (itemId: string) => {
    setAgentId(null)
    select({ kind: 'day-thread', itemId: itemId as DayItemId })
  }
  const showAgent = (id: string) => {
    setAgentId(id)
    if (threadId) clearSelection('today')
  }

  const title = threadId ? `About: ${threadRow?.name ?? threadItem?.title ?? 'this item'}` : 'Day agent'
  const status = threadId ? threadRow?.status : session?.status
  const contextTokens = threadId ? null : detail?.contextTokens
  const share = contextTokens ? Math.min(100, Math.round((contextTokens / (detail?.contextLimit || 200000)) * 100)) : null

  return (
    <section id="control-panel" className="day-console" aria-label="Day agent controls" data-session={shownId}>
      <div className="conversation-header">
        <div className="header-title">
          <h3 id="conversation-title" title={title}>
            {clip(title, 80)}
          </h3>
          {share !== null ? (
            <span className={`subtle context-chip${share >= 90 ? ' hot' : share >= 75 ? ' warn' : ''}`} title={`${contextTokens?.toLocaleString()} tokens used`}>
              {share}%
            </span>
          ) : null}
          <ConsoleState status={status} currentTool={threadId ? null : detail?.currentTool} queued={threadId ? 0 : (detail?.queue?.length ?? 0)} />
        </div>
        <div className="header-controls">
          <span
            className="subtle day-gate-note"
            title="Slack messages, Linear changes and GitHub reviews go out only after you approve the exact text on the board."
          >
            Sends need your approval
          </span>
          <button type="button" id="agent-connections" className="button" onClick={() => openModal({ kind: 'connections', managedId: shownId as ManagedId })}>
            Connections
          </button>
        </div>
      </div>
      <DayTabs
        dayId={dayId}
        items={board}
        subagents={subagents}
        rows={rows}
        threadId={threadId}
        agentId={shownAgent?.id ?? null}
        onDay={showDay}
        onThread={showThread}
        onAgent={showAgent}
      />
      {shownAgent ? (
        <ScoutView run={shownAgent} runs={subagents} onPick={setAgentId} />
      ) : (
        <>
          {/* Keyed: switching between the Day and a thread starts a fresh log with its own read position. */}
          <Conversation key={shownId} sessionKey={`managed:${shownId}`} onNotice={toast} present={groupBoardEvents} />
          <DayComposer
            key={`composer:${shownId}`}
            sessionId={shownId}
            working={isWorking(status)}
            placeholder={threadId ? 'Ask about this item…' : 'Ask your day agent…'}
          />
        </>
      )}
    </section>
  )
}

const STATE_TEXT: Readonly<Record<string, string>> = {
  starting: 'Starting Claude…',
  running: 'Working on your task',
  approval: 'Your input is needed',
  stopping: 'Stopping the agent…',
  stopped: 'Stopped · ready to continue',
  error: 'Turn failed',
  idle: 'Ready for your next message',
  queued: 'Queued · waiting for a free slot',
}

function ConsoleState({ status, currentTool, queued }: { status: string | null | undefined; currentTool: string | null | undefined; queued: number }) {
  const tool = currentTool ? toolLabel(currentTool) : null
  const text = status === 'running' && tool ? (tool === 'Board' ? 'Updating the board…' : `Using ${tool}`) : (STATE_TEXT[status ?? ''] ?? '')
  return (
    <span id="agent-state" className={`subtle${status === 'approval' ? ' stale' : ''}`}>
      {text}
      {queued ? ` · ${queued} queued` : ''}
    </span>
  )
}
