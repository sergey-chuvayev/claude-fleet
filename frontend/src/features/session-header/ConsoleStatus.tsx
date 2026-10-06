// The strips between the conversation and the composer: follow-ups waiting to send,
// and the session's error line (a failed turn, or a refresh that could not reach Fleet
// while the last good conversation stays on screen).
import type { QueuedMessage } from '../../transport/contracts'

const queuedText = (q: QueuedMessage): string => {
  if (q.message) return q.message
  const n = q.attachments?.length ?? 0
  return `${n} image${n === 1 ? '' : 's'}`
}

export function QueuedMessages({ queue }: { queue: readonly QueuedMessage[] }) {
  if (!queue.length) return <ul id="queued-messages" className="queued-messages" aria-label="Messages waiting to send" hidden />
  return (
    <ul id="queued-messages" className="queued-messages" aria-label="Messages waiting to send">
      {queue.map((q, i) => (
        // Queue entries have no id on older servers; their position is their identity.
        <li key={q.id ?? `#${i}`} className="queued-message">
          <span className="queued-index">#{i + 1}</span>
          <span className="queued-text">{queuedText(q)}</span>
          <span className="queued-label">Queued</span>
        </li>
      ))}
    </ul>
  )
}

export function AgentError({ text }: { text: string }) {
  return (
    <div id="agent-error" className="form-error" role="status" hidden={!text}>
      {text}
    </div>
  )
}
