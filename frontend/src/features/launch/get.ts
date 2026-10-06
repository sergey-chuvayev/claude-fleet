// A plain JSON GET for the launch dialog's catalogs (/api/models, /api/teams), which
// the sync protocol does not pack and FleetClient has no resource for.
//
// TODO(transport): FleetClient should expose a plain validated GET (for example
// `client.getJson(path, parse)`) next to `post`. Until it does, this reads the fetch
// the client was built with, so tests and the app keep one fake/real network each.
import type { FleetClient } from '../../transport/client'
import type { FetchLike } from '../../transport/conditional'
import { ProtocolError, httpErrorFrom, withTimeout } from '../../transport/errors'

const fetchOf = (client: FleetClient): FetchLike => (client as unknown as { readonly fetch: FetchLike }).fetch

export async function getJson<T>(
  client: FleetClient,
  path: string,
  parse: (raw: unknown) => T,
  signal?: AbortSignal,
): Promise<T> {
  const timed = withTimeout(signal, 15_000)
  try {
    const response = await fetchOf(client)(path, { cache: 'no-store', signal: timed.signal })
    if (!response.ok) throw await httpErrorFrom(response)
    let raw: unknown
    try {
      raw = await response.json()
    } catch {
      throw new ProtocolError(`Fleet sent an unreadable answer for ${path}.`)
    }
    return parse(raw)
  } finally {
    timed.done()
  }
}

/** One value per client: the catalogs and the launch draft belong to one Fleet server. */
export function perClient<T>(make: (client: FleetClient) => T): (client: FleetClient) => T {
  const made = new WeakMap<FleetClient, T>()
  return client => {
    let value = made.get(client)
    if (value === undefined) {
      value = make(client)
      made.set(client, value)
    }
    return value
  }
}
