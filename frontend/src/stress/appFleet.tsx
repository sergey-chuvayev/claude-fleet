// The whole app against a programmable fake Fleet, for the stress and race tests
// (A24 to A28, work package 5). The fake answers from the fleet-mixed fixture pack
// through the server's real sync protocol (sync.js), and a test can:
//   - change what the server holds (`setSessions`, `setDetail`, `setControl`);
//   - hold a GET until it says so (`gate`), with the answer computed when the request
//     arrived, so a held answer is genuinely older than anything that lands meanwhile;
//   - replace the next answers to a route (`next`): 431, a drifted fingerprint, 500;
//   - go offline (every request rejects as a dropped connection);
//   - answer POSTs (`onPost`), with the control token checked as server.js does.
// `mountApp` renders <AppShell/> in StrictMode inside the real providers, with a client
// that coalesces list events immediately and a visibility the test controls.
import { act, render } from '@testing-library/react'
import { vi } from 'vitest'
import { AppShell } from '../app/AppShell'
import { AppStore } from '../app/AppStore'
import { PreferenceStore } from '../app/preferences'
import type { Selection } from '../app/state'
import { Clock } from '../components/clock'
import { Notifier } from '../components/Toast'
import controlFile from '../test/fixtures/fleet-mixed/get-control.json'
import modelsFile from '../test/fixtures/fleet-mixed/get-models.json'
import sessionsFile from '../test/fixtures/fleet-mixed/get-sessions.json'
import teamsFile from '../test/fixtures/fleet-mixed/get-teams.json'
import { type Deferred, FakeEventSource, FakeVisibility, deferred, jsonResponse, strip, syncRoute } from '../test/fakes'
import { type Harness, MemoryStorage, Providers } from '../test/shell'
import { FleetClient } from '../transport/client'
import type { FetchLike } from '../transport/conditional'

const managedFiles = import.meta.glob<{ response: { body: unknown } }>('../test/fixtures/fleet-mixed/managed/*.json', { eager: true })

// biome-ignore lint/suspicious/noExplicitAny: fixture JSON is reshaped freely by tests
type Json = any

export interface Detail {
  session: Json
}

export interface Get {
  readonly url: string
  readonly ifNoneMatch: string | null
  readonly known: string | null
}
export interface Post {
  readonly path: string
  readonly body: Json
  readonly token: string | null
}

