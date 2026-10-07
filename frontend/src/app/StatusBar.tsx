// The status bar at the bottom (F01, F27): the account's plan windows (a slot owned
// by features/status), how many agents are working and how many need you, and the
// connection. Ambient telemetry; actions live in the top bar.
import { clockAtSeconds } from '../domain/format'
import { UsageStatus } from '../features/status/UsageStatus'
import type { SessionSummary } from '../transport/contracts'
import type { StreamStatus } from '../transport/events'
import { useFleetClient, useResource, useStreamStatus } from '../transport/hooks'

interface Elsewhere {
  readonly state?: string
}

/** Working right now, as the legacy row decided it: a terminal holding it, else Fleet's own status, else the process. */
export function isWorkingRow(row: SessionSummary): boolean {
  const elsewhere = row.openElsewhere as Elsewhere | null | undefined
  if (elsewhere) return elsewhere.state === 'busy'
  if (row.managed) return ['starting', 'running', 'stopping'].includes(row.managedStatus ?? '')
  return row.state === 'busy'
}

const CONNECTION: Record<StreamStatus, { readonly label: string; readonly tone: string }> = {
  connecting: { label: 'Connecting', tone: 'busy' },
  open: { label: 'Live connection', tone: 'busy' },
  reconnecting: { label: 'Reconnecting', tone: 'stale' },
  closed: { label: 'Offline', tone: 'dead' },
}

export function StatusBar() {
  const client = useFleetClient()
  const sessions = useResource(client.resources.sessions)
  const stream = useStreamStatus()
  const snapshot = sessions.data
  const live = snapshot?.sessions.filter(row => !row.archived) ?? []
  const working = live.filter(isWorkingRow).length
  const waiting = live.filter(row => row.managed && row.managedStatus === 'approval').length
  const connection = sessions.error ? { label: 'Disconnected', tone: 'stale' } : CONNECTION[stream]
  const updated = snapshot ? (snapshot.generatedAt ? `Updated ${clockAtSeconds(snapshot.generatedAt)}` : 'Updated') : 'Waiting for first snapshot'

  return (
    <footer className="statusbar" id="statusbar">
      <div className="status-usage" id="status-usage">
        <UsageStatus usage={snapshot?.usage} />
      </div>
      <div className="status-fleet" id="status-fleet">
        {snapshot ? (
          <>
            <span>{working} working</span>
            {waiting ? (
              <>
                <span className="status-sep" aria-hidden="true">
                  ·
                </span>
                <span className="warn">{waiting} needs you</span>
              </>
            ) : null}
          </>
        ) : null}
      </div>
      <div className="status-conn">
        <span id="connection-dot" className={`dot ${connection.tone}`} />
        <span id="connection" role="status">
          {connection.label}
        </span>
        <span id="updated">{updated}</span>
        <span className="local">LOCAL CONTROL ROOM</span>
      </div>
    </footer>
  )
}
