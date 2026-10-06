// Test support for the session console: a fake Fleet that answers the conversation's
// GETs from fixtures (through the real sync protocol), the console's side routes, and
// POSTs through a handler the test controls, recording every POST it receives. The
// console is mounted inside the real providers (StrictMode included) with the Sessions
// selection set.
import { act } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, vi } from 'vitest'
import type { Selection } from '../../app/state'
import { type Harness, MemoryStorage, makeHarness, renderWith } from '../../test/shell'
import { jsonResponse } from '../../test/fakes'
import type { FetchLike } from '../../transport/conditional'
import { type DetailBody, bodyOf, fakeFleet } from '../conversation/testing'

export interface PostRecord {
  readonly path: string
  readonly body: Record<string, unknown>
}

export type PostHandler = (post: PostRecord, fleet: ConsoleFleet) => Response | Promise<Response>

export interface ConsoleFleet extends ReturnType<typeof fakeFleet> {
  readonly posts: PostRecord[]
  /** What the next POSTs answer; the default answers `{session}` with the session as held. */
  onPost: PostHandler
  commands: unknown[]
  models: unknown[] | null
  projects: unknown[]
  /** The detail currently held for a managed id (what a POST answers by default). */
  held(id: string): DetailBody | undefined
  /** Replace a managed session's detail, as a change on the server. */
  update(id: string, value: DetailBody): void
}

export function consoleFleet(): ConsoleFleet {
  const base = fakeFleet()
  const details = new Map<string, DetailBody>()
  const fleet: ConsoleFleet = Object.assign(base, {
    posts: [] as PostRecord[],
    commands: [] as unknown[],
    models: null as unknown[] | null,
    projects: [] as unknown[],
    onPost: ((post: PostRecord, self: ConsoleFleet) => {
      const id = /^\/api\/managed\/([^/]+)\//.exec(post.path)?.[1]
      const detail = id ? self.held(decodeURIComponent(id)) : undefined
      return detail ? jsonResponse(detail) : jsonResponse({ ok: true })
    }) as PostHandler,
    held: (id: string) => details.get(id),
    update(id: string, value: DetailBody) {
      details.set(id, value)
      base.managed(id, value)
    },
  })
  const getFetch = base.fetch
  const fetch: FetchLike = async (url, init) => {
    if (init?.method === 'POST') {
      const record = { path: url, body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown> }
      fleet.posts.push(record)
      return fleet.onPost(record, fleet)
    }
    if (/^\/api\/(managed\/[^/]+\/commands|models|projects)$/.test(url)) fleet.requests.push(url)
    if (/^\/api\/managed\/[^/]+\/commands$/.test(url)) return jsonResponse({ commands: fleet.commands })
    if (url === '/api/models') return fleet.models ? jsonResponse({ models: fleet.models }) : jsonResponse({ error: 'No models.' }, 500)
    if (url === '/api/projects') return jsonResponse({ projects: fleet.projects })
    return getFetch(url, init)
  }
  return Object.assign(fleet, { fetch })
}

export const detailOf = (file: { response: { body: unknown } }): DetailBody => bodyOf<DetailBody>(file)

/** Mount `ui` (the SessionDetail, usually) with `selection` chosen in the Sessions view. */
export function mountConsole(fleet: ConsoleFleet, ui: ReactElement, selection: Selection | null, storage = new MemoryStorage()) {
  // The shared plain resources (projects) read the page's own fetch.
  vi.stubGlobal('fetch', fleet.fetch)
  const harness: Harness = makeHarness(fleet.fetch, storage)
  if (selection) harness.store.dispatch({ type: 'select', selection })
  const view = renderWith(harness, ui)
  return { ...harness, ...view }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Choose another session, as the session list would. */
export async function choose(harness: Harness, selection: Selection) {
  await act(async () => {
    harness.store.dispatch({ type: 'select', selection })
  })
}

/** Let the store reload a managed session, as an SSE invalidation does. */
export async function refreshManaged(harness: Harness, id: string) {
  await act(async () => {
    await harness.client.store.refresh(harness.client.resources.managed(id))
  })
}

/** POSTs to a path ending with `suffix`. */
export const postsTo = (fleet: ConsoleFleet, suffix: string) => fleet.posts.filter(p => p.path.endsWith(suffix))
