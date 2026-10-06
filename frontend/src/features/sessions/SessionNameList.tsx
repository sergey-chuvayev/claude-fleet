// Foundation placeholder for the session list: names only, keyed by stable session
// identity. Work package 4 replaces it with SessionList/SessionRow.
import { memo } from 'react'
import { sessionKey, sessionLabel } from '../../domain/ids'
import type { SessionSummary } from '../../transport/contracts'

const Row = memo(function Row({ session }: { session: SessionSummary }) {
  return <li data-state={session.state}>{sessionLabel(session)}</li>
})

export function SessionNameList({ sessions }: { sessions: readonly SessionSummary[] }) {
  if (!sessions.length) return <p>No sessions yet.</p>
  return (
    <ul aria-label="Sessions">
      {sessions.map(session => (
        <Row key={sessionKey(session)} session={session} />
      ))}
    </ul>
  )
}
