// Resource keys, resource factories and the invalidation map in one place, so the
// question "what refetches when X happens" has one answer (plan section 7).
import { type FetchLike, conditionalGet } from './conditional'
import {
  type ProgressReport,
  type Project,
  type WorktreeReport,
  parseProgress,
  parseProjects,
  parseWorktrees,
} from './contracts'
import { ProtocolError, httpErrorFrom, withTimeout } from './errors'
import type { Resource } from './store'

/** Every key the app uses. Keys qualify entities by kind (and engine for external transcripts). */
export const keys = {
  control: 'control',
  sessions: 'sessions',
  projects: 'projects',
  progress: 'progress',
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
  day: (daySessionId: string) => [keys.managed(daySessionId), keys.sessions, keys.projects, keys.progress],
  project: () => [keys.projects, keys.sessions],
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

const FAMILY_LIMIT = 256

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
      // Bounded: a dropped definition is made again, identical, when its key returns.
      if (made.size > FAMILY_LIMIT) made.delete(made.keys().next().value as string)
    }
    return resource
  }
}

// ── Plain JSON resources: projects, progress, worktrees ─────────────────────
// These routes answer without an ETag, so they are fetched plainly. The transport
// client keeps its fetch private, so these use the page's own: main.tsx hands the
// client `window.fetch` too. Looked up per call, so a test can replace it.
// TODO(transport owner): expose these on FleetClient.resources and drop browserFetch.
const browserFetch: FetchLike = (input, init) => globalThis.fetch(input, init)
const READ_TIMEOUT_MS = 15_000

export interface PlainResourceSpec<T> {
  readonly key: string
  readonly url: string
  readonly parse: (raw: unknown) => T
  /** Keep the held object when a refetch changed nothing, so idle polling re-renders nothing. */
  readonly equal?: (a: T, b: T) => boolean
}

export function plainResource<T>(fetch: FetchLike, spec: PlainResourceSpec<T>): Resource<T> {
  return {
    key: spec.key,
    async load({ signal, current }) {
      const timed = withTimeout(signal, READ_TIMEOUT_MS)
      try {
        const response = await fetch(spec.url, { cache: 'no-store', signal: timed.signal })
        if (!response.ok) throw await httpErrorFrom(response)
        let raw: unknown
        try {
          raw = await response.json()
        } catch {
          throw new ProtocolError(`Fleet sent an unreadable answer for ${spec.url}.`)
        }
        const data = spec.parse(raw)
        return { data: current !== undefined && spec.equal?.(current, data) ? current : data }
      } finally {
        timed.done()
      }
    },
  }
}

const sameJson = <T,>(a: T, b: T): boolean => JSON.stringify(a) === JSON.stringify(b)

/** A value with the moment it was read, for views that refresh when older than a window. */
export interface Fetched<T> {
  readonly value: T
  readonly fetchedAt: number
}
const stamped =
  <T,>(parse: (raw: unknown) => T) =>
  (raw: unknown): Fetched<T> => ({ value: parse(raw), fetchedAt: Date.now() })

export const archivedProjectsKey = 'projects:archived'
export const worktreesKey = 'worktrees'

/** Active projects. Refetched on the `projects` event and every few seconds while Projects is open. */
export const projectsResource: Resource<Project[]> = plainResource(browserFetch, {
  key: keys.projects,
  url: '/api/projects',
  parse: parseProjects,
  equal: sameJson,
})
/** Active and archived projects together (the route's `archived=1`); filter on `archived`. */
export const archivedProjectsResource: Resource<Project[]> = plainResource(browserFetch, {
  key: archivedProjectsKey,
  url: '/api/projects?archived=1',
  parse: parseProjects,
  equal: sameJson,
})
export const progressResource: Resource<Fetched<ProgressReport>> = plainResource(browserFetch, {
  key: keys.progress,
  url: '/api/progress',
  parse: stamped(parseProgress),
})
export const worktreesResource: Resource<Fetched<WorktreeReport>> = plainResource(browserFetch, {
  key: worktreesKey,
  url: '/api/worktrees',
  parse: stamped(parseWorktrees),
})

/** What a project mutation (create, archive, restore, deliverable, ask, comment) makes out of date. */
export const projectMutationInvalidates = (): string[] => [keys.projects, archivedProjectsKey, keys.sessions]
/** Clearing a worktree changes the checkout list. */
export const worktreeMutationInvalidates = (): string[] => [worktreesKey]
