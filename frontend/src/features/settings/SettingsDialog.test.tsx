// A20: the settings dialog against a fake Fleet. Queue, default approval mode, service
// handover, the gateway key and the browser-side notification and sound choices.
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '../../test/fakes'
import { sounds } from '../sounds/sounds'
import { page } from './handover'
import { SettingsDialog } from './SettingsDialog'
import { type Fleet, control, fakeFleet, mount, snapshot, unmountAll } from './testing'

const queue = (extra: Record<string, unknown> = {}) => ({ enabled: false, limit: 8, paused: false, running: 0, waiting: 0, ...extra })
const withQueue = (q: unknown) => ({ ...snapshot, queue: q })

const UNSUPPORTED = { service: { supported: false, enabled: false, loaded: false, managed: false } }
const SUPPORTED = { service: { supported: true, enabled: false, loaded: false, managed: false } }

function open(fleet: Fleet, answers: { service?: unknown; gateway?: unknown } = {}) {
  fleet.json('GET', '/api/settings/approval-mode', { defaultApprovalMode: 'all' })
  fleet.json('GET', '/api/service', answers.service ?? UNSUPPORTED)
  fleet.json('GET', '/api/settings/gateway', answers.gateway ?? { gateway: { configured: false, source: null } })
  const onClose = vi.fn()
  const view = mount(fleet, <SettingsDialog modal={{ kind: 'settings' }} onClose={onClose} />)
  return { ...view, onClose }
}

const pick = (id: string, value: string) => fireEvent.change(document.getElementById(id)!, { target: { value } })

beforeEach(() => localStorage.clear())
afterEach(() => {
  vi.restoreAllMocks()
  unmountAll()
})

