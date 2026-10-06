// A26 (hard gate) and A27 at app level. Offline, reconnect, a new token and a new
// server instance: the last good state stays on screen until fresh answers replace it,
// conditional state and approvals from the old process are dropped, drafts survive,
// and nothing is POSTed twice without the person asking. A27: a storage failure shows
// its banner, keeps the draft, still allows Stop, and the banner leaves only once the
// server says a write succeeded.
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '../test/fakes'
import { type MountedApp, appFleet, bannerText, emit, mountApp, rowKeys, sessionRow } from './appFleet'

let app: MountedApp | null = null
afterEach(() => {
  app?.unmount()
  app = null
  vi.unstubAllGlobals()
})

const STORAGE = 'Unable to save Fleet conversations. Check disk space and permissions.'
const settle = (ms = 30) => act(async () => new Promise(r => setTimeout(r, ms)))
const composer = () => screen.getByRole('combobox', { name: 'Message this agent' }) as HTMLTextAreaElement

async function bootOn(id: string) {
  const fleet = appFleet()
  app = mountApp(fleet)
  await screen.findByText('Clean up stale branches', { selector: '.session-title' })
  act(() => app!.stream().open())
  if (id !== 'm-claude-approval') await act(async () => sessionRow(id)?.click())
  await waitFor(() => expect(sessionRow(id)?.getAttribute('aria-pressed')).toBe('true'))
  await screen.findByRole('log', { name: 'Agent conversation' })
  await waitFor(() => expect(app!.client.store.isFetching(`managed:${id}`)).toBe(false))
  return { fleet, app }
}

/** The stream drops and the browser reconnects it. */
async function reconnect(a: MountedApp) {
  await act(async () => a.stream().fail())
  await act(async () => a.stream().open())
}

describe('A26 offline, reconnect, new token, new instance', () => {
  it('keeps the last good list and the draft offline, then reconciles unconditionally on reconnect', async () => {
    const user = userEvent.setup()
    const { fleet, app } = await bootOn('m-claude-idle')
    await user.type(composer(), 'A draft written offline')
    const shown = rowKeys()
    fleet.offline = true
    await emit(app, 'list', '{}')
    await waitFor(() => expect(bannerText()).toBe('Connection lost. Showing the last successful snapshot; retrying automatically.'))
    expect(rowKeys()).toEqual(shown)
    expect(composer().value).toBe('A draft written offline')
    expect(screen.getByRole('log', { name: 'Agent conversation' }).textContent).toContain('Fixed. The test waited on a timer')

    // Back: the stream reopens, which says nothing about what was missed. Everything on
    // screen is read again without conditional headers.
    fleet.offline = false
    fleet.patchRow('m-claude-idle', { name: 'Changed while offline', title: 'Changed while offline' })
    const mark = fleet.gets.length
    await reconnect(app)
    await screen.findByText('Changed while offline', { selector: '.session-title' })
    await waitFor(() => expect(bannerText()).toBeNull())
    const after = fleet.gets.slice(mark)
    const list = after.filter(g => g.url === '/api/sessions')
    const detail = after.filter(g => g.url === '/api/managed/m-claude-idle')
    expect(list.length).toBeGreaterThanOrEqual(1)
    expect(detail.length).toBeGreaterThanOrEqual(1)
    expect(list[0]?.ifNoneMatch).toBeNull()
    expect(detail[0]?.ifNoneMatch).toBeNull()
    expect(composer().value).toBe('A draft written offline')
    expect(fleet.posts).toEqual([])
  })

  it('a new server instance drops old approvals and ETags, keeps the draft, and approves nothing by itself', async () => {
    const user = userEvent.setup()
    const { fleet, app } = await bootOn('m-claude-approval')
    await screen.findByRole('heading', { name: 'Delete the remote branch' })
    await user.type(composer(), 'Keep me across the restart')

    // The server restarts: new process, new token, and the pending approval is gone
    // (a restart never approves anything; the turn it belonged to ended).
    fleet.setControl({ instanceId: 'FIXTURE_INSTANCE_2', token: 'FIXTURE_TOKEN_2' })
    fleet.patchSession('m-claude-approval', { approvals: [], status: 'idle' })
    fleet.patchRow('m-claude-approval', { managedStatus: 'idle' })
    const mark = fleet.gets.length
    await reconnect(app)
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Delete the remote branch' })).toBeNull())
    await settle()
    const after = fleet.gets.slice(mark)
    expect(after.some(g => g.url === '/api/control')).toBe(true)
    // Every conditional read after the restart starts without the old ETags.
    for (const url of ['/api/sessions', '/api/managed/m-claude-approval']) {
      expect(after.find(g => g.url === url)?.ifNoneMatch ?? null).toBeNull()
    }
    expect(composer().value).toBe('Keep me across the restart')
    expect(fleet.posts).toEqual([])

    // The next deliberate command carries the new token, once.
    await user.keyboard('{Enter}')
    await waitFor(() => expect(fleet.postsOf(/\/messages$/)).toHaveLength(1))
    expect(fleet.posts[0]?.token).toBe('FIXTURE_TOKEN_2')
  })

  it('a stale token is not retried blindly; the person resends and the server dedupes by requestId', async () => {
    const user = userEvent.setup()
    const { fleet } = await bootOn('m-claude-idle')
    // The server restarted without the stream noticing: the page still holds the old token.
    fleet.setControl({ instanceId: 'FIXTURE_INSTANCE_2', token: 'FIXTURE_TOKEN_2' })
    await user.type(composer(), 'Send after the restart')
    await user.keyboard('{Enter}')
    await screen.findByText('Reload Fleet before sending commands.')
    await settle(50)
    expect(fleet.postsOf(/\/messages$/)).toHaveLength(1)
    expect(composer().value).toBe('Send after the restart')

    await user.click(screen.getByRole('button', { name: /^(Send|Queue)$/ }))
    await waitFor(() => expect(fleet.postsOf(/\/messages$/)).toHaveLength(2))
    const [first, second] = fleet.postsOf(/\/messages$/)
    expect(first?.token).toBe('FIXTURE_TOKEN')
    expect(second?.token).toBe('FIXTURE_TOKEN_2')
    expect(second?.body.requestId).toBe(first?.body.requestId)
    await waitFor(() => expect(composer().value).toBe(''))
  })

  it('an ambiguous failure (accepted, answer lost) is reconciled by reading, never by sending again', async () => {
    const user = userEvent.setup()
    const { fleet } = await bootOn('m-claude-idle')
    fleet.onPost = post => {
      // The server took it; the connection dropped before the answer.
      const messages = [...fleet.held('m-claude-idle')!.session.messages, { id: 'accepted-1', role: 'user', text: post.body.message, at: 1791280800000 }]
      fleet.patchSession('m-claude-idle', { messages })
      throw new TypeError('Failed to fetch')
    }
    const before = fleet.getsOf(/^\/api\/managed\/m-claude-idle$/).length
    await user.type(composer(), 'Did this land?')
    await user.keyboard('{Enter}')
    await screen.findByText(/Fleet did not answer/)
    await waitFor(() => expect(fleet.getsOf(/^\/api\/managed\/m-claude-idle$/).length).toBeGreaterThan(before))
    await waitFor(() => expect(screen.getByRole('log', { name: 'Agent conversation' }).textContent).toContain('Did this land?'))
    await settle(100)
    expect(fleet.postsOf(/\/messages$/)).toHaveLength(1)
  })
})

