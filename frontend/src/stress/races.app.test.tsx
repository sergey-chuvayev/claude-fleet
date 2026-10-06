// A25 at app level (hard gate): request coordination through the whole app. An event
// burst while a GET is out buys one follow-up, not twenty; a GET that left before a
// mutation cannot overwrite the mutation's answer; a selection swap never shows the
// old session's late error in the new pane; a hidden page asks nothing and refreshes
// what is on screen, once, when it comes back.
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '../test/fakes'
import { type MountedApp, appFleet, emit, mountApp, sessionRow } from './appFleet'

let app: MountedApp | null = null
afterEach(() => {
  app?.unmount()
  app = null
  vi.unstubAllGlobals()
})

async function bootOn(id: string) {
  const fleet = appFleet()
  app = mountApp(fleet)
  await screen.findByText('Clean up stale branches', { selector: '.session-title' })
  await act(async () => sessionRow(id)?.click())
  await waitFor(() => expect(sessionRow(id)?.getAttribute('aria-pressed')).toBe('true'))
  await waitFor(() => expect(fleet.getsOf(new RegExp(`^/api/managed/${id}$`))).toHaveLength(1))
  await screen.findByRole('log', { name: 'Agent conversation' })
  return { fleet, app }
}

const settle = () => act(async () => new Promise(r => setTimeout(r, 20)))