describe('SettingsDialog: queue', () => {
  it('shows the authoritative counts and hides Pause while the queue is off', async () => {
    open(fakeFleet({ sessions: withQueue(queue({ running: 2, limit: 3, waiting: 1 })) }))
    await waitFor(() => expect(document.getElementById('queue-status')?.textContent).toBe('2/3 running · 1 waiting'))
    expect(screen.queryByRole('button', { name: /queue/ })).toBeNull()
    expect((document.getElementById('queue-enabled') as HTMLInputElement).checked).toBe(false)
    expect((document.getElementById('queue-limit') as HTMLSelectElement).value).toBe('3')
  })

  it('turns the queue on, changes the limit, pauses and resumes, one change at a time', async () => {
    const fleet = fakeFleet({ sessions: withQueue(queue()) })
    let state = queue()
    fleet.on('POST', '/api/queue', ({ body }) => {
      state = { ...state, ...body }
      return jsonResponse({ queue: state })
    })
    open(fleet)
    await waitFor(() => expect(document.getElementById('queue-status')?.textContent).toContain('0/8 running'))

    await userEvent.click(document.getElementById('queue-enabled')!)
    await waitFor(() => expect((document.getElementById('queue-enabled') as HTMLInputElement).checked).toBe(true))
    expect(fleet.to('POST', '/api/queue')[0]?.body).toEqual({ enabled: true })

    pick('queue-limit', '2')
    await waitFor(() => expect(document.getElementById('queue-status')?.textContent).toContain('0/2 running'))
    expect(fleet.to('POST', '/api/queue')[1]?.body).toEqual({ limit: 2 })

    await userEvent.click(screen.getByRole('button', { name: 'Pause queue' }))
    expect(await screen.findByRole('button', { name: 'Resume queue' })).toBeTruthy()
    expect(document.getElementById('queue-status')?.textContent).toBe('0/2 running · 0 waiting · paused: running agents continue, new ones wait')
    await userEvent.click(screen.getByRole('button', { name: 'Resume queue' }))
    expect(await screen.findByRole('button', { name: 'Pause queue' })).toBeTruthy()
    expect(fleet.to('POST', '/api/queue').map(c => c.body)).toEqual([{ enabled: true }, { limit: 2 }, { paused: true }, { paused: false }])
  })

  it('explains a refused disable (tasks are waiting) and shows the server state again', async () => {
    const fleet = fakeFleet({ sessions: withQueue(queue({ enabled: true, limit: 2, running: 2, waiting: 3 })) })
    fleet.json('POST', '/api/queue', { error: 'Three tasks are waiting. Let them start or stop them first.', code: 'CONFLICT' }, 409)
    open(fleet)
    await waitFor(() => expect((document.getElementById('queue-enabled') as HTMLInputElement).checked).toBe(true))
    await userEvent.click(document.getElementById('queue-enabled')!)
    expect((await screen.findByText('Three tasks are waiting. Let them start or stop them first.')).getAttribute('role')).toBe('alert')
    expect((document.getElementById('queue-enabled') as HTMLInputElement).checked).toBe(true)
    expect(document.getElementById('queue-status')?.textContent).toBe('2/2 running · 3 waiting')
    // The next successful change clears the message.
    fleet.json('POST', '/api/queue', { queue: queue({ enabled: true, limit: 5, running: 2, waiting: 3 }) })
    pick('queue-limit', '5')
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('explains an invalid limit from the server', async () => {
    const fleet = fakeFleet({ sessions: withQueue(queue({ enabled: true })) })
    fleet.json('POST', '/api/queue', { error: 'Choose 1–8 concurrent tasks.', code: 'VALIDATION' }, 400)
    open(fleet)
    await waitFor(() => expect((document.getElementById('queue-enabled') as HTMLInputElement).checked).toBe(true))
    pick('queue-limit', '3')
    expect(await screen.findByText('Choose 1–8 concurrent tasks.')).toBeTruthy()
    expect((document.getElementById('queue-limit') as HTMLSelectElement).value).toBe('8')
  })
})

describe('SettingsDialog: default approval mode', () => {
  it('saves the mode for agents created from now on and refreshes control so launches see it', async () => {
    const fleet = fakeFleet()
    fleet.json('POST', '/api/settings/approval-mode', { defaultApprovalMode: 'ask' })
    open(fleet)
    await waitFor(() => expect((document.getElementById('default-approval-mode') as HTMLSelectElement).value).toBe('all'))
    const controlReads = fleet.to('GET', '/api/control').length
    pick('default-approval-mode', 'ask')
    await waitFor(() => expect(fleet.to('GET', '/api/control').length).toBeGreaterThan(controlReads))
    expect(fleet.to('POST', '/api/settings/approval-mode')[0]?.body).toEqual({ mode: 'ask' })
    expect((document.getElementById('default-approval-mode') as HTMLSelectElement).value).toBe('ask')
    expect(screen.getByText(/Applies to agents you create from now on\. Existing agents keep their mode/)).toBeTruthy()
  })

  it('keeps the old mode and says why when the save fails', async () => {
    const fleet = fakeFleet()
    fleet.json('POST', '/api/settings/approval-mode', { error: 'Choose ask, auto or all.', code: 'VALIDATION' }, 400)
    open(fleet)
    await waitFor(() => expect((document.getElementById('default-approval-mode') as HTMLSelectElement).value).toBe('all'))
    pick('default-approval-mode', 'auto')
    expect(await screen.findByText('Choose ask, auto or all.')).toBeTruthy()
    expect((document.getElementById('default-approval-mode') as HTMLSelectElement).value).toBe('all')
  })
})

describe('SettingsDialog: startup service', () => {
  it('says it is a macOS feature elsewhere and offers no switch', async () => {
    open(fakeFleet())
    await screen.findByText(/Available on macOS/)
    expect((document.getElementById('service-enabled') as HTMLInputElement).disabled).toBe(true)
  })

  it('hands over to the service, waits for a NEW instance (not the old one answering) and reloads', async () => {
    const fleet = fakeFleet()
    fleet.json('POST', '/api/service', { service: { supported: true, enabled: true, loaded: true, managed: false }, restarting: true })
    const reload = vi.spyOn(page, 'reload').mockImplementation(() => {})
    open(fleet, { service: SUPPORTED })
    await waitFor(() => expect((document.getElementById('service-enabled') as HTMLInputElement).disabled).toBe(false))
    await userEvent.click(document.getElementById('service-enabled')!)
    await screen.findByText('Handing Fleet over to macOS…')
    // The old process still answers with the same identity: not enough.
    await new Promise(resolve => setTimeout(resolve, 900))
    expect(reload).not.toHaveBeenCalled()
    fleet.setControl({ ...control, instanceId: 'new-instance-0001' })
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1), { timeout: 3000 })
  }, 8000)

  it('shows a recovery message when the service call is refused', async () => {
    const fleet = fakeFleet()
    fleet.json('POST', '/api/service', { error: 'launchctl refused.', code: 'UPSTREAM_ERROR' }, 502)
    open(fleet, { service: SUPPORTED })
    await waitFor(() => expect((document.getElementById('service-enabled') as HTMLInputElement).disabled).toBe(false))
    await userEvent.click(document.getElementById('service-enabled')!)
    expect(await screen.findByText('launchctl refused.')).toBeTruthy()
    expect((document.getElementById('service-enabled') as HTMLInputElement).checked).toBe(false)
  })
})

