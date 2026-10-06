// Test support for the Today view: a fake Fleet answering from the day-full fixture
// pack with the server's real sync protocol, POSTs recorded and answered by the test,
// and a mount of the board beside its console inside the real providers.
import { vi } from 'vitest'
import { Clock } from '../../components/clock'
import controlFixture from '../../test/fixtures/day-full/get-control.json'
import sessionsFixture from '../../test/fixtures/day-full/get-sessions.json'
import teamsFixture from '../../test/fixtures/day-full/get-teams.json'
import projectsFixture from '../../test/fixtures/day-full/get-projects.json'
import dayFixture from '../../test/fixtures/day-full/managed/day-today.json'
import threadFixture from '../../test/fixtures/day-full/managed/thr-today.json'
import launchedFixture from '../../test/fixtures/day-full/managed/m-launched.json'
import { jsonResponse, strip, syncRoute } from '../../test/fakes'
import { makeHarness, renderWith } from '../../test/shell'
import type { FetchLike } from '../../transport/conditional'
import { DayConsole } from './DayConsole'
import { TodayPane } from './TodayPane'
import { clearDrafts } from './useDay'

/** The fixture clock: 2026-10-06 10:00 UTC. */
export const T0 = Date.UTC(2026, 9, 6, 10, 0, 0)

const body = <T,>(file: { response: { body: unknown } }): T => strip(file.response.body) as T

export interface Posted {
  readonly path: string
  readonly body: Record<string, unknown>
}

/** Fixture JSON, shaped by the test that edits it. */
export type Json = any

/** What a POST answers: a status and a body. */
export type Answer = { status?: number; body: unknown }

export function fakeDayFleet() {
  const sessions = syncRoute(['sessions'], ['generatedAt'])
  const snapshot: Json = body(sessionsFixture)
  sessions.set(snapshot)
  const managed = new Map<string, ReturnType<typeof syncRoute>>()
  const details = new Map<string, Json>()
  const setManaged = (id: string, value: Json) => {
    let route = managed.get(id)
    if (!route) {
      route = syncRoute(['session.messages', 'session.subagents'])
      managed.set(id, route)
    }
    details.set(id, value)
    route.set(value)
  }
  setManaged('day-today', body(dayFixture))
  setManaged('thr-today', body(threadFixture))
  setManaged('m-launched', body(launchedFixture))
  const posted: Posted[] = []
  let onPost: (post: Posted) => Answer | Promise<Answer> = post => ({
    body: { result: {}, session: details.get('day-today')?.session, path: post.path },
  })

  const fetch: FetchLike = async (url, init) => {
    if (init?.method === 'POST') {
      const post = { path: url, body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown> }
      posted.push(post)
      const answer = await onPost(post)
      return jsonResponse(answer.body, answer.status ?? 200)
    }
    if (url === '/api/control') return jsonResponse(body(controlFixture))
    if (url === '/api/sessions') return sessions.fetch(url, init)
    if (url === '/api/teams') return jsonResponse(body(teamsFixture))
    if (url === '/api/projects') return jsonResponse(body(projectsFixture))
    const detail = /^\/api\/managed\/([\w-]+)$/.exec(url)
    const route = detail?.[1] ? managed.get(detail[1]) : undefined
    if (route) return route.fetch(url, init)
    return jsonResponse({ error: 'Not found.', code: 'NOT_FOUND' }, 404)
  }

  return {
    fetch,
    posted,
    snapshot,
    /** The Day's detail as the server holds it now (edit, then call `setDay`). */
    day: (): Json => details.get('day-today'),
    setDay: (value: Json) => setManaged('day-today', value),
    setManaged,
    setSessions: (value: Json) => sessions.set(value),
    answer(handler: (post: Posted) => Answer | Promise<Answer>) {
      onPost = handler
    },
    /** Day action POSTs only. */
    dayActions: () => posted.filter(p => p.path === '/api/managed/day-today/day').map(p => p.body),
  }
}
export type FakeDayFleet = ReturnType<typeof fakeDayFleet>

/** Board and console side by side, inside the real providers, at the fixture clock. */
export function mountToday(fleet: FakeDayFleet, { now = T0 }: { now?: number } = {}) {
  clearDrafts()
  vi.stubGlobal('fetch', fleet.fetch)
  const harness = { ...makeHarness(fleet.fetch), clock: new Clock({ now: () => now, visibility: null }) }
  harness.store.dispatch({ type: 'navigate', view: 'today' })
  const view = renderWith(
    harness,
    <section className="workspace" data-view="today">
      <section id="today-pane">
        <TodayPane />
      </section>
      <aside id="detail">
        <DayConsole />
      </aside>
    </section>,
  )
  return { harness, ...view }
}

/** A deep copy of a fixture value, for a test to change. */
export const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
