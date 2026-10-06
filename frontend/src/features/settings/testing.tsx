// Test support for the modal features (search, connections, settings, update): a fake
// Fleet answering control and the session list from the fleet-mixed pack, plus
// per-test routes for the rest. The same handler serves the FleetClient's injected
// fetch and the page-level fetch the GET helpers use (stubbed on globalThis).
import { vi } from 'vitest'
import controlFixture from '../../test/fixtures/fleet-mixed/get-control.json'
import sessionsFixture from '../../test/fixtures/fleet-mixed/get-sessions.json'
import { jsonResponse, syncRoute } from '../../test/fakes'
import { type Harness, makeHarness, renderWith } from '../../test/shell'
import type { FetchLike } from '../../transport/conditional'
import type { ReactNode } from 'react'

export const control = controlFixture.response.body
export const snapshot = sessionsFixture.response.body

export interface Call {
  readonly method: string
  readonly url: string
  readonly body: Record<string, unknown> | null
  readonly token: string | null
}

type Handler = (call: Call) => Response | Promise<Response>

export function fakeFleet(overrides: { control?: unknown; sessions?: unknown } = {}) {
  const calls: Call[] = []
  const routes: Array<{ method: string; match: string | RegExp; handle: Handler }> = []
  const sessions = syncRoute(['sessions'], ['generatedAt'])
  sessions.set(overrides.sessions ?? snapshot)
  let currentControl: unknown = overrides.control ?? control

  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    const call: Call = {
      method,
      url,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      token: headers.get('x-fleet-token'),
    }
    calls.push(call)
    const route = [...routes].reverse().find(r => r.method === method && (typeof r.match === 'string' ? r.match === url : r.match.test(url)))
    if (route) return route.handle(call)
    if (method === 'GET' && url === '/api/control') return jsonResponse(currentControl)
    if (method === 'GET' && url === '/api/sessions') return sessions.fetch(url, init)
    return jsonResponse({ error: 'Not found.', code: 'NOT_FOUND' }, 404)
  }

  return {
    fetch,
    calls,
    sessions,
    /** Answer `method match` with `handle`; later routes win. */
    on(method: 'GET' | 'POST', match: string | RegExp, handle: Handler) {
      routes.push({ method, match, handle })
    },
    json(method: 'GET' | 'POST', match: string | RegExp, body: unknown, status = 200) {
      routes.push({ method, match, handle: () => jsonResponse(body, status) })
    },
    setControl(next: unknown) {
      currentControl = next
    },
    /** Calls to one route, in order. */
    to: (method: string, url: string | RegExp) =>
      calls.filter(c => c.method === method && (typeof url === 'string' ? c.url === url : url.test(c.url))),
  }
}

export type Fleet = ReturnType<typeof fakeFleet>

let mounted: Harness | null = null

/** Render under the real providers; the page-level fetch is the fake too. */
export function mount(fleet: Fleet, ui: ReactNode) {
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => fleet.fetch(url, init))
  mounted = makeHarness(fleet.fetch)
  return { harness: mounted, ...renderWith(mounted, ui) }
}

export function unmountAll() {
  mounted?.client.stop()
  mounted = null
  vi.unstubAllGlobals()
}