describe('SettingsDialog: AI gateway', () => {
  const gateway = (source: string | null) => ({ gateway: { configured: !!source, source } })

  it('saves a key, clears the field at once, and never stores or echoes it', async () => {
    const fleet = fakeFleet()
    const view = open(fleet)
    const input = (await screen.findByLabelText('Vercel AI Gateway API key')) as HTMLInputElement
    await waitFor(() => expect(input.disabled).toBe(false))
    expect(input.type).toBe('password')
    expect(screen.getByText(/No key configured/)).toBeTruthy()
    expect((document.getElementById('gateway-test') as HTMLButtonElement).disabled).toBe(true)
    expect((document.getElementById('gateway-remove') as HTMLButtonElement).disabled).toBe(true)

    fleet.json('POST', '/api/settings/gateway', gateway('saved'))
    await userEvent.type(input, 'vck_super_secret')
    expect(input.value).toBe('vck_super_secret')
    await userEvent.click(screen.getByRole('button', { name: 'Save key' }))
    expect(input.value).toBe('')
    expect(await screen.findByText('Key saved. Ready for new Auto sessions.')).toBeTruthy()
    expect(fleet.to('POST', '/api/settings/gateway')[0]?.body).toEqual({ action: 'save', apiKey: 'vck_super_secret' })
    expect(screen.getByText(/Configured · saved on this Mac/)).toBeTruthy()

    // No key anywhere a URL, storage or the page could keep it.
    expect(fleet.calls.some(c => c.url.includes('vck_super_secret'))).toBe(false)
    expect(JSON.stringify([...view.harness.storage.map])).not.toContain('vck_super_secret')
    expect(JSON.stringify({ ...localStorage })).not.toContain('vck_super_secret')
    expect(document.body.innerHTML).not.toContain('vck_super_secret')
    expect((document.getElementById('gateway-remove') as HTMLButtonElement).disabled).toBe(false)
  })

  it('tests and removes the saved key, and reports the safe test message', async () => {
    const fleet = fakeFleet()
    open(fleet, { gateway: gateway('saved') })
    await waitFor(() => expect((document.getElementById('gateway-test') as HTMLButtonElement).disabled).toBe(false))
    fleet.json('POST', '/api/settings/gateway', { ...gateway('saved'), test: { ok: true, message: 'Jev answered in 412 ms.' } })
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    expect(await screen.findByText('Jev answered in 412 ms.')).toBeTruthy()
    expect(fleet.to('POST', '/api/settings/gateway')[0]?.body).toEqual({ action: 'test' })

    fleet.json('POST', '/api/settings/gateway', gateway(null))
    await userEvent.click(screen.getByRole('button', { name: 'Remove saved key' }))
    expect(await screen.findByText('Saved key removed.')).toBeTruthy()
    expect(screen.getByText(/No key configured/)).toBeTruthy()
  })

  it('shows the server error and leaves no key behind when the save fails', async () => {
    const fleet = fakeFleet()
    open(fleet)
    const input = (await screen.findByLabelText('Vercel AI Gateway API key')) as HTMLInputElement
    await waitFor(() => expect(input.disabled).toBe(false))
    fleet.json('POST', '/api/settings/gateway', { error: 'That key was refused.', code: 'VALIDATION' }, 400)
    await userEvent.type(input, 'bad-key')
    await userEvent.click(screen.getByRole('button', { name: 'Save key' }))
    expect(await screen.findByText('That key was refused.')).toBeTruthy()
    expect(input.value).toBe('')
  })

  it('clears a typed key when the dialog closes', async () => {
    const fleet = fakeFleet()
    const view = open(fleet)
    const input = (await screen.findByLabelText('Vercel AI Gateway API key')) as HTMLInputElement
    await waitFor(() => expect(input.disabled).toBe(false))
    await userEvent.type(input, 'typed-then-closed')
    view.unmount()
    const again = open(fakeFleet())
    expect(((await screen.findByLabelText('Vercel AI Gateway API key')) as HTMLInputElement).value).toBe('')
    again.unmount()
    expect(document.body.innerHTML).not.toContain('typed-then-closed')
  })
})

