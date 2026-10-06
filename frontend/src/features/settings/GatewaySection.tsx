// Settings, AI Gateway (F23): the key for automatic model selection. Save, test and
// remove go through one request at a time. The key lives only in this component's
// state, is cleared the moment it is sent and when the dialog closes, and is never
// written to storage, a URL or a log; the server never sends a saved key back.
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { type GatewayStatus, parseGatewayResponse } from '../../transport/contracts'
import { useFleetClient } from '../../transport/hooks'
import { errorText, getJson } from './rest'

type Action = 'save' | 'test' | 'remove'

const statusLine = (gateway: GatewayStatus | null): string =>
  !gateway
    ? 'Loading…'
    : gateway.source === 'saved'
      ? 'Configured · saved on this Mac. Overrides the environment key.'
      : gateway.source === 'environment'
        ? 'Configured · using AI_GATEWAY_API_KEY from the server environment.'
        : 'No key configured. Auto · Jev will use the Fleet preset.'

export function GatewaySection() {
  const client = useFleetClient()
  const [gateway, setGateway] = useState<GatewayStatus | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(true)
  const [result, setResult] = useState('')
  const ticket = useRef(0)
  const input = useRef<HTMLInputElement>(null)

  // The dialog closing ends everything: late answers are dropped and the key is gone
  // with the component.
  useEffect(() => {
    const abort = new AbortController()
    const mine = ++ticket.current
    getJson('/api/settings/gateway', { signal: abort.signal })
      .then(raw => {
        if (mine !== ticket.current) return
        setGateway(parseGatewayResponse(raw).gateway)
        setBusy(false)
        input.current?.focus()
      })
      .catch(caught => {
        if (mine !== ticket.current || abort.signal.aborted) return
        setResult(errorText(caught))
        setBusy(false)
      })
    return () => {
      ticket.current++
      abort.abort()
      setKey('')
    }
  }, [])

  const act = async (action: Action) => {
    if (busy) return
    const mine = ++ticket.current
    const body = action === 'save' ? { action, apiKey: key } : { action }
    setKey('')
    setResult(action === 'test' ? 'Testing…' : 'Saving changes…')
    setBusy(true)
    try {
      const answer = parseGatewayResponse(await client.post('/api/settings/gateway', body))
      if (mine !== ticket.current) return
      setGateway(answer.gateway)
      setResult(answer.testMessage || (action === 'save' ? 'Key saved. Ready for new Auto sessions.' : 'Saved key removed.'))
    } catch (caught) {
      if (mine === ticket.current) setResult(errorText(caught))
    } finally {
      if (mine === ticket.current) setBusy(false)
    }
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    void act('save')
  }

  return (
    <section className="settings-section" aria-labelledby="gateway-title">
      <h3 id="gateway-title">AI Gateway</h3>
      <p id="gateway-status" role="status">
        {statusLine(gateway)}
      </p>
      <form id="gateway-form" onSubmit={onSubmit}>
        <label htmlFor="gateway-key">Vercel AI Gateway API key</label>
        <input
          ref={input}
          id="gateway-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          maxLength={4096}
          placeholder="Paste your key"
          aria-describedby="gateway-help"
          required
          value={key}
          disabled={busy}
          onChange={event => setKey(event.target.value)}
        />
        <p className="note" id="gateway-help">
          Stored in a private file on this Mac, outside your projects. Fleet never sends the saved key back to this page.
        </p>
        <div className="gateway-actions">
          <button className="button resume" type="submit" disabled={busy}>
            Save key
          </button>
          <button className="button" id="gateway-test" type="button" disabled={busy || !gateway?.configured} onClick={() => void act('test')}>
            Test connection
          </button>
          <button className="button" id="gateway-remove" type="button" disabled={busy || gateway?.source !== 'saved'} onClick={() => void act('remove')}>
            Remove saved key
          </button>
        </div>
      </form>
      <p id="gateway-result" role="status" aria-live="polite">
        {result}
      </p>
      <p className="note">
        Select <strong>Auto · Jev</strong> when creating a session. New sessions use your saved key immediately; existing model decisions stay
        pinned.
      </p>
      <p className="note">
        Testing sends a short sample to Jev and may incur a small AI Gateway charge. Routing is billed separately from your Claude subscription.
      </p>
    </section>
  )
}
