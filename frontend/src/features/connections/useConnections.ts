// The Connections controller (F22): one target (a live managed session, or a project
// directory), the last check of its MCP servers, and the sign-ins under way.
//
// Every request is numbered. An answer that arrives after the target changed, after a
// newer request, or after the dialog closed is dropped, so a slow check of project A
// can never paint over project B, and no action is ever sent for a target that was
// replaced: each action carries the `connectionId` and `source` of the check it was
// made from, the server refuses a stale one with a 409, and a refusal here means "look
// again", never "send it anyway".
import { useCallback, useEffect, useRef, useState } from 'react'
import { useOptionalToast } from '../../components/Toast'
import { type ConnectionResult, parseConnections } from '../../transport/contracts'
import { HttpError } from '../../transport/errors'
import { useFleetClient } from '../../transport/hooks'
import { errorText } from '../settings/rest'

export type ConnectionAction = 'check' | 'reconnect' | 'enable' | 'disable' | 'authenticate'

/** A sign-in the operator is finishing in their browser. */
export interface SignInWait {
  readonly url: string | null
  readonly opened: boolean
  readonly since: number
  /** A claude.ai connector is reconnected so Claude fetches the new authorization. */
  readonly claudeai: boolean
}

export const SIGN_IN_TIMEOUT_MS = 5 * 60_000
export const POLL_MS = 4000
export const SETTLE_MS = 2500
export const SETTLE_ROUNDS = 8

/** "claude.ai Google Calendar" reads as "Google Calendar" with a Claude.ai badge. */
export const displayName = (server: { name: string; scope?: string | undefined }): string =>
  server.scope === 'claudeai' ? server.name.replace(/^claude\.ai\s+/i, '') : server.name

const STALE = /Check connections again|expired/

export interface ConnectionsTarget {
  /** A managed session id, or '' to check a project directory. */
  readonly sessionId: string
  readonly cwd: string
}