describe('SettingsDialog: notifications and sounds', () => {
  it('stores the desktop notification choice per browser once the browser allows it', async () => {
    const fake: { permission: string; requestPermission: () => Promise<NotificationPermission> } = Object.assign(function Notification() {}, {
      permission: 'default',
      requestPermission: async (): Promise<NotificationPermission> => 'granted',
    })
    const request = vi.fn(async () => {
      fake.permission = 'granted'
      return 'granted' as NotificationPermission
    })
    fake.requestPermission = request
    vi.stubGlobal('Notification', fake)
    open(fakeFleet())
    const box = document.getElementById('notify-enabled') as HTMLInputElement
    expect(box.checked).toBe(false)
    await userEvent.click(box)
    await waitFor(() => expect(box.checked).toBe(true))
    expect(request).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('fleet.notify')).toBe('1')
    await userEvent.click(box)
    await waitFor(() => expect(box.checked).toBe(false))
    expect(localStorage.getItem('fleet.notify')).toBe('0')
  })

  it('says when notifications are blocked or unsupported and does not turn them on', async () => {
    vi.stubGlobal('Notification', Object.assign(function Notification() {}, { permission: 'denied', requestPermission: async () => 'denied' }))
    open(fakeFleet())
    await userEvent.click(document.getElementById('notify-enabled')!)
    await waitFor(() => expect(localStorage.getItem('fleet.notify')).toBe('0'))
    expect(document.getElementById('notify-status')?.textContent).toBe('Notifications are blocked for this page. Allow them in the browser settings.')
  })

  it('turns sounds off and on for this browser and plays a sample even when off', async () => {
    open(fakeFleet())
    const box = document.getElementById('sounds-enabled') as HTMLInputElement
    expect(box.checked).toBe(true)
    await userEvent.click(box)
    expect(localStorage.getItem('fleet.sounds')).toBe('0')
    expect(box.checked).toBe(false)
    const play = vi.spyOn(sounds, 'play')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Needs you' }))
    })
    expect(play).toHaveBeenCalledWith('ask', { force: true })
    await userEvent.click(box)
    expect(localStorage.getItem('fleet.sounds')).toBe('1')
  })
})
