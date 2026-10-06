// Placeholder (shell slot): the session list pane, inside div#sessions-pane. Replace
// this file with SessionList (F02, F03). It shows the legacy pane head and the names
// from the foundation, and demonstrates the selection contract: the component that
// owns the visible rows reconciles the selection against them, in display order.
import { useMemo } from 'react'
import { useReconcileSelection } from '../../app/AppStore'
import { type SelectionCandidate, selectionOf } from '../../app/state'
import { useFleetClient, useResource } from '../../transport/hooks'
import { SessionNameList } from './SessionNameList'

export function SessionsPane() {
  const client = useFleetClient()
  const sessions = useResource(client.resources.sessions)
  const shown = useMemo(() => sessions.data?.sessions.filter(row => !row.archived) ?? null, [sessions.data])
  const rows = useMemo<SelectionCandidate[] | null>(() => shown?.map(row => ({ selection: selectionOf(row) })) ?? null, [shown])
  useReconcileSelection('sessions', rows)

  return (
    <>
      <header className="page-head list-pane-head">
        <div className="page-title">
          <h2>
            Agents <span className="ui-count">{shown?.length ?? 0}</span>
          </h2>
        </div>
      </header>
      {shown ? (
        // The list scrolls inside the pane, as .session-list does once it is ported.
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <SessionNameList sessions={shown} />
        </div>
      ) : (
        <div className="empty">{sessions.status === 'error' ? 'Waiting for the local server…' : 'Loading your sessions…'}</div>
      )}
    </>
  )
}
