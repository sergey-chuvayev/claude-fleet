// A19: the connections dialog against a fake Fleet. Check a target, act on a server
// with the lease of that check, recover from a stale lease without retrying the
// action, sign in through the browser with polling, expiry and cleanup, and never
// show what the server must not send.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '../../test/fakes'
import { type Fleet, control, fakeFleet, mount, unmountAll } from '../settings/testing'
import { ConnectionsDialog } from './ConnectionsDialog'
import { SIGN_IN_TIMEOUT_MS } from './useConnections'

const server = (name: string, status: string, extra: Record<string, unknown> = {}) => ({
  name,
  status,
  scope: 'project',
  internal: false,
  tools: [],
  canToggle: true,
  canAuthenticate: true,
  error: null,
  ...extra,
})

const result = (servers: unknown[], extra: Record<string, unknown> = {}) => ({
  connections: { cwd: '/fixture/repos/web-app', source: 'session', connectionId: 'lease-1', checkedAt: 1791280800000, servers, ...extra },
})

const SESSION = 'm-claude-running'

function open(fleet: Fleet, managedId: string | null = SESSION) {
  const onClose = vi.fn()
  const view = mount(fleet, <ConnectionsDialog modal={{ kind: 'connections', managedId: managedId as never }} onClose={onClose} />)
  return { ...view, onClose }
}

const flush = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)))

afterEach(() => {
  vi.useRealTimers()
  unmountAll()
})

