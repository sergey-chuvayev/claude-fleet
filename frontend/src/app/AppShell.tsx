// The foundation shell: proves the app boots, reads control and the session snapshot
// through the transport, and reports connection state. Not a visual port; the real
// top bar, navigation, list and inspector arrive with work package 4.
import { ConnectionStatus } from '../features/status/ConnectionStatus'
import { SessionNameList } from '../features/sessions/SessionNameList'
import { useFleetClient, useResource, useStreamStatus } from '../transport/hooks'

export function AppShell() {
  const client = useFleetClient()
  const control = useResource(client.resources.control)
  const sessions = useResource(client.resources.sessions)
  const stream = useStreamStatus()
  const snapshot = sessions.data

  return (
    <>
      <header>
        <h1>
          Fleet{control.data ? <small> v{control.data.version}</small> : null}
        </h1>
      </header>
      <main>
        {snapshot ? (
          <SessionNameList sessions={snapshot.sessions} />
        ) : sessions.status === 'error' ? (
          <p role="alert">Fleet could not load your sessions. {sessions.error?.message}</p>
        ) : (
          <p>Loading your sessions…</p>
        )}
      </main>
      <footer>
        <ConnectionStatus stream={stream} error={snapshot ? sessions.error : null} />
        {control.status === 'error' ? <p role="alert">Agent controls are unavailable. {control.error?.message}</p> : null}
      </footer>
    </>
  )
}
