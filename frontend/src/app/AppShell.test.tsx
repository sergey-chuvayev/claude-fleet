// The shell against the fleet-mixed fixture pack, through the real transport:
// top bar, navigation and its persistence, banner, status bar, the modal layer and
// the shortcuts, and StrictMode leaving no duplicate listeners behind (A28).
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import controlFixture from '../test/fixtures/fleet-mixed/get-control.json'
import sessionsFixture from '../test/fixtures/fleet-mixed/get-sessions.json'
import { FakeEventSource, jsonResponse, syncRoute } from '../test/fakes'
import { type Harness, MemoryStorage, Providers, makeHarness, renderWith } from '../test/shell'
import type { FetchLike } from '../transport/conditional'
import { AppShell } from './AppShell'

const control = controlFixture.response.body
const snapshot = sessionsFixture.response.body

function fixtureFetch(requests: string[] = []): FetchLike {
  const sessions = syncRoute(['sessions'], ['generatedAt'])
  sessions.set(snapshot)
  return async (url, init) => {
    requests.push(url)
    if (url === '/api/control') return jsonResponse(control)
    if (url === '/api/sessions') return sessions.fetch(url, init)
    return jsonResponse({ error: 'Not found.' }, 404)
  }
}

let harness: Harness | null = null
function boot(fetch: FetchLike, storage?: MemoryStorage) {
  harness = makeHarness(fetch, storage)
  harness.client.start()
  return { harness, ...renderWith(harness, <AppShell />) }
}

afterEach(() => {
  harness?.client.stop()
  harness = null
})