export function useConnections(target: ConnectionsTarget) {
  const client = useFleetClient()
  const toast = useOptionalToast()
  const [result, setResult] = useState<ConnectionResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<Readonly<Record<string, SignInWait>>>({})
  const [focusAfter, setFocusAfter] = useState<{ name: string; action: ConnectionAction } | null>(null)

  const ticket = useRef(0)
  const resultRef = useRef<ConnectionResult | null>(null)
  const busyRef = useRef(false)
  const pendingRef = useRef<Readonly<Record<string, SignInWait>>>({})
  const targetRef = useRef(target)
  targetRef.current = target
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const alive = useRef(true)
  const toastRef = useRef(toast)
  toastRef.current = toast

  const commitResult = (next: ConnectionResult | null) => {
    resultRef.current = next
    setResult(next)
  }
  const commitPending = (next: Readonly<Record<string, SignInWait>>) => {
    pendingRef.current = next
    setPending(next)
  }
  const commitBusy = (next: boolean) => {
    busyRef.current = next
    setBusy(next)
  }
  // The lease (connectionId and source) of the last check is no longer good.
  const forgetLease = () => {
    const current = resultRef.current
    if (!current) return
    const { connectionId: _lease, ...rest } = current
    commitResult(rest)
  }
  const clearTimers = () => {
    if (pollTimer.current) clearTimeout(pollTimer.current)
    if (settleTimer.current) clearTimeout(settleTimer.current)
    pollTimer.current = null
    settleTimer.current = null
  }

  // Closing the dialog is the end of every request and timer it started.
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      busyRef.current = false
      ticket.current++
      clearTimers()
    }
  }, [])

  /** The target changed (another session, another directory): nothing known carries over. */
  const reset = useCallback(() => {
    ticket.current++
    clearTimers()
    commitResult(null)
    commitPending({})
    commitBusy(false)
    setError(null)
  }, [])

  // One path for every request. A quiet one (the sign-in poll, the settle look) neither
  // disables the panel nor shows errors, so it can run while the operator reads or types.
  const call = useCallback(
    async (action: ConnectionAction, name?: string, quiet = false): Promise<ConnectionResult | null> => {
      if (busyRef.current) return null
      const mine = ++ticket.current
      if (!quiet) {
        commitBusy(true)
        setError(null)
      }
      const { sessionId, cwd } = targetRef.current
      const current = resultRef.current
      try {
        const data = parseConnections(
          await client.post('/api/connections', {
            action,
            ...(name ? { name } : {}),
            ...(sessionId ? { sessionId } : { cwd }),
            ...(current?.connectionId ? { connectionId: current.connectionId } : {}),
            ...(current?.source ? { source: current.source } : {}),
          }),
        )
        if (mine !== ticket.current || !alive.current) return null
        commitResult(data)
        return data
      } catch (caught) {
        if (mine !== ticket.current || !alive.current) return null
        const stale = caught instanceof HttpError && caught.status === 409
        if (quiet) {
          // A stale connection id or a closed probe: start over from a fresh check.
          if (stale || STALE.test(errorText(caught, ''))) forgetLease()
        } else {
          setError(errorText(caught))
          if (stale) {
            // The action was refused because the target moved on: look again, never retry it.
            forgetLease()
            setTimeout(() => {
              if (alive.current) void call('check', undefined, true)
            }, 0)
          }
        }
        return null
      } finally {
        if (mine === ticket.current && alive.current) {
          if (!quiet) commitBusy(false)
          if (!quiet && name) setFocusAfter({ name, action })
        }
      }
    },
    [client],
  )

  // Servers are often still starting when the first check returns. Look again quietly a
  // few times so "Connecting" turns into what it really is.
  const settle = useCallback(
    (round = 0) => {
      if (settleTimer.current) clearTimeout(settleTimer.current)
      settleTimer.current = null
      if (round >= SETTLE_ROUNDS || !alive.current || !resultRef.current?.servers.some(s => s.status === 'pending')) return
      settleTimer.current = setTimeout(async () => {
        if (!Object.keys(pendingRef.current).length) await call('check', undefined, true)
        settle(round + 1)
      }, SETTLE_MS)
    },
    [call],
  )

  // Until each sign-in finishes or times out: a claude.ai connector is reconnected so
  // Claude fetches the new authorization; an OAuth server finishes by itself once its
  // callback arrives, so a plain check is enough to see it.
  const poll = useCallback(() => {
    if (pollTimer.current) clearTimeout(pollTimer.current)
    pollTimer.current = null
    if (!Object.keys(pendingRef.current).length || !alive.current) return
    pollTimer.current = setTimeout(async () => {
      pollTimer.current = null
      const live = Object.entries(pendingRef.current).filter(([, wait]) => Date.now() - wait.since <= SIGN_IN_TIMEOUT_MS)
      if (!live.length) {
        // Everyone timed out: say so ("Didn't finish?"), poll no more.
        commitPending({ ...pendingRef.current })
        return
      }
      const [name, wait] = live[Math.floor(Date.now() / POLL_MS) % live.length]!
      const reconnect = wait.claudeai && !!resultRef.current?.connectionId
      const data = await call(reconnect ? 'reconnect' : 'check', reconnect ? name : undefined, true)
      if (!alive.current) return
      const next = { ...pendingRef.current }
      for (const server of data?.servers ?? []) {
        if (next[server.name] && server.status === 'connected') {
          delete next[server.name]
          toastRef.current?.(`${displayName(server)} is connected.`)
        }
      }
      commitPending(next)
      poll()
    }, POLL_MS)
  }, [call])

  const check = useCallback(async () => {
    const done = await call('check')
    if (done) settle()
    return done
  }, [call, settle])

  const signIn = useCallback(
    async (name: string) => {
      const done = await call('authenticate', name)
      const auth = done?.auth
      if (!done || !auth) return
      const server = done.servers.find(s => s.name === name)
      if (server?.status === 'connected') {
        toastRef.current?.(`${displayName(server)} is connected.`)
        return
      }
      if (!auth.url && !auth.needsAction) {
        toastRef.current?.('Signed in.')
        return
      }
      commitPending({
        ...pendingRef.current,
        [name]: { url: auth.url ?? null, opened: !!auth.opened, since: Date.now(), claudeai: server?.scope === 'claudeai' },
      })
      toastRef.current?.(
        auth.opened ? 'Opened the sign-in page in your browser. Finish there; Fleet picks it up.' : 'Open the sign-in page to finish signing in.',
      )
      if (!auth.opened && auth.url) window.open(auth.url, '_blank', 'noopener')
      poll()
    },
    [call, poll],
  )

  const act = useCallback(
    async (action: ConnectionAction, name: string) => {
      if (action === 'authenticate') return signIn(name)
      const done = await call(action, name)
      if (done) settle()
      return done
    },
    [call, settle, signIn],
  )

  const cancelSignIn = useCallback((name: string) => {
    const { [name]: _gone, ...rest } = pendingRef.current
    commitPending(rest)
  }, [])

  return { result, busy, error, pending, focusAfter, check, act, cancelSignIn, reset }
}
