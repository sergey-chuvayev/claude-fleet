// Waiting for a new Fleet server after an update or a service handover.
//
// An HTTP 200 from /api/control proves nothing while the old process is still shutting
// down: it answers happily right up to the end. The only proof of a restart is a
// different `instanceId` (a new server process) or `buildId` (a new build). When the
// previous identity is unknown (an older server that reports neither), fall back to
// "it went away, then came back". A deadline bounds the wait, and a miss is an
// answer ("did not come back"), never a silent hang.
import type { FleetClient } from '../../transport/client'
import type { FetchLike } from '../../transport/conditional'
import { parseControl } from '../../transport/contracts'
import { getJson } from '../../transport/resources'

export interface ServerIdentity {
  readonly instanceId?: string | undefined
  readonly buildId?: string | undefined
}

export type HandoverOutcome = 'changed' | 'timeout'

/** The one place the page reloads itself, so a test can watch it instead of navigating. */
export const page = {
  reload: (): void => {
    location.reload()
  },
}

interface HandoverTiming {
  /** The identity the page was loaded from. */
  readonly previous: ServerIdentity
  readonly deadlineMs?: number
  readonly intervalMs?: number
  /** How long to wait for the old server to go away when identity is unknown. */
  readonly goneMs?: number
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
}

/** Control is read through the app's client, or (in tests) a bare fetch. */
export type HandoverOptions = HandoverTiming &
  ({ readonly client: Pick<FleetClient, 'getJson'> } | { readonly fetch: FetchLike })

const SLEEP = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export async function waitForNewServer(options: HandoverOptions): Promise<HandoverOutcome> {
  const { previous } = options
  const read = (): Promise<ReturnType<typeof parseControl>> =>
    'client' in options
      ? options.client.getJson('/api/control', parseControl, { timeoutMs: 3000 })
      : getJson(options.fetch, '/api/control', parseControl, { timeoutMs: 3000 })
  const sleep = options.sleep ?? SLEEP
  const now = options.now ?? Date.now
  const interval = options.intervalMs ?? 700
  const deadline = now() + (options.deadlineMs ?? 45_000)
  const known = !!(previous.instanceId || previous.buildId)

  const identity = async (): Promise<ServerIdentity | null> => {
    try {
      const { instanceId, buildId } = await read()
      return { instanceId, buildId }
    } catch {
      return null
    }
  }

  let wentAway = false
  while (now() < deadline) {
    const current = await identity()
    if (!current) wentAway = true
    else if (known) {
      if (
        (previous.instanceId && current.instanceId && current.instanceId !== previous.instanceId) ||
        (previous.buildId && current.buildId && current.buildId !== previous.buildId)
      )
        return 'changed'
    } else if (wentAway) return 'changed'
    await sleep(interval)
  }
  return 'timeout'
}
