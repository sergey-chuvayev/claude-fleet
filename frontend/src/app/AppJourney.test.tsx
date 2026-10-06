// One operator journey through the whole app against the fleet-mixed pack, with the
// real shell, transport and lazy features: pick a session in the list and read its
// conversation and inspector; Ctrl+N, launch, land on the new session; filter the
// list, then Search and Open in Fleet on a row the filter hides.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import controlFixture from '../test/fixtures/fleet-mixed/get-control.json'
import modelsFixture from '../test/fixtures/fleet-mixed/get-models.json'
import searchJobFixture from '../test/fixtures/fleet-mixed/get-search-job.json'
import sessionsFixture from '../test/fixtures/fleet-mixed/get-sessions.json'
import teamsFixture from '../test/fixtures/fleet-mixed/get-teams.json'
import createFixture from '../test/fixtures/fleet-mixed/post-managed-create.json'
import postSearchFixture from '../test/fixtures/fleet-mixed/post-search.json'
import { jsonResponse, strip, syncRoute } from '../test/fakes'
import { type Harness, makeHarness, renderWith } from '../test/shell'
import type { FetchLike } from '../transport/conditional'
import { AppShell } from './AppShell'

type Json = Record<string, any>
interface Fixture {
  readonly request: { readonly path: string }
  readonly response: { readonly body: unknown }
}

const body = <T,>(file: { response: { body: unknown } }): T => strip(file.response.body) as T
const managedFixtures = import.meta.glob<Fixture>('../test/fixtures/fleet-mixed/managed/*.json', { eager: true, import: 'default' })
const historyFixtures = import.meta.glob<Fixture>('../test/fixtures/fleet-mixed/history/*.json', { eager: true, import: 'default' })

/** The checkout-refactor terminal session: busy, external, the search's live hit. */
const LIVE = '000000c1-0000-4000-8000-000000000001'

function journeyFleet() {
  const posts: Array<{ url: string; body: Json }> = []
  const snapshot = body<{ sessions: Json[] } & Json>(sessionsFixture)
  const sessions = syncRoute(['sessions'], ['generatedAt'])
  sessions.set(structuredClone(snapshot))
  // GET answers by exact path: every managed detail and transcript in the pack.
  const gets = new Map<string, unknown>()
  for (const file of [...Object.values(managedFixtures), ...Object.values(historyFixtures)]) gets.set(file.request.path, file.response.body)
  gets.set('/api/control', body(controlFixture))
  gets.set('/api/models', body(modelsFixture))
  gets.set('/api/teams', body(teamsFixture))
  const thinking = body<{ job: Json }>(postSearchFixture).job
  const done = body<{ job: Json }>(searchJobFixture).job
  const hit = { sessionId: LIVE, title: 'Checkout refactor', cwd: '/fixture/repos/web-app', project: 'web-app', firstAt: 1791280620000, lastAt: 1791280740000, matches: 2, snippets: [] }

  const fetch: FetchLike = async (url, init) => {
    if (init?.method === 'POST') {
      const sent = JSON.parse(String(init.body ?? '{}')) as Json
      posts.push({ url, body: sent })
      if (url === '/api/managed') {
        const session = { ...body<{ session: Json }>(createFixture).session, id: 'm-journey', createRequestId: sent.requestId, cwd: sent.cwd, name: sent.prompt }
        gets.set('/api/managed/m-journey', { session })
        snapshot.sessions = [
          { managedId: 'm-journey', sessionId: null, title: sent.prompt, name: sent.prompt, state: 'busy', managed: true, managedStatus: 'starting', kind: 'agent', lastActivity: 1791280800000 },
          ...snapshot.sessions,
        ]
        sessions.set(structuredClone(snapshot))
        return jsonResponse({ session }, 201)
      }
      if (url === '/api/search') return jsonResponse({ job: { ...thinking, hits: [hit] } }, 201)
      return jsonResponse({ error: 'Not found.', code: 'NOT_FOUND' }, 404)
    }
    if (url === '/api/sessions') return sessions.fetch(url, init)
    if (url.startsWith('/api/search/')) return jsonResponse({ job: { ...done, id: thinking.id, hits: [hit], ai: null, status: 'done' } })
    if (gets.has(url)) return jsonResponse(gets.get(url))
    return jsonResponse({ error: 'Not found.', code: 'NOT_FOUND' }, 404)
  }
  return { fetch, posts }
}

