// Test support for the session list, inspector, delegations and archive: a fake Fleet
// answering from a fixture pack through the server's real sync protocol, with POSTs
// recorded, and a mount helper inside the real providers at the fixture clock.
import type { ReactElement } from 'react'
import { Clock } from '../../components/clock'
import { jsonResponse, strip, syncRoute } from '../../test/fakes'
import { type Harness, MemoryStorage, makeHarness, renderWith } from '../../test/shell'
import type { FetchLike } from '../../transport/conditional'

/** The fixture clock: 2026-10-06T10:00:00Z. */
export const T0 = Date.UTC(2026, 9, 6, 10, 0, 0)

interface FixtureFile {
  readonly response: { readonly body: unknown }
}
export const bodyOf = <T,>(file: FixtureFile): T => strip(file.response.body) as T

export interface Post {
  readonly url: string
  readonly body: Record<string, unknown>
}

export interface FakeFleetOptions {
  readonly control: unknown
  readonly sessions: unknown
  readonly managed?: Readonly<Record<string, unknown>>
  /** Answers for GET /api/pr-status, by PR url. */
  readonly prStatus?: Readonly<Record<string, unknown>>
  /** Answers for POSTs by path; the default is `{ changed: n }` for /api/archive. */
  readonly post?: (url: string, body: Record<string, unknown>) => Response | undefined
}

export function fakeFleet(options: FakeFleetOptions) {
  const sessions = syncRoute(['sessions'], ['generatedAt'])
  sessions.set(options.sessions)
  const managed = new Map<string, ReturnType<typeof syncRoute>>()
  for (const [id, value] of Object.entries(options.managed ?? {})) {
    const route = syncRoute(['session.messages', 'session.subagents'])
    route.set(value)
    managed.set(id, route)
  }
  const posts: Post[] = []
  const gets: string[] = []
  const fetch: FetchLike = async (url, init) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      posts.push({ url, body })
      const custom = options.post?.(url, body)
      if (custom) return custom
      if (url === '/api/archive') return jsonResponse({ changed: (body.ids as unknown[]).length })
      if (url === '/api/archive/rule') return jsonResponse({ rule: { enabled: body.enabled, days: body.days } })
      return jsonResponse({ ok: true })
    }
    gets.push(url)
    if (url === '/api/control') return jsonResponse(options.control)
    if (url === '/api/sessions') return sessions.fetch(url, init)
    const detail = /^\/api\/managed\/([\w-]+)$/.exec(url)
    if (detail?.[1]) {
      const route = managed.get(detail[1])
      return route ? route.fetch(url, init) : jsonResponse({ error: 'Session not found.', code: 'NOT_FOUND' }, 404)
    }
    const pr = /^\/api\/pr-status\?url=(.+)$/.exec(url)
    if (pr?.[1]) {
      const status = options.prStatus?.[decodeURIComponent(pr[1])]
      return jsonResponse({ status: status ?? { ok: false, reason: 'missing' } })
    }
    return jsonResponse({ error: 'Not found.', code: 'NOT_FOUND' }, 404)
  }
  return { fetch, sessions, managed, posts, gets }
}

/** Mount inside the real providers, the clock fixed at T0 (or `now`). The client is not started. */
export function mount(fleet: ReturnType<typeof fakeFleet>, ui: ReactElement, { storage = new MemoryStorage(), now = T0 } = {}) {
  const base = makeHarness(fleet.fetch, storage)
  const harness: Harness = { ...base, clock: new Clock({ now: () => now, visibility: null }) }
  return { harness, ...renderWith(harness, ui) }
}
