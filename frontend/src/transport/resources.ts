// Resource keys, resource factories and the invalidation map in one place, so the
// question "what refetches when X happens" has one answer (plan section 7).
import { type FetchLike, conditionalGet } from './conditional'
import { ProtocolError } from './errors'
import type { Resource } from './store'

/** Every key the app uses. Keys qualify entities by kind (and engine for external transcripts). */
export const keys = {
  control: 'control',
  sessions: 'sessions',
  projects: 'projects',
  progress: 'progress',
  /** The team catalog as the Day board's launch cards read it (`/api/teams`). */
  dayTeams: 'today:teams',
  /** Project names for the Day board's tags and picker (`/api/projects`). */
  dayProjects: 'today:projects',
  managed: (managedId: string) => `managed:${managedId}`,
  history: (engine: string, transcriptId: string) => `history:${engine}:${transcriptId}`,
} as const

const MANAGED_PREFIX = 'managed:'
export const isManagedKey = (key: string): boolean => key.startsWith(MANAGED_PREFIX)

/**
 * A `sessions` event names managed ids, or the special values 'projects' and 'queue'.
 * The list itself is refreshed by the separate `list` event, which the server sends
 * whenever the list's tag moves, so it is not repeated here.
 */
export function keysForSessionsEvent(ids: readonly string[]): string[] {
  const out = new Set<string>()
  for (const id of ids) {
    if (id === 'projects') out.add(keys.projects)
    else if (id === 'queue') {
      out.add(keys.control)
      out.add(keys.sessions)
    } else if (id) out.add(keys.managed(id))
  }
  return [...out]
}

/** What a successful mutation makes out of date. Feature code calls `client.store.invalidate(...)` with these. */
export const mutationInvalidates = {
  /** message, stop, mode, model, approval, rename, project tag */
  sessionChange: (managedId: string) => [keys.managed(managedId), keys.sessions],
  /** close also ends Day threads and moves project membership and Progress */
  sessionClose: (managedId: string) => [keys.managed(managedId), keys.sessions, keys.projects, keys.progress],
  /** a Day action touches the Day session, the list, projects and Progress */
  day: (daySessionId: string) => [keys.managed(daySessionId), keys.sessions, keys.projects, keys.dayProjects, keys.progress],
  project: () => [keys.projects, keys.dayProjects, keys.sessions],
  /** a team saved or removed */
  teams: () => [keys.dayTeams],
  queue: () => [keys.control, keys.sessions],
} as const

export interface ConditionalResourceSpec<T> {
  readonly key: string
  readonly url: string
  /** Arrays the server packs for this route (see `respond(...)` calls in server.js). */
  readonly paths: readonly string[]
  /** Runtime validation; must return unchanged rows by reference where it can. */
  readonly parse: (raw: unknown) => T
}

/** A resource fetched with the conditional protocol and validated before it reaches the store. */
export function conditionalResource<T>(fetch: FetchLike, spec: ConditionalResourceSpec<T>): Resource<T> {
  return {
    key: spec.key,
    async load({ signal, conditional, current }) {
      const outcome = await conditionalGet({ url: spec.url, paths: spec.paths, previous: conditional, fetch, signal })
      if (outcome.kind === 'not-modified') {
        if (current === undefined) throw new ProtocolError(`Fleet answered 304 for ${spec.url} with nothing held.`)
        return { data: current, conditional }
      }
      return { data: spec.parse(outcome.value), conditional: outcome.state }
    },
  }
}

/**
 * A keyed family of resources (one per session, say) that hands out the same object
 * per key, so hooks see a stable resource and the store sees one entry.
 */
export function resourceFamily<A extends readonly unknown[], T>(
  keyOf: (...args: A) => string,
  make: (key: string, ...args: A) => Resource<T>,
): (...args: A) => Resource<T> {
  const made = new Map<string, Resource<T>>()
  return (...args: A) => {
    const key = keyOf(...args)
    let resource = made.get(key)
    if (!resource) {
      resource = make(key, ...args)
      made.set(key, resource)
    }
    return resource
  }
}

/**
 * A plain JSON GET (no packed arrays, no ETag from the server), validated like the
 * rest. The conditional adapter treats an answer without an ETag as always fresh.
 */
export function jsonResource<T>(fetch: FetchLike, key: string, url: string, parse: (raw: unknown) => T): Resource<T> {
  return conditionalResource(fetch, { key, url, paths: [], parse })
}
