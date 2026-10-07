// Settings, Startup (F23): run Fleet as a background service (macOS launchd). Turning it
// on hands this server to the OS, which starts it again at once, so the page waits for
// the new process (a different instanceId or buildId, never just an answer from the old
// one) and then reloads its assets.
import { useEffect, useState } from 'react'
import { type ServiceStatus, parseService, parseServiceChange } from '../../transport/contracts'
import { useFleetClient } from '../../transport/hooks'
import { page, waitForNewServer } from './handover'
import { errorText } from '../../transport/errors'

export const HANDOVER_FAILED =
  'Fleet did not come back. Open the Claude Fleet app, or see ~/Library/Logs/claude-fleet.log.'

export function StartupSection() {
  const client = useFleetClient()
  const [service, setService] = useState<ServiceStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const abort = new AbortController()
    client
      .getJson('/api/service', parseService, { signal: abort.signal, timeoutMs: 8000 })
      .then(setService)
      .catch(() => {})
    return () => abort.abort()
  }, [client])

  const toggle = async (enabled: boolean) => {
    if (busy) return
    setBusy(true)
    setError(null)
    // The identity this page came from; the new server must differ from it.
    await client.store.refresh(client.resources.control).catch(() => {})
    const previous = client.store.get(client.resources.control).data
    try {
      const answer = parseServiceChange(await client.post('/api/service', { enabled }))
      setService(answer.service)
      if (answer.restarting) {
        const outcome = await waitForNewServer({ client, previous: { instanceId: previous?.instanceId, buildId: previous?.buildId } })
        if (outcome === 'changed') return page.reload()
        setError(HANDOVER_FAILED)
      }
    } catch (caught) {
      setError(errorText(caught))
    }
    setBusy(false)
  }

  const status = !service
    ? 'Checking…'
    : !service.supported
      ? 'Available on macOS. Elsewhere, keep claude-fleet running in a terminal or your own service manager.'
      : busy
        ? 'Handing Fleet over to macOS…'
        : !service.enabled
          ? 'Off. Fleet runs while the app or a terminal keeps it running.'
          : service.managed
            ? 'On. Fleet is running as a background service.'
            : 'On. Fleet starts as a service at your next login.'

  return (
    <section className="settings-section" aria-labelledby="startup-title">
      <h3 id="startup-title">Startup</h3>
      <p className="note">
        Run Fleet in the background, without a terminal: it starts when you log in, comes back if it ever stops, and updates from the Update
        button.
      </p>
      <div className="settings-row">
        <label className="settings-toggle">
          <input
            type="checkbox"
            id="service-enabled"
            checked={!!service?.supported && service.enabled}
            disabled={!service || !service.supported || busy}
            onChange={event => void toggle(event.target.checked)}
          />{' '}
          Start Fleet at login and keep it running
        </label>
      </div>
      <p className="note" id="service-status" role="status">
        {status}
      </p>
      {error ? (
        <p className="form-error" id="service-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  )
}
