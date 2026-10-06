// Connection state in words, never colour alone: the event stream, and whether the
// last list refresh failed while older data is still on screen.
import type { StreamStatus } from '../../transport/events'

const STREAM_LABEL: Record<StreamStatus, string> = {
  connecting: 'Connecting',
  open: 'Live',
  reconnecting: 'Reconnecting',
  closed: 'Offline',
}

export function ConnectionStatus({ stream, error }: { stream: StreamStatus; error: Error | null }) {
  return (
    <p role="status" aria-live="polite">
      <span>{STREAM_LABEL[stream]}</span>
      {error ? <span> · {error.message}</span> : null}
    </p>
  )
}