export function appFleet() {
  let control: Json = strip(controlFile.response.body)
  const sessions = syncRoute(['sessions'], ['generatedAt'])
  sessions.set(strip(sessionsFile.response.body))
  const managed = new Map<string, ReturnType<typeof syncRoute>>()
  const held = new Map<string, Detail>()
  for (const [file, module] of Object.entries(managedFiles)) {
    const id = /([\w-]+)\.json$/.exec(file)?.[1]
    if (!id) continue
    const route = syncRoute(['session.messages', 'session.subagents'])
    const body = strip(module.response.body) as Detail
    route.set(body)
    managed.set(id, route)
    held.set(id, body)
  }
  const gets: Get[] = []
  const posts: Post[] = []
  const gates: Array<{ pattern: RegExp; gate: Deferred<void> }> = []
  const overrides: Array<{ pattern: RegExp; answer: () => Response | Promise<Response> }> = []
  let offline = false

  const answerGet = async (url: string, init?: RequestInit): Promise<Response> => {
    const override = overrides.findIndex(o => o.pattern.test(url))
    if (override >= 0) {
      const [found] = overrides.splice(override, 1)
      if (found) return found.answer()
    }
    if (url === '/api/control') return jsonResponse(control)
    if (url === '/api/sessions') return sessions.fetch(url, init)
    const detail = /^\/api\/managed\/([\w-]+)$/.exec(url)?.[1]
    if (detail) {
      const route = managed.get(detail)
      return route ? route.fetch(url, init) : jsonResponse({ error: 'Session not found.', code: 'NOT_FOUND' }, 404)
    }
    if (/^\/api\/managed\/[\w-]+\/commands$/.test(url)) return jsonResponse({ commands: [] })
    if (url === '/api/models') return jsonResponse(strip(modelsFile.response.body))
    if (url === '/api/teams') return jsonResponse(strip(teamsFile.response.body))
    if (url.startsWith('/api/projects')) return jsonResponse({ projects: [] })
    if (url.startsWith('/api/pr-status')) return jsonResponse({ ok: false, reason: 'missing' })
    return jsonResponse({ error: 'Not found.', code: 'NOT_FOUND' }, 404)
  }

  const fleet = {
    gets,
    posts,
    sessions,
    /** What POSTs answer once the token passed. Default: `{session}` as held, or `{ok:true}`. */
    onPost: ((post: Post): Response | Promise<Response> => {
      const id = /^\/api\/managed\/([\w-]+)\//.exec(post.path)?.[1]
      const detail = id ? held.get(id) : undefined
      return detail ? jsonResponse(detail) : jsonResponse({ ok: true })
    }) as (post: Post) => Response | Promise<Response>,
    get offline() {
      return offline
    },
    set offline(value: boolean) {
      offline = value
    },
    control: () => control,
    setControl(patch: Json) {
      control = { ...control, ...patch }
    },
    snapshot: (): Json => sessions.plain(),
    setSessions(next: Json) {
      sessions.set(next)
    },
    /** Change one row of the list as the server would. */
    patchRow(key: string, patch: Json) {
      const snap = sessions.plain() as Json
      snap.sessions = snap.sessions.map((row: Json) => ((row.managedId ?? row.sessionId) === key ? { ...row, ...patch } : row))
      sessions.set(snap)
    },
    held: (id: string) => held.get(id),
    setDetail(id: string, next: Detail) {
      held.set(id, next)
      let route = managed.get(id)
      if (!route) {
        route = syncRoute(['session.messages', 'session.subagents'])
        managed.set(id, route)
      }
      route.set(next)
    },
    patchSession(id: string, patch: Json) {
      const current = held.get(id)
      if (!current) throw new Error(`no detail for ${id}`)
      fleet.setDetail(id, { ...current, session: { ...current.session, ...patch } })
    },
    /** Hold the next GET whose url matches; resolve the returned deferred to let it answer. */
    gate(pattern: RegExp): Deferred<void> {
      const gate = deferred<void>()
      gates.push({ pattern, gate })
      return gate
    },
    /** Replace the next answer to a matching GET. */
    next(pattern: RegExp, answer: () => Response | Promise<Response>) {
      overrides.push({ pattern, answer })
    },
    getsOf: (pattern: RegExp) => gets.filter(g => pattern.test(g.url)),
    postsOf: (pattern: RegExp) => posts.filter(p => pattern.test(p.path)),
    fetch: (async (url, init) => {
      const headers = new Headers(init?.headers)
      if (offline) throw new TypeError('Failed to fetch')
      if (init?.method === 'POST') {
        const token = headers.get('x-fleet-token')
        const post = { path: url, body: JSON.parse(String(init.body ?? '{}')), token }
        posts.push(post)
        if (token !== control.token) return jsonResponse({ error: 'Reload Fleet before sending commands.', code: 'TOKEN_INVALID', retryable: true }, 403)
        return fleet.onPost(post)
      }
      gets.push({ url, ifNoneMatch: headers.get('if-none-match'), known: headers.get('x-fleet-known') })
      const gateAt = gates.findIndex(g => g.pattern.test(url))
      // The answer is what the server held when the request arrived.
      const response = await answerGet(url, init)
      if (gateAt >= 0) {
        const [found] = gates.splice(gateAt, 1)
        await found?.gate.promise
        if (offline) throw new TypeError('Failed to fetch')
      }
      return response
    }) as FetchLike,
  }
  return fleet
}
export type AppFleet = ReturnType<typeof appFleet>

export interface MountedApp extends Harness {
  readonly visibility: FakeVisibility
  readonly stream: () => FakeEventSource
  unmount(): void
  select(selection: Selection): Promise<void>
}

export function makeAppHarness(fleet: AppFleet, storage = new MemoryStorage()) {
  vi.stubGlobal('fetch', fleet.fetch)
  FakeEventSource.instances = []
  const visibility = new FakeVisibility()
  const client = new FleetClient({
    fetch: fleet.fetch,
    eventSource: url => new FakeEventSource(url),
    visibility,
    listCoalesceMs: 0,
    recoveryPollMs: 3_600_000,
  })
  const harness: Harness = {
    client,
    store: new AppStore(new PreferenceStore(storage)),
    storage,
    notifier: new Notifier(),
    clock: new Clock({ visibility: null }),
  }
  return { harness, visibility }
}

/** Start the client and render the whole app. */
export function mountApp(fleet: AppFleet, storage = new MemoryStorage()): MountedApp {
  const { harness, visibility } = makeAppHarness(fleet, storage)
  harness.client.start()
  const view = render(
    <Providers harness={harness}>
      <AppShell />
    </Providers>,
  )
  return {
    ...harness,
    visibility,
    stream: () => {
      const latest = FakeEventSource.instances.at(-1)
      if (!latest) throw new Error('no event stream')
      return latest
    },
    unmount: () => {
      view.unmount()
      harness.client.stop()
    },
    select: async selection => {
      await act(async () => harness.store.dispatch({ type: 'select', selection }))
    },
  }
}

/** Fire a server event on the app's stream inside act. */
export async function emit(app: MountedApp, type: 'sessions' | 'list', data: string) {
  await act(async () => {
    app.stream().emit(type, data)
  })
}

export const managedSelection = (id: string): Selection => ({ kind: 'managed', managedId: id }) as Selection

export const sessionRow = (key: string) => document.querySelector<HTMLButtonElement>(`#session-list button.session[data-session="${key}"]`)
export const rowKeys = () => [...document.querySelectorAll<HTMLElement>('#session-list button.session:not(.session-child)')].map(b => b.dataset.session)
export const bannerText = () => {
  const banner = document.getElementById('error')
  return banner && !banner.hidden ? banner.textContent : null
}
