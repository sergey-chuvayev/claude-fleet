// The console's plain JSON reads: the model catalog, the project choices for the tag
// picker, and a session's slash commands. They are store resources like everything
// else (one in-flight request per key, last good data kept through a failure), made
// once per client so each key has one Resource object.
//
// TODO(transport): FleetClient builds resources only for control, sessions, managed
// details and histories, and keeps its fetch private. Until it offers a factory for
// plain JSON GETs, this reads the client's own fetch (the one the app and the tests
// configured) instead of the global one, so a fake Fleet sees these requests too.
import type { FetchLike } from '../../transport/conditional'
import type { FleetClient } from '../../transport/client'
import {
  type Command,
  type ModelOption,
  type ProjectChoice,
  parseCommands,
  parseModels,
  parseProjectChoices,
} from '../../transport/contracts'
import { ProtocolError, httpErrorFrom, withTimeout } from '../../transport/errors'
import { keys } from '../../transport/resources'
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
export const MODELS_KEY = 'models'

/** A session's commands and skills; its catalog depends on the session's directory. */
export const commandsResource = (client: FleetClient, managedId: string): Resource<readonly Command[]> =>
  jsonResource(client, commandsKey(managedId), `/api/managed/${encodeURIComponent(managedId)}/commands`, parseCommands)

export const modelsResource = (client: FleetClient): Resource<{ models: ModelOption[] }> =>
  jsonResource(client, MODELS_KEY, '/api/models', parseModels)

/**
 * Projects under the shared `projects` key, so the `projects` event refreshes the picker.
 * Another feature may hold the same key with a richer parse; read it with `projectChoices`.
 */
export const projectsResource = (client: FleetClient): Resource<{ projects: ProjectChoice[] }> =>
  jsonResource(client, keys.projects, '/api/projects', parseProjectChoices)

/** Id and name of each active project, whichever feature loaded the `projects` key. */
export function projectChoices(data: unknown): readonly ProjectChoice[] {
  if (!data || typeof data !== 'object') return []
  const list = (data as { projects?: unknown }).projects
  if (!Array.isArray(list)) return []
  return list.flatMap(p =>
    p && typeof p === 'object' && typeof (p as ProjectChoice).id === 'string' && typeof (p as ProjectChoice).name === 'string' && !(p as ProjectChoice).archived
      ? [{ id: (p as ProjectChoice).id, name: (p as ProjectChoice).name }]
      : [],
  )
}

/** The model choices that work when the catalog cannot be read (legacy STANDARD_MODELS). */
export const STANDARD_MODELS: readonly ModelOption[] = [
  { value: '', displayName: 'Fleet default' },
  { value: 'opus', displayName: 'Opus' },
  { value: 'sonnet', displayName: 'Sonnet' },
  { value: 'haiku', displayName: 'Haiku' },
  { value: 'auto-jev', displayName: 'Auto · Jev' },
]