let harness: Harness | null = null
afterEach(() => {
  harness?.client.stop()
  harness = null
})

const list = () => document.getElementById('session-list')!
const row = (title: string) => within(list()).getByText(title, { selector: '.session-title' }).closest('button') as HTMLButtonElement
const selection = () => harness!.store.getState().selection.sessions
const liveRow = () => list().querySelector<HTMLButtonElement>(`button.session[data-session*="${LIVE}"]`)

describe('The app, end to end (fleet-mixed)', () => {
  it('selects, launches and opens a hidden session from Search', async () => {
    const fleet = journeyFleet()
    harness = makeHarness(fleet.fetch)
    harness.client.start()
    renderWith(harness, <AppShell />)

    // 1. A row in the list: its conversation in the console, its inspector beside it.
    await waitFor(() => expect(document.querySelector('#session-list .session')).toBeTruthy())
    await within(list()).findByText('Fix flaky checkout test', { selector: '.session-title' })
    fireEvent.click(row('Fix flaky checkout test'))
    expect(selection()).toEqual({ kind: 'managed', managedId: 'm-claude-idle' })
    expect(row('Fix flaky checkout test').getAttribute('aria-pressed')).toBe('true')
    const panel = await waitFor(() => {
      const el = document.getElementById('control-panel')
      if (!el) throw new Error('no console yet')
      return el
    })
    expect(await within(panel).findByText('Fixed. The test waited on a timer; now it awaits the event.')).toBeTruthy()
    expect(document.getElementById('conversation-title')?.textContent).toBe('Fix flaky checkout test')
    const toggle = document.getElementById('details-toggle') as HTMLButtonElement
    if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle)
    const inspector = await waitFor(() => {
      const el = document.getElementById('detail-content')
      if (!el) throw new Error('no inspector yet')
      return el
    })
    expect(within(inspector).getByRole('heading', { name: 'Fix flaky checkout test' })).toBeTruthy()

    // 2. Ctrl+N, launch, and land on the new session.
    fireEvent.keyDown(document, { key: 'n', ctrlKey: true })
    await screen.findByRole('dialog', { name: 'What are we working on?' })
    const cwd = document.getElementById('launch-cwd') as HTMLInputElement
    await waitFor(() => expect(cwd.value).not.toBe(''))
    fireEvent.change(document.getElementById('launch-prompt')!, { target: { value: 'Journey agent' } })
    fireEvent.click(document.getElementById('launch-submit')!)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(fleet.posts.filter(p => p.url === '/api/managed')).toHaveLength(1)
    expect(fleet.posts[0]!.body).toMatchObject({ prompt: 'Journey agent', requestId: expect.any(String) })
    await waitFor(() => expect(selection()).toEqual({ kind: 'managed', managedId: 'm-journey' }))
    await waitFor(() => expect(row('Journey agent').getAttribute('aria-pressed')).toBe('true'))
    await waitFor(() => expect(document.getElementById('conversation-title')?.textContent).toBe('Journey agent'))

    // 3. Filter the list to offline sessions: the busy checkout-refactor row is hidden.
    expect(liveRow()).toBeTruthy()
    fireEvent.click(document.getElementById('filter-trigger')!)
    fireEvent.click(within(screen.getByRole('menu')).getByRole('button', { name: /Offline/ }))
    await waitFor(() => expect(liveRow()).toBeNull())

    // 4. Search, then Open in Fleet on that hidden row: back to All, selected, shown.
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
    const input = await screen.findByLabelText('Search all sessions')
    fireEvent.change(input, { target: { value: 'checkout' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^Search/ }))
    const card = (await screen.findByText('Checkout refactor')).closest('.ask-hit') as HTMLElement
    fireEvent.click(within(card).getByRole('button', { name: /Open in Fleet/ }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(selection()).toMatchObject({ kind: 'external', transcriptId: LIVE })
    await waitFor(() => expect(document.getElementById('filter-trigger')!.textContent).toBe('All sessions'))
    await waitFor(() => expect(liveRow()?.getAttribute('aria-pressed')).toBe('true'))
    await act(async () => {})
    expect((await within(document.getElementById('control-panel')!).findAllByText(/Refactor checkout/)).length).toBeGreaterThan(0)
  })
})
