// Talking to the Day agent or an item thread: the shared text composer on the draft
// store (features/composer), posting to the session's message route, with the
// console's Stop (or Cancel queued task) while it works. The draft is kept per
// session; a send that failed keeps its request id, so retrying the same words is
// the same message.
import { useFleetClient } from '../../transport/hooks'
import { TextComposer } from '../composer'
import { sessionCommand } from '../session-header/mutations'
import { StopButton } from '../session-header/StopButton'

export function DayComposer({ sessionId, placeholder, status }: { sessionId: string; placeholder: string; status: string | null | undefined }) {
  const client = useFleetClient()
  return (
    <TextComposer
      draftKey={`day:${sessionId}`}
      inputId={`day-message-${sessionId}`}
      label={placeholder.replace(/…$/, '')}
      placeholder={placeholder}
      className="day-composer"
      stop={status ? <StopButton managedId={sessionId} status={status} /> : null}
      send={(message, snapshot) => sessionCommand(client, sessionId, 'messages', { message, requestId: snapshot.requestId })}
    />
  )
}