describe('A25 races, whole app', () => {
  it('turns an event burst during a pending GET into exactly one follow-up', async () => {
    const { fleet, app } = await bootOn('m-claude-idle')
    await waitFor(() => expect(app.client.store.isFetching('managed:m-claude-idle')).toBe(false))
    const start = fleet.getsOf(/^\/api\/managed\/m-claude-idle$/).length
    const detailGets = () => fleet.getsOf(/^\/api\/managed\/m-claude-idle$/).length - start
    const gate = fleet.gate(/^\/api\/managed\/m-claude-idle$/)
    await emit(app, 'sessions', '["m-claude-idle"]')
    expect(detailGets(), 'the first event reads the detail').toBe(1)
    for (let i = 0; i < 20; i++) await emit(app, 'sessions', '["m-claude-idle","queue"]')
    expect(detailGets(), 'the burst waits for the read in flight').toBe(1)
    fleet.patchSession('m-claude-idle', { name: 'Changed during the burst' })
    await act(async () => gate.resolve())
    await settle()
    expect(detailGets(), 'exactly one follow-up').toBe(2)
    // The follow-up is what carried the change made during the burst.
    await waitFor(() => expect(document.querySelector('#conversation-title, [aria-label="Name this agent"]')?.textContent ?? document.body.textContent).toContain('Changed during the burst'))

    // The same for the list, once the list reads the "queue" ids caused have finished.
    await waitFor(() => expect(app.client.store.isFetching('sessions')).toBe(false))
    const listGets = () => fleet.getsOf(/^\/api\/sessions$/).length
    const listGate = fleet.gate(/^\/api\/sessions$/)
    const before = listGets()
    // A burst before the coalescing timer fires is one read; events while that read is
    // out mark it dirty, which buys exactly one more.
    for (let i = 0; i < 20; i++) await emit(app, 'list', '{}')
    await settle()
    expect(listGets() - before, 'one list read for the burst').toBe(1)
    for (let i = 0; i < 20; i++) await emit(app, 'list', '{}')
    await settle()
    expect(listGets() - before, 'still one while it is out').toBe(1)
    await act(async () => listGate.resolve())
    await settle()
    expect(listGets() - before, 'one list follow-up').toBe(2)
  })

  it('a GET that left before a mutation cannot overwrite the mutation answer', async () => {
    const { fleet, app } = await bootOn('m-claude-idle')
    const native = () => document.querySelector<HTMLSelectElement>('select#approval-mode')!
    await waitFor(() => expect(native().value).toBe('ask'))
    // The server answers the mode change with the session as changed.
    fleet.onPost = post => {
      if (post.path.endsWith('/mode')) fleet.patchSession('m-claude-idle', { approvalMode: post.body.mode })
      return jsonResponse(fleet.held('m-claude-idle'))
    }
    // A refresh leaves first and holds the old copy (mode "ask").
    const stale = fleet.gate(/^\/api\/managed\/m-claude-idle$/)
    await emit(app, 'sessions', '["m-claude-idle"]')
    await act(async () => {
      fireEvent.change(native(), { target: { value: 'all' } })
    })
    await waitFor(() => expect(fleet.postsOf(/\/mode$/)).toHaveLength(1))
    await waitFor(() => expect(native().value).toBe('all'))
    // The old answer lands late: dropped, and one follow-up reconciles to the server.
    await act(async () => stale.resolve())
    await settle()
    expect(native().value).toBe('all')
    expect(app.client.store.get(app.client.resources.managed('m-claude-idle')).data?.session.approvalMode).toBe('all')
    expect(fleet.postsOf(/\/mode$/)).toHaveLength(1)
  })

  it('a swapped-away session failing late never shows its error in the new pane, and is read again when chosen', async () => {
    const { fleet, app } = await bootOn('m-claude-idle')
    // m-claude-running's first read will fail, and only after the person has moved on.
    fleet.next(/^\/api\/managed\/m-claude-running$/, () => jsonResponse({ error: 'Running session exploded.', code: 'INTERNAL' }, 500))
    const late = fleet.gate(/^\/api\/managed\/m-claude-running$/)
    await act(async () => sessionRow('m-claude-running')?.click())
    await act(async () => sessionRow('m-claude-idle')?.click())
    await waitFor(() => expect(sessionRow('m-claude-idle')?.getAttribute('aria-pressed')).toBe('true'))
    await act(async () => late.resolve())
    await settle()
    expect(document.body.textContent).not.toContain('Running session exploded.')
    expect(screen.getByRole('log', { name: 'Agent conversation' }).textContent).toContain('Fixed. The test waited on a timer')

    // Choosing it again reads it again rather than showing the stale failure.
    const before = fleet.getsOf(/^\/api\/managed\/m-claude-running$/).length
    await act(async () => sessionRow('m-claude-running')?.click())
    await waitFor(() => expect(fleet.getsOf(/^\/api\/managed\/m-claude-running$/).length).toBe(before + 1))
    await waitFor(() => expect(document.body.textContent).not.toContain('Running session exploded.'))
    void app
  })

  it('asks nothing while hidden and refreshes each watched resource once on return', async () => {
    const { fleet, app } = await bootOn('m-claude-idle')
    await settle()
    const count = fleet.gets.length
    await act(async () => app.visibility.set(true))
    for (let i = 0; i < 10; i++) {
      await emit(app, 'list', '{}')
      await emit(app, 'sessions', '["m-claude-idle"]')
    }
    await settle()
    // Hidden: the list waits for the page to return. A `sessions` event naming the session
    // on screen still reads it (legacy control.js does the same), at most once per event.
    const hidden = fleet.gets.slice(count).map(g => g.url)
    expect(hidden.filter(url => url === '/api/sessions')).toHaveLength(0)
    expect(hidden.filter(url => url === '/api/managed/m-claude-idle').length).toBeLessThanOrEqual(10)
    expect(hidden.filter(url => url !== '/api/managed/m-claude-idle')).toEqual([])
    const back = fleet.gets.length
    await act(async () => app.visibility.set(false))
    await settle()
    const urls = fleet.gets.slice(back).map(g => g.url)
    expect(urls.filter(url => url === '/api/sessions')).toHaveLength(1)
    expect(urls.filter(url => url === '/api/managed/m-claude-idle')).toHaveLength(1)
    expect(new Set(urls).size).toBe(urls.length)
  })
})
