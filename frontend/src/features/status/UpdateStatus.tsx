// The update controller (F25), the first item of the top bar's actions. The server asks
// npm whether a newer Fleet exists; the pill appears only then, and nothing installs
// without a click. After an install the server hands its port to the new version: the
// page waits until /api/control reports a different instanceId or buildId (the old
// process keeps answering 200 until it exits, so an answer alone proves nothing), then
// reloads its assets. A deadline turns a server that never returns into a recovery
// message instead of a spinner.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useOptionalToast } from '../../components/Toast'
import { type UpdateStatus as UpdateInfo, parseUpdate } from '../../transport/contracts'
import { useFleetClient } from '../../transport/hooks'
import { page, waitForNewServer } from '../settings/handover'
import { errorText } from '../../transport/errors'
import { type UpdatePhase, UpdatePill } from './UpdatePill'

export const UPDATE_POLL_MS = 60 * 60 * 1000
/** The first check runs in the background on the server; ask again once it has had time. */
export const UPDATE_FIRST_RETRY_MS = 9000
export const RESTART_DEADLINE_MS = 60_000
export const RESTART_FAILED =
  'Fleet installed the update but did not come back. Start it again with claude-fleet or the Claude Fleet app; the reason is in ~/Library/Logs/claude-fleet.log.'

export function useUpdate() {
  const client = useFleetClient()
  const toast = useOptionalToast()
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [phase, setPhase] = useState<UpdatePhase>('idle')
  const [error, setError] = useState<string | null>(null)
  const phaseRef = useRef<UpdatePhase>('idle')
  const alive = useRef(true)
  const toastRef = useRef(toast)
  toastRef.current = toast

  const move = (next: UpdatePhase) => {
    phaseRef.current = next
    setPhase(next)
  }

  // Poll: now, once more after the server's first background check, then hourly. An
  // older server or no network means there is nothing to show, never an error.
  useEffect(() => {
    alive.current = true
    const abort = new AbortController()
    const installing = () => phaseRef.current === 'installing' || phaseRef.current === 'restarting'
    const poll = async () => {
      if (installing()) return
      try {
        const next = await client.getJson('/api/update', parseUpdate, { signal: abort.signal, timeoutMs: 8000 })
        if (alive.current && !installing()) setUpdate(next)
      } catch {
        // Nothing to show.
      }
    }
    void poll()
    const retry = setTimeout(poll, UPDATE_FIRST_RETRY_MS)
    const hourly = setInterval(poll, UPDATE_POLL_MS)
    return () => {
      alive.current = false
      abort.abort()
      clearTimeout(retry)
      clearInterval(hourly)
    }
  }, [client])

  const install = useCallback(async () => {
    if (!update?.canInstall || phaseRef.current === 'installing' || phaseRef.current === 'restarting') return
    move('installing')
    setError(null)
    // The server this page was loaded from; its replacement must report another identity.
    await client.store.refresh(client.resources.control).catch(() => {})
    const before = client.store.get(client.resources.control).data
    try {
      const next = parseUpdate(await client.post('/api/update', {}))
      if (!alive.current) return
      setUpdate(next)
      if (next.restarting) {
        move('restarting')
        const outcome = await waitForNewServer({
          client,
          previous: { instanceId: before?.instanceId, buildId: before?.buildId },
          deadlineMs: RESTART_DEADLINE_MS,
        })
        if (outcome === 'changed') return page.reload()
        if (!alive.current) return
        setError(RESTART_FAILED)
        move('error')
        toastRef.current?.(RESTART_FAILED)
        return
      }
      move('idle')
      toastRef.current?.(`v${next.installed} installed. Restart Fleet to use it.`)
    } catch (caught) {
      if (!alive.current) return
      const message = errorText(caught, 'The update could not be installed.')
      setError(message)
      setUpdate(current => (current ? { ...current, state: 'failed' } : current))
      move('error')
      toastRef.current?.(message)
    }
  }, [client, update])

  return { update, phase, error, install }
}

export function UpdateStatus() {
  const { update, phase, error, install } = useUpdate()
  return (
    <UpdatePill update={update} phase={phase} error={error} onInstall={() => void install()} />
  )
}