describe('ConnectionsDialog', () => {
  it('checks the session it was opened for at once, worst first, and never shows private fields', async () => {
    const fleet = fakeFleet()
    fleet.json(
      'POST',
      '/api/connections',
      result([
        server('calendar', 'connected', { scope: 'claudeai', name: 'claude.ai Google Calendar', tools: ['list_events', 'create_event'] }),
        server('docs', 'failed', { error: 'Could not start.', env: { API_KEY: 'sk-secret' }, command: '/usr/bin/secret-tool', args: ['--token', 'hunter2'] }),
        server('fleet', 'connected', { internal: true, canToggle: false }),
        server('notion', 'needs-auth', { headers: { Authorization: 'Bearer top-secret' } }),
        server('old', 'disabled'),
      ]),
    )
    open(fleet)
    await screen.findByText('Failed', { selector: 'h3' })
    expect(fleet.to('POST', '/api/connections')[0]?.body).toEqual({ action: 'check', sessionId: SESSION })
    expect(fleet.to('POST', '/api/connections')[0]?.token).toBe(control.token)

    const groups = [...document.querySelectorAll('.connections-group > h3')].map(h => h.textContent?.replace(/\d+$/, '').trim())
    expect(groups).toEqual(['Failed', 'Connected', 'Needs sign-in', 'Off'])
    expect(screen.getByText('Google Calendar')).toBeTruthy()
    expect(screen.getByText('Claude.ai')).toBeTruthy()
    expect(screen.getByText('2 tools')).toBeTruthy()
    expect(screen.getByText(/2 of 5 connected · checked/)).toBeTruthy()
    expect(screen.getByText(/Live session · \/fixture\/repos\/web-app/)).toBeTruthy()

    const html = document.body.innerHTML
    for (const secret of ['sk-secret', 'secret-tool', 'hunter2', 'top-secret', 'API_KEY']) expect(html).not.toContain(secret)
    // Fleet's own server offers no actions.
    const row = screen.getByText('fleet').closest('li') as HTMLElement
    expect(within(row).queryByRole('button')).toBeNull()
  })

  it('checks a project directory when no session is chosen, and filters and searches the list', async () => {
    const fleet = fakeFleet()
    fleet.json('POST', '/api/connections', result([server('alpha', 'connected'), server('beta', 'failed'), server('gamma', 'connected')], { source: 'project' }))
    open(fleet, null)
    expect(screen.getByText('Your configured MCP servers will appear here.')).toBeTruthy()
    await userEvent.type(screen.getByLabelText('Project directory'), '/fixture/repos/web-app')
    await userEvent.click(screen.getByRole('button', { name: 'Check connections' }))
    await screen.findByText('alpha')
    expect(fleet.to('POST', '/api/connections')[0]?.body).toEqual({ action: 'check', cwd: '/fixture/repos/web-app' })
    expect(screen.getByText(/Project · \/fixture\/repos\/web-app\. Changes here do not reconnect/)).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: /^Failed/ }))
    expect(screen.queryByText('alpha')).toBeNull()
    expect(screen.getByText('beta')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /^All/ }))
    await userEvent.type(screen.getByLabelText('Find a connection'), 'gam')
    expect(screen.queryByText('alpha')).toBeNull()
    expect(screen.getByText('gamma')).toBeTruthy()
    // Typing in the search box keeps its focus.
    expect(document.activeElement).toBe(screen.getByLabelText('Find a connection'))
  })

  it('reconnects, turns off and turns on with the lease of the check it acts on', async () => {
    const fleet = fakeFleet()
    fleet.json('POST', '/api/connections', result([server('docs', 'failed'), server('mail', 'connected'), server('old', 'disabled')]))
    open(fleet)
    await screen.findByText('docs')

    fleet.json('POST', '/api/connections', result([server('docs', 'connected'), server('mail', 'connected'), server('old', 'disabled')], { connectionId: 'lease-2' }))
    await userEvent.click(screen.getByRole('button', { name: 'Reconnect docs' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reconnect docs' })).toBeNull())
    expect(fleet.to('POST', '/api/connections').at(-1)?.body).toEqual({
      action: 'reconnect',
      name: 'docs',
      sessionId: SESSION,
      connectionId: 'lease-1',
      source: 'session',
    })
    // The next action carries the new lease.
    await userEvent.click(screen.getByRole('button', { name: 'Turn on old' }))
    await waitFor(() => expect(fleet.to('POST', '/api/connections')).toHaveLength(3))
    expect(fleet.to('POST', '/api/connections').at(-1)?.body).toMatchObject({ action: 'enable', name: 'old', connectionId: 'lease-2' })
    await userEvent.click(screen.getByRole('button', { name: 'Turn off mail' }))
    await waitFor(() => expect(fleet.to('POST', '/api/connections')).toHaveLength(4))
    expect(fleet.to('POST', '/api/connections').at(-1)?.body).toMatchObject({ action: 'disable', name: 'mail' })
  })

  it('on a stale lease (409) says so, drops the lease, rechecks and never retries the action', async () => {
    const fleet = fakeFleet()
    fleet.json('POST', '/api/connections', result([server('docs', 'failed')]))
    open(fleet)
    await screen.findByText('docs')

    let calls = 0
    fleet.on('POST', '/api/connections', () => {
      calls++
      return calls === 1
        ? jsonResponse({ error: 'The connection changed. Check connections again before making changes.', code: 'CONFLICT' }, 409)
        : jsonResponse(result([server('docs', 'failed')], { connectionId: 'lease-fresh' }))
    })
    await userEvent.click(screen.getByRole('button', { name: 'Reconnect docs' }))
    expect((await screen.findByRole('alert')).textContent).toBe('The connection changed. Check connections again before making changes.')
    await waitFor(() => expect(calls).toBe(2))
    const [refused, recheck] = fleet.to('POST', '/api/connections').slice(-2)
    expect(refused?.body).toMatchObject({ action: 'reconnect', connectionId: 'lease-1' })
    expect(recheck?.body).toEqual({ action: 'check', sessionId: SESSION, source: 'session' })
    expect(recheck?.body).not.toHaveProperty('connectionId')
    expect(fleet.to('POST', '/api/connections').filter(c => c.body?.action === 'reconnect')).toHaveLength(1)
    // The re-check's answer is on screen and holds the new lease for the next action.
    await userEvent.click(screen.getByRole('button', { name: 'Reconnect docs' }))
    await waitFor(() => expect(fleet.to('POST', '/api/connections').at(-1)?.body).toMatchObject({ action: 'reconnect', connectionId: 'lease-fresh' }))
  })

  it('drops an answer for a target that has been replaced', async () => {
    const fleet = fakeFleet()
    let release: (r: Response) => void = () => {}
    fleet.on('POST', '/api/connections', () => new Promise<Response>(resolve => (release = resolve)))
    open(fleet, null)
    await userEvent.type(screen.getByLabelText('Project directory'), '/a')
    fireEvent.submit(document.getElementById('connections-form')!)
    // The operator edits the directory while A is being checked.
    fireEvent.change(screen.getByLabelText('Project directory'), { target: { value: '/b' } })
    release(jsonResponse(result([server('from-a', 'connected')], { cwd: '/a', source: 'project' })))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(screen.queryByText('from-a')).toBeNull()
    expect(screen.getByText('Check this project’s connections to see their status.')).toBeTruthy()
  })

  it('signs in through the browser, polls until it connects, and stops', async () => {
    vi.useFakeTimers()
    const fleet = fakeFleet()
    fleet.json('POST', '/api/connections', result([server('notion', 'needs-auth')]))
    const opened = vi.spyOn(window, 'open').mockReturnValue(null)
    open(fleet)
    await flush()
    expect(screen.getByText('notion')).toBeTruthy()

    fleet.json(
      'POST',
      '/api/connections',
      result([server('notion', 'needs-auth')], { auth: { name: 'notion', url: 'https://auth.example/notion', opened: true, needsAction: true, callback: true } }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Sign in notion' }))
    await flush()
    expect(screen.getByText('Waiting for you to finish signing in')).toBeTruthy()
    expect(screen.getByRole('link', { name: /Open page again/ }).getAttribute('href')).toBe('https://auth.example/notion')
    expect(screen.getByText('Signing in')).toBeTruthy()
    expect(opened).not.toHaveBeenCalled()
    expect(fleet.to('POST', '/api/connections').at(-1)?.body).toMatchObject({ action: 'authenticate', name: 'notion' })

    // Still waiting after one poll.
    await act(async () => void (await vi.advanceTimersByTimeAsync(4000)))
    expect(fleet.to('POST', '/api/connections').at(-1)?.body).toMatchObject({ action: 'check' })
    expect(screen.getByText('Waiting for you to finish signing in')).toBeTruthy()

    // The callback arrived: the next poll sees it.
    fleet.json('POST', '/api/connections', result([server('notion', 'connected', { tools: ['search'] })]))
    await act(async () => void (await vi.advanceTimersByTimeAsync(4000)))
    expect(screen.queryByText('Waiting for you to finish signing in')).toBeNull()
    expect(screen.getByText('notion is connected.', { exact: false })).toBeTruthy()
    const settled = fleet.calls.length
    await act(async () => void (await vi.advanceTimersByTimeAsync(20_000)))
    expect(fleet.calls.length).toBe(settled)
  })

  it('opens the page itself when the server could not, and offers Try again after the timeout', async () => {
    vi.useFakeTimers()
    const fleet = fakeFleet()
    fleet.json('POST', '/api/connections', result([server('notion', 'needs-auth')]))
    const opened = vi.spyOn(window, 'open').mockReturnValue(null)
    open(fleet)
    await flush()
    fleet.json('POST', '/api/connections', result([server('notion', 'needs-auth')], { auth: { url: 'https://auth.example/x', opened: false, needsAction: true } }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in notion' }))
    await flush()
    expect(opened).toHaveBeenCalledWith('https://auth.example/x', '_blank', 'noopener')

    await act(async () => void (await vi.advanceTimersByTimeAsync(SIGN_IN_TIMEOUT_MS + 8000)))
    expect(screen.getByText('Didn’t finish?')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Try again notion' })).toBeTruthy()
    // Polling has stopped once the sign-in expired.
    const seen = fleet.calls.length
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)))
    expect(fleet.calls.length).toBe(seen)
  })

  it('cancels a sign-in', async () => {
    vi.useFakeTimers()
    const fleet = fakeFleet()
    fleet.json('POST', '/api/connections', result([server('notion', 'needs-auth')], { auth: { url: 'https://auth.example/x', opened: true, needsAction: true } }))
    open(fleet)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in notion' }))
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText('Waiting for you to finish signing in')).toBeNull()
    expect(screen.getByRole('button', { name: 'Sign in notion' })).toBeTruthy()
  })

  it('cleans up every timer and request when the dialog closes mid sign-in', async () => {
    vi.useFakeTimers()
    const fleet = fakeFleet()
    fleet.json('POST', '/api/connections', result([server('notion', 'needs-auth')], { auth: { url: 'https://auth.example/x', opened: true, needsAction: true } }))
    const { unmount } = open(fleet)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in notion' }))
    await flush()
    unmount()
    const seen = fleet.calls.length
    await act(async () => void (await vi.advanceTimersByTimeAsync(60_000)))
    expect(fleet.calls.length).toBe(seen)
  })

  it('says there is nothing configured instead of an empty box', async () => {
    const fleet = fakeFleet()
    fleet.json('POST', '/api/connections', result([]))
    open(fleet)
    expect(await screen.findByText(/No MCP servers were reported for this project/)).toBeTruthy()
  })
})
