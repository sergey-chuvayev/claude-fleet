// The console's plain JSON read: a session's slash commands. (The model picker shares
// the launch dialog's models resource, the tag picker the client's projects resource.)
// A store resource like everything else: one in-flight request per key, last good data
// kept through a failure, one Resource object per key from client.resources.plain.
import type { FleetClient } from '../../transport/client'
import { type Command, type Project, parseCommands } from '../../transport/contracts'
import type { Resource } from '../../transport/store'

export const commandsKey = (managedId: string) => `commands:${managedId}`
export const commandsResource = (client: FleetClient, managedId: string): Resource<readonly Command[]> =>
  client.resources.plain<readonly Command[]>({
    key: commandsKey(managedId),
    url: `/api/managed/${encodeURIComponent(managedId)}/commands`,
    parse: parseCommands,
    timeoutMs: 8000,
  })

/** Id and name of each active project, for the tag picker. */
export function projectChoices(projects: readonly Project[] | undefined): ReadonlyArray<{ id: string; name: string }> {
  return (projects ?? []).filter(p => !p.archived).map(p => ({ id: p.id, name: p.name }))
}
