// Stop the running turn, or cancel a task still waiting in the queue. The server's
// lifecycle decides what stops (queued follow-ups go with it); the console only reads
// the session again. Shown while the agent works or waits for a slot.
import { useState } from 'react'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { useFleetClient } from '../../transport/hooks'
import { isWorking } from '../conversation/format'
import { failureText, sessionCommand } from './mutations'

export function StopButton({ managedId, status }: { managedId: string; status: string }) {
  const client = useFleetClient()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const queued = status === 'queued'
  if (!isWorking(status) && !queued) return null
  const stop = () => {
    if (busy) return
    setBusy(true)
    sessionCommand(client, managedId, 'stop', {})
      .catch(error => toast(failureText(error)))
      .finally(() => setBusy(false))
  }
  return (
    <button id="stop-agent" type="button" className="button stop" disabled={busy || status === 'stopping'} onClick={stop}>
      {queued ? (
        'Cancel queued task'
      ) : (
        <>
          <Icon name="stop" /> Stop
        </>
      )}
    </button>
  )
}
