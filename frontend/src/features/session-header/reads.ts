// The console's plain JSON read: a session's slash commands. (The model picker shares
// the launch dialog's models resource, the tag picker the shared projects resource.) They are store resources like everything
// else (one in-flight request per key, last good data kept through a failure), made
// once per client so each key has one Resource object.
//
// TODO(transport): FleetClient builds resources only for control, sessions, managed
// details and histories, and keeps its fetch private. Until it offers a factory for
// plain JSON GETs, this reads the client's own fetch (the one the app and the tests
// configured) instead of the global one, so a fake Fleet sees these requests too.
import type { FetchLike } from '../../transport/conditional'
import type { FleetClient } from '../../transport/client'
import { type Command, type Project, parseCommands } from '../../transport/contracts'
import { ProtocolError, httpErrorFrom, withTimeout } from '../../transport/errors'
import type { Resource } from '../../transport/store'

const clientFetch = (client: FleetClient): FetchLike => (client as unknown as { readonly fetch: FetchLike }).fetch

const made = new WeakMap<FleetClient, Map<string, Resource<unknown>>>()

function jsonResource<T>(client: FleetClient, key: string, url: string, parse: (raw: unknown) => T): Resource<T> {
  let family = made.get(client)
  if (!family) {
    family = new Map()
    made.set(client, family)
  }
  const existing = family.get(key)
  if (existing) return existing as Resource<T>
  const resource: Resource<T> = {
    key,
    async load({ signal }) {
      const timed = withTimeout(signal, 8000)
      try {
        const response = await clientFetch(client)(url, { cache: 'no-store', signal: timed.signal })
        if (!response.ok) throw await httpErrorFrom(response)
        let raw: unknown
        try {
          raw = await response.json()
        } catch {
          throw new ProtocolError(`Fleet sent an unreadable answer for ${url}.`)
        }
        return { data: parse(raw) }
      } finally {
        timed.done()
      }
    },
  }
  family.set(key, resource as Resource<unknown>)
  return resource
}

export const commandsKey = (managedId: string) => `commands:${managedId}`
export const commandsResource = (client: FleetClient, managedId: string): Resource<readonly Command[]> =>
  jsonResource(client, commandsKey(managedId), `/api/managed/${encodeURIComponent(managedId)}/commands`, parseCommands)

/** Id and name of each active project, for the tag picker. */
export function projectChoices(projects: readonly Project[] | undefined): ReadonlyArray<{ id: string; name: string }> {
  return (projects ?? []).filter(p => !p.archived).map(p => ({ id: p.id, name: p.name }))
}
