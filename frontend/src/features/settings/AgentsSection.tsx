// Settings, Agents (F23): the queue (enabled, limit 1 to 8, pause/resume) and the
// approval mode new agents start with.
//
// The server owns the queue. This shows what it says (the list snapshot, else control),
// sends one change at a time, and shows the answer until the next push; a refusal (for
// example turning the queue off while tasks wait: CONFLICT) is explained and the
// controls fall back to what the server holds. The default approval mode applies to
// agents created from now on; running agents keep theirs.
import { useEffect, useState } from 'react'
import { Select } from '../../components/Select'
import { type ApprovalMode, type QueueState, parseApprovalModeResponse, parseQueueResponse } from '../../transport/contracts'
import { keys, mutationInvalidates } from '../../transport/resources'
import { useFleetClient, useResource } from '../../transport/hooks'
import { errorText, getJson } from './rest'

const LIMITS = Array.from({ length: 8 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))
const MODES: ReadonlyArray<{ value: ApprovalMode; label: string }> = [
  { value: 'all', label: 'Approve everything' },
  { value: 'auto', label: 'Auto · ask for risky commands' },
  { value: 'ask', label: 'Ask every time' },
]

export function AgentsSection() {
  const client = useFleetClient()
  const control = useResource(client.resources.control).data
  const snapshot = useResource(client.resources.sessions).data
  const pushed = snapshot?.queue ?? control?.queue ?? null
  const [posted, setPosted] = useState<QueueState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Whatever the server pushes next is more authoritative than our last answer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the pushed value moves
  useEffect(() => setPosted(null), [pushed])
  const queue = posted ?? pushed

  const change = async (patch: Record<string, unknown>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const next = parseQueueResponse(await client.post('/api/queue', patch, { invalidate: mutationInvalidates.queue() }))
      setPosted(next)
    } catch (caught) {
      setError(errorText(caught))
      setPosted(null)
    } finally {
      setBusy(false)
    }
  }

  const [mode, setMode] = useState<ApprovalMode | null>(null)
  const [modeError, setModeError] = useState<string | null>(null)
  const shownMode = mode ?? control?.defaultApprovalMode ?? 'all'
  useEffect(() => {
    const abort = new AbortController()
    getJson('/api/settings/approval-mode', { signal: abort.signal })
      .then(raw => setMode(parseApprovalModeResponse(raw)))
      .catch(() => {})
    return () => abort.abort()
  }, [])
  const saveMode = async (next: ApprovalMode) => {
    setModeError(null)
    try {
      const saved = parseApprovalModeResponse(await client.post('/api/settings/approval-mode', { mode: next }))
      setMode(saved)
      // The launch form reads its default from control.
      client.store.invalidate(keys.control)
    } catch (caught) {
      setModeError(errorText(caught))
    }
  }

  return (
    <section className="settings-section" aria-labelledby="queue-title">
      <h3 id="queue-title">Agents</h3>
      <p className="note">With queuing on, a task over the limit waits for a free slot instead of being refused.</p>
      <div className="settings-row">
        <label className="settings-toggle">
          <input
            type="checkbox"
            id="queue-enabled"
            checked={!!queue?.enabled}
            disabled={busy || !queue}
            onChange={event => void change({ enabled: event.target.checked })}
          />{' '}
          Queue tasks over the limit
        </label>
        <label className="settings-field">
          Concurrent agents
          <Select
            id="queue-limit"
            label="Concurrent agents"
            value={String(queue?.limit || 4)}
            options={LIMITS}
            disabled={busy || !queue}
            onChange={value => void change({ limit: Number(value) })}
          />
        </label>
        {queue?.enabled ? (
          <button className="button" id="queue-pause" type="button" disabled={busy} onClick={() => void change({ paused: !queue.paused })}>
            {queue.paused ? 'Resume queue' : 'Pause queue'}
          </button>
        ) : null}
      </div>
      <p className="note" id="queue-status" role="status">
        {queue
          ? `${queue.running}/${queue.limit} running · ${queue.waiting} waiting${queue.paused ? ' · paused: running agents continue, new ones wait' : ''}`
          : ''}
      </p>
      {error ? (
        <p className="form-error" id="queue-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="settings-row">
        <label className="settings-field">
          Default approval mode for new agents
          <Select
            id="default-approval-mode"
            label="Default approval mode for new agents"
            value={shownMode}
            options={MODES}
            onChange={value => void saveMode(value)}
          />
        </label>
      </div>
      <p className="note" id="approval-status" role="status">
        Applies to agents you create from now on. Existing agents keep their mode, and you can still pick another when you launch one.
      </p>
      {modeError ? (
        <p className="form-error" id="approval-error" role="alert">
          {modeError}
        </p>
      ) : null}
    </section>
  )
}
