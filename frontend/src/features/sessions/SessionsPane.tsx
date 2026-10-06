// The Sessions view's list pane, inside div#sessions-pane (F02): the head with the
// shown count and the filter menu, the archive bar, the column head and the list.
// Ordering comes from the server (approval, then busy, then most recent).
import { useEffect, useMemo, useState } from 'react'
import { useSelection } from '../../app/AppStore'
import { selectionKey } from '../../app/state'
import { useNow } from '../../components/clock'
import {
  DEFAULT_ARCHIVE_RULE,
  dateCounts,
  effectiveFilter,
  emptyListText,
  partitionSessions,
  revealFilter,
  shownSessions,
} from '../../domain/sessions'
import { sessionKey } from '../../domain/ids'
import { useFleetClient, useResource } from '../../transport/hooks'
import { ArchiveBar } from '../archive/ArchiveBar'
import { FilterMenu } from './FilterMenu'
import { setSessionFilter, useSessionFilter } from './filter'
import { SessionList } from './SessionList'
import './sessions.css'

// Date filters move at local midnight and over a rolling week; a minute is plenty.
const DATE_RESOLUTION_MS = 60_000

export function SessionsPane() {
  const client = useFleetClient()
  const sessions = useResource(client.resources.sessions)
  const filter = useSessionFilter()
  const now = useNow(DATE_RESOLUTION_MS)
  const snapshot = sessions.data

  const partition = useMemo(() => (snapshot ? partitionSessions(snapshot) : null), [snapshot])
  const status = partition ? effectiveFilter(filter.status, partition) : filter.status
  // Restoring the last archived session should not strand the operator on an empty filter.
  useEffect(() => {
    if (status !== filter.status) setSessionFilter({ status })
  }, [status, filter.status])

  const shown = useMemo(() => (partition ? shownSessions(partition, status, filter.date, now) : null), [partition, status, filter.date, now])
  const counts = useMemo(() => (partition ? dateCounts(partition, now) : null), [partition, now])

  // A selection made elsewhere (Search's Open in Fleet, a Today launch chip) may point
  // at a row the active filter hides. Then the filter gives way, as if the operator had
  // chosen All, instead of the list reconciling the selection away. Checked once per
  // new selection: a filter the operator changes afterwards still reconciles normally.
  const selection = useSelection('sessions')
  const target = selection ? (selection.kind === 'delegation' ? `managed:${selection.parent}` : selectionKey(selection)) : null
  const [settled, setSettled] = useState<string | null>(null)
  const [reveal, setReveal] = useState<string | null>(null)
  const widen = partition && shown && target && target !== settled ? revealFilter(partition, shown, target, sessionKey) : null
  useEffect(() => {
    if (widen) {
      setSessionFilter(widen)
      setReveal(target)
    } else if (partition && target !== settled) setSettled(target)
  }, [widen, partition, target, settled])

  return (
    <>
      <header className="page-head list-pane-head">
        <div className="page-title">
          <h2>
            Agents{' '}
            <span id="shown-count" className="ui-count">
              {shown?.length ?? 0}
            </span>
          </h2>
        </div>
        {partition && counts ? (
          <div className="page-actions">
            <FilterMenu
              status={status}
              date={filter.date}
              counts={partition.counts}
              foreground={partition.foreground.length}
              background={partition.background.length}
              archived={partition.archived.length}
              dateCounts={counts}
            />
          </div>
        ) : null}
      </header>
      {partition && (status === 'dead' || status === 'archived') ? (
        <ArchiveBar filter={status} partition={partition} rule={snapshot?.archiveRule ?? DEFAULT_ARCHIVE_RULE} />
      ) : null}
      <div className="list-head">
        <span>SESSION / PROJECT</span>
        <span>CONTEXT</span>
      </div>
      {shown && partition ? (
        <SessionList
          rows={shown}
          spawnCounts={partition.spawnCounts}
          reconcile={!widen}
          reveal={reveal}
          empty={<EmptyText status={status} total={snapshot?.total ?? 0} />} />
      ) : (
        <div id="session-list" className="session-list">
          <div className="empty">{sessions.status === 'error' ? 'Waiting for the local server…' : 'Loading your sessions…'}</div>
        </div>
      )}
    </>
  )
}

function EmptyText({ status, total }: { status: Parameters<typeof emptyListText>[0]; total: number }) {
  const [first, second] = emptyListText(status, total)
  return (
    <div className="empty">
      {first}
      {second ? (
        <>
          <br />
          {second}
        </>
      ) : null}
    </div>
  )
}
