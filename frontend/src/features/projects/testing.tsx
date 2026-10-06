// Test support for Projects, Progress and Worktrees: a fake Fleet that answers from the
// fixture packs, records every POST, and lets a test change what the next GET says.
// The plain-JSON resources fetch through the page's `fetch`, so the same fake is also
// installed as the global one.
import { render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { vi } from 'vitest'
import controlFixture from '../../test/fixtures/control.json'
import { jsonResponse, syncRoute } from '../../test/fakes'
import { type Harness, MemoryStorage, Providers, makeHarness } from '../../test/shell'
import type { FetchLike } from '../../transport/conditional'

export interface Posted {
  readonly path: string
  readonly body: Record<string, unknown>
  readonly token: string | null
}

type Answer = (body: Record<string, unknown>) => Response | Promise<Response>

export interface FakeFleet {
  readonly fetch: FetchLike
  readonly posted: Posted[]
  readonly requests: string[]
  /** What GET answers for a path (JSON). */
  set(path: string, body: unknown): void
  /** How a POST path answers. Default: 404. */
  answer(path: string, answer: Answer | unknown, status?: number): void
  readonly sessions: ReturnType<typeof syncRoute>
}

export function fakeFleet(): FakeFleet {
  const gets = new Map<string, unknown>()
  const posts = new Map<string, Answer>()
  const posted: Posted[] = []
  const requests: string[] = []
  const sessions = syncRoute(['sessions'], ['generatedAt'])
  sessions.set({ sessions: [], counts: { busy: 0, idle: 0, stale: 0, dead: 0 }, total: 0 })
  const fetch: FetchLike = async (url, init) => {
    requests.push(url)
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>
      posted.push({ path: url, body, token: new Headers(init.headers).get('x-fleet-token') })
      const answer = posts.get(url)
      return answer ? answer(body) : jsonResponse({ error: 'Not found.', code: 'NOT_FOUND' }, 404)
    }
    if (url === '/api/control') return jsonResponse(controlFixture)
    if (url === '/api/sessions') return sessions.fetch(url, init)
    if (gets.has(url)) return jsonResponse(gets.get(url))
    return jsonResponse({ error: 'Not found.', code: 'NOT_FOUND' }, 404)
  }
  return {
    fetch,
    posted,
    requests,
    sessions,
    set: (path, body) => void gets.set(path, body),
    answer(path, answer, status = 200) {
      posts.set(path, typeof answer === 'function' ? (answer as Answer) : () => jsonResponse(answer, status))
    },
  }
}

export interface Mounted {
  readonly harness: Harness
  readonly fleet: FakeFleet
  readonly storage: MemoryStorage
  rerender(ui: ReactNode): void
  readonly container: HTMLElement
}

let current: Harness | null = null
let last: Mounted | null = null

/** The most recent mount, for helpers that act on the running app. */
export function mounted(): Mounted {
  if (!last) throw new Error('Nothing is mounted.')
  return last
}

/** Mount UI in the real providers over a fake Fleet. Call `unmount()` (afterEach) to clean up. */
export function mount(ui: ReactNode, fleet: FakeFleet, preferences: Record<string, string> = {}): Mounted {
  const storage = new MemoryStorage(preferences)
  const harness = makeHarness(fleet.fetch, storage)
  current = harness
  harness.client.start()
  const view = render(<Providers harness={harness}>{ui}</Providers>)
  last = {
    harness,
    fleet,
    storage,
    container: view.container,
    rerender: next => view.rerender(<Providers harness={harness}>{next}</Providers>),
  }
  return last
}

export function unmount(): void {
  current?.client.stop()
  current = null
  last = null
  vi.unstubAllGlobals()
}

/** A fixture file's response body. */
export const bodyOf = (file: { response: { body: unknown } }): unknown => file.response.body
