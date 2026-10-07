// The banner under the top bar (#error): a lost connection, or the server's storage
// error. The storage error is the server's latch: it clears when a write lands, not
// when a read succeeds (0.50), so the banner shows exactly what the snapshot says.
import { useFleetClient, useResource } from '../transport/hooks'

export function Banner() {
  const client = useFleetClient()
  const sessions = useResource(client.resources.sessions)
  const message = sessions.error
    ? sessions.data
      ? 'Connection lost. Showing the last successful snapshot; retrying automatically.'
      : 'Unable to connect to the local server. Retrying automatically.'
    : (sessions.data?.storageError ?? null)
  return (
    <div id="error" className="error" role="status" hidden={!message}>
      {message}
    </div>
  )
}