describe('AppShell', () => {
  it('draws the legacy top bar, the session pane and the status bar from the fixtures', async () => {
    const requests: string[] = []
    boot(fixtureFetch(requests))

    const nav = screen.getByRole('navigation', { name: 'Fleet view' })
    expect(within(nav).getAllByRole('button').map(b => b.textContent?.trim())).toEqual([
      'Today',
      'Projects',
      'Sessions',
      'Progress',
      'Worktrees',
    ])
    expect(within(nav).getByRole('button', { name: 'Sessions' }).getAttribute('aria-pressed')).toBe('true')
    expect(await screen.findByText(`v${control.version}`)).toBeTruthy()
    for (const name of ['Settings', 'Connections', 'Refresh sessions', /Search/, 'New agent']) {
      expect(screen.getByRole('button', { name })).toBeTruthy()
    }

    // The list shows foreground agents: no archived, background, Day or project rows.
    const foreground = snapshot.sessions.filter(
      row => !row.archived && !('background' in row && row.background) && row.kind !== 'day' && row.kind !== 'project',
    )
    await screen.findByText('Clean up stale branches', { selector: '.session-title' })
    const list = document.getElementById('session-list')!
    expect(list.querySelectorAll('button.session:not(.session-child)')).toHaveLength(foreground.length)
    expect(screen.getByText('Agents').querySelector('.ui-count')?.textContent).toBe(String(foreground.length))

    const status = document.getElementById('statusbar')!
    expect(within(status).getByText('6 working')).toBeTruthy()
    expect(within(status).getByText('1 needs you')).toBeTruthy()
    expect(within(status).getByRole('meter', { name: 'five-hour usage' }).getAttribute('aria-valuenow')).toBe('81')
    expect(within(status).getByText('week')).toBeTruthy()

    // StrictMode mounts twice; still one request per resource, on one stream.
    expect(requests.filter(url => url === '/api/sessions')).toHaveLength(1)
    expect(requests.filter(url => url === '/api/control')).toHaveLength(1)
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(document.getElementById('connection')?.textContent).toBe('Connecting')
    act(() => FakeEventSource.instances[0]?.open())
    expect(document.getElementById('connection')?.textContent).toBe('Live connection')
    // The inspector toggle shows once a managed session is selected (the first row).
    expect(document.getElementById('details-toggle')?.hidden).toBe(false)
  })

  it('says the server is unreachable instead of showing a blank page', async () => {
    boot(async url => (url === '/api/control' ? jsonResponse(control) : jsonResponse({ error: 'Fleet is restarting.' }, 503)))
    const banner = document.getElementById('error')!
    await vi.waitFor(() => expect(banner.hidden).toBe(false))
    expect(banner.textContent).toBe('Unable to connect to the local server. Retrying automatically.')
    expect(document.getElementById('connection')?.textContent).toBe('Disconnected')
  })

  it('switches views, remembers the choice in fleet:view and gives each view its own layout', async () => {
    const storage = new MemoryStorage({ 'fleet:view': 'work' })
    boot(fixtureFetch(), storage)
    const workspace = document.querySelector('.workspace')!
    // A removed view falls back to Sessions.
    expect(workspace.getAttribute('data-view')).toBe('sessions')

    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    expect(storage.getItem('fleet:view')).toBe('today')
    expect(workspace.getAttribute('data-view')).toBe('today')
    expect(workspace.getAttribute('aria-label')).toBe('Today')
    // Each view mounts its own pane; assert the container, not the feature's copy.
    await waitFor(() => expect(document.getElementById('today-pane')).toBeTruthy())
    expect(document.getElementById('today-pane')?.className).toBe('sessions-pane today-pane')
    expect(screen.getByRole('separator')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Worktrees' }))
    await waitFor(() => expect(workspace.getAttribute('data-view')).toBe('worktrees'))
    expect(screen.queryByRole('separator')).toBeNull()
    expect(document.getElementById('detail')).toBeNull()
    expect(document.getElementById('details-toggle')?.hidden).toBe(true)
  })

  it('makes Progress a view of its own, and keeps aria-pressed on exactly the current tab through every switch', async () => {
    const storage = new MemoryStorage()
    boot(fixtureFetch(), storage)
    const workspace = document.querySelector('.workspace')!
    const nav = screen.getByRole('navigation', { name: 'Fleet view' })
    const pressed = () => within(nav).getAllByRole('button').filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.id)
    expect(within(nav).getAllByRole('button').map(b => b.id)).toEqual(['view-today', 'view-projects', 'view-sessions', 'view-progress', 'view-worktrees'])
    expect(pressed()).toEqual(['view-sessions'])

    const press = (name: string) => fireEvent.click(within(nav).getByRole('button', { name: new RegExp(`^${name}`) }))

    press('Progress')
    await waitFor(() => expect(document.getElementById('progress-pane')).toBeTruthy())
    expect(workspace.getAttribute('data-view')).toBe('progress')
    expect(pressed()).toEqual(['view-progress'])
    expect(storage.getItem('fleet:view')).toBe('progress')
    // Its own pane, not the Sessions one, and no inspector beside it.
    expect(document.getElementById('sessions-pane')).toBeNull()
    expect(document.getElementById('detail')).toBeNull()

    for (const [name, view] of [['Today', 'today'], ['Progress', 'progress'], ['Projects', 'projects'], ['Sessions', 'sessions'], ['Progress', 'progress']] as const) {
      press(name)
      await waitFor(() => expect(workspace.getAttribute('data-view')).toBe(view))
      expect(pressed()).toEqual([`view-${view}`])
    }
    expect(document.getElementById('progress-pane')).toBeTruthy()
  })

  it('opens Search with Cmd+K and New agent with Ctrl+N, one layer at a time, and returns focus on close', async () => {
    boot(fixtureFetch())
    const search = screen.getByRole('button', { name: /Search/ })
    search.focus()

    fireEvent.keyDown(document, { key: 'k', metaKey: true })
    const dialog = await screen.findByRole('dialog', { name: 'Find the thread.' })
    expect(search.getAttribute('aria-expanded')).toBe('true')
    expect(document.body.hasAttribute('data-modal')).toBe(true)
    expect(dialog.contains(document.activeElement)).toBe(true)

    fireEvent.keyDown(document, { key: 'N', ctrlKey: true })
    expect(await screen.findByRole('dialog', { name: 'What are we working on?' })).toBeTruthy()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.body.hasAttribute('data-modal')).toBe(false)
    expect(document.activeElement).toBe(search)

    // Shift and Alt variants belong to the browser.
    fireEvent.keyDown(document, { key: 'k', metaKey: true, shiftKey: true })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('mounts and unmounts in StrictMode without leaving a listener, timer subscription or second stream', async () => {
    const counts = new Map<string, number>()
    const track = (target: EventTarget, label: string) => {
      const add = target.addEventListener.bind(target)
      const remove = target.removeEventListener.bind(target)
      vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
        counts.set(`${label}:${type}`, (counts.get(`${label}:${type}`) ?? 0) + 1)
        add(type, listener, options)
      })
      vi.spyOn(target, 'removeEventListener').mockImplementation((type, listener, options) => {
        counts.set(`${label}:${type}`, (counts.get(`${label}:${type}`) ?? 0) - 1)
        remove(type, listener, options)
      })
    }
    track(document, 'document')
    track(window, 'window')

    harness = makeHarness(fixtureFetch())
    harness.client.start()
    for (let i = 0; i < 20; i++) {
      const view = render(
        <StrictMode>
          <Providers harness={harness}>
            <AppShell />
          </Providers>
        </StrictMode>,
      )
      await screen.findByText('Clean up stale branches', { selector: '.session-title' })
      // Exactly one shortcut listener while mounted.
      expect(counts.get('document:keydown')).toBe(1)
      view.unmount()
    }
    const leaked = [...counts].filter(([, n]) => n !== 0)
    expect(leaked).toEqual([])
    expect(harness.clock.size).toBe(0)
    expect(FakeEventSource.instances).toHaveLength(1)
  })
})