describe('A27 storage failure', () => {
  it('shows the banner, keeps the draft, still allows Stop, and clears only after a write lands', async () => {
    const user = userEvent.setup()
    const { fleet, app } = await bootOn('m-claude-running')
    // The disk fills: the server latches, and its list says so.
    fleet.setSessions({ ...fleet.snapshot(), storageError: STORAGE })
    fleet.setControl({ storageError: STORAGE })
    let latched = true
    fleet.onPost = post => {
      if (latched && !post.path.endsWith('/stop')) return jsonResponse({ error: STORAGE, code: 'STORAGE_UNAVAILABLE', retryable: true }, 503)
      if (post.path.endsWith('/stop')) fleet.patchSession('m-claude-running', { status: 'idle' })
      return jsonResponse(fleet.held('m-claude-running'))
    }
    await emit(app, 'list', '{}')
    await waitFor(() => expect(bannerText()).toBe(STORAGE))

    // A send is refused with the reason; the draft stays.
    await user.type(composer(), 'This must not be lost')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(fleet.postsOf(/\/messages$/)).toHaveLength(1))
    await waitFor(() => expect(document.querySelector('#composer, form')?.textContent ?? '').toContain(STORAGE))
    expect(composer().value).toBe('This must not be lost')

    // Reads still work and do not clear the banner.
    await emit(app, 'list', '{}')
    await settle()
    expect(bannerText()).toBe(STORAGE)

    // Stop stays allowed.
    const stop = document.getElementById('stop-agent') as HTMLButtonElement
    expect(stop.disabled).toBe(false)
    await user.click(stop)
    await waitFor(() => expect(fleet.postsOf(/\/stop$/)).toHaveLength(1))
    expect(bannerText()).toBe(STORAGE)

    // The disk recovers; the server clears its latch only once a write succeeds.
    latched = false
    await user.click(screen.getByRole('button', { name: /^(Send|Queue)$/ }))
    await waitFor(() => expect(fleet.postsOf(/\/messages$/)).toHaveLength(2))
    fleet.setSessions({ ...fleet.snapshot(), storageError: null })
    fleet.setControl({ storageError: null })
    await emit(app, 'list', '{}')
    await waitFor(() => expect(bannerText()).toBeNull())
    await waitFor(() => expect(composer().value).toBe(''))
    // The retry reused the refused attempt's requestId, so the server cannot double it.
    const [refused, accepted] = fleet.postsOf(/\/messages$/)
    expect(accepted?.body.requestId).toBe(refused?.body.requestId)
  })
})
