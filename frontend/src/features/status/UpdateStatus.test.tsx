// A22 and the update pill states (F25): hidden, available, source checkout advice,
// installing, restarting, error, and the wait for a new server identity.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import updateFixture from '../../test/fixtures/fleet-mixed/get-update.json'
import { deferred, jsonResponse } from '../../test/fakes'
import { page } from '../settings/handover'
import { control, fakeFleet, mount, unmountAll } from '../settings/testing'
import { RESTART_DEADLINE_MS, RESTART_FAILED, UpdateStatus } from './UpdateStatus'
import { UpdatePill } from './UpdatePill'

const current = updateFixture.response.body.update
const available = { ...current, latest: '0.55.0', available: true, state: 'available' }

const pill = () => document.getElementById('update-pill') as HTMLButtonElement | null

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  unmountAll()
})

describe('UpdatePill states', () => {
  const noop = () => {}
  it('is absent when there is nothing to install', () => {
    const { container } = render(<UpdatePill update={current as never} phase="idle" onInstall={noop} />)
    expect(container.innerHTML).toBe('')
    const none = render(<UpdatePill update={null} phase="idle" onInstall={noop} />)
    expect(none.container.innerHTML).toBe('')
  })

  it('offers the version on npm', () => {
    render(<UpdatePill update={available as never} phase="idle" onInstall={noop} />)
    expect(pill()?.textContent).toBe('↑ v0.55.0')
    expect(pill()?.disabled).toBe(false)
    expect(pill()?.title).toBe('Claude Fleet v0.55.0 is available. Click to install it and reload.')
  })

  it('gives only advice on a git checkout and on a non-npm install', () => {
    const { unmount } = render(<UpdatePill update={{ ...available, canInstall: false, channel: 'source' } as never} phase="idle" onInstall={noop} />)
    expect(pill()?.disabled).toBe(true)
    expect(pill()?.title).toContain('update it with git pull')
    unmount()
    render(<UpdatePill update={{ ...available, canInstall: false, channel: 'other' } as never} phase="idle" onInstall={noop} />)
    expect(pill()?.title).toContain('was not installed with npm')
  })

  it('reports progress without inviting a second click, and says Restarting once installed', () => {
    const { rerender } = render(<UpdatePill update={available as never} phase="installing" onInstall={noop} />)
    expect(pill()?.textContent).toBe('Installing…')
    expect(pill()?.disabled).toBe(true)
    rerender(<UpdatePill update={available as never} phase="restarting" onInstall={noop} />)
    expect(pill()?.textContent).toBe('Restarting…')
    expect(pill()?.disabled).toBe(true)
    expect(pill()?.title).toBe('Fleet will reload itself when this finishes.')
  })

  it('shows the failure in its title and can be tried again', () => {
    render(<UpdatePill update={available as never} phase="error" error="npm could not write to the global folder." onInstall={noop} />)
    expect(pill()?.disabled).toBe(false)
    expect(pill()?.title).toBe('npm could not write to the global folder. Click to try again.')
  })
})

describe('UpdateStatus', () => {
  const setup = (update: unknown) => {
    const fleet = fakeFleet()
    fleet.json('GET', '/api/update', { update })
    return { fleet, ...mount(fleet, <UpdateStatus />) }
  }

  it('stays out of the way when current and appears when a newer Fleet is published', async () => {
    const { fleet } = setup(current)
    await waitFor(() => expect(fleet.to('GET', '/api/update')).toHaveLength(1))
    expect(pill()).toBeNull()
  })

  it('installs, waits for the new instance (the old one still answering is not enough), then reloads', async () => {
    const reload = vi.spyOn(page, 'reload').mockImplementation(() => {})
    const { fleet } = setup(available)
    await screen.findByRole('button', { name: '↑ v0.55.0' })
    fleet.json('POST', '/api/update', { update: { ...available, state: 'installed', installed: '0.55.0', restarting: true } })
    fireEvent.click(pill()!)
    await waitFor(() => expect(pill()?.textContent).toBe('Restarting…'))
    expect(fleet.to('POST', '/api/update')[0]?.body).toEqual({})
    expect(fleet.to('POST', '/api/update')[0]?.token).toBe(control.token)

    // The old process keeps answering 200 on /api/control with its old identity.
    await new Promise(resolve => setTimeout(resolve, 1600))
    expect(fleet.to('GET', '/api/control').length).toBeGreaterThan(1)
    expect(reload).not.toHaveBeenCalled()
    expect(pill()?.textContent).toBe('Restarting…')

    // The new build answers with a different identity.
    fleet.setControl({ ...control, buildId: '0.55.0+ffffffffffff', instanceId: 'new-process' })
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1), { timeout: 3000 })
  }, 10_000)

  it('shows a recovery message when the new server never reports a new identity', async () => {
    const { fleet } = setup(available)
    await screen.findByRole('button', { name: '↑ v0.55.0' })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const reload = vi.spyOn(page, 'reload').mockImplementation(() => {})
    fleet.json('POST', '/api/update', { update: { ...available, state: 'installed', restarting: true } })
    fireEvent.click(pill()!)
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)))
    expect(pill()?.textContent).toBe('Restarting…')
    await act(async () => void (await vi.advanceTimersByTimeAsync(RESTART_DEADLINE_MS + 2000)))
    expect(reload).not.toHaveBeenCalled()
    expect(screen.getByText(RESTART_FAILED)).toBeTruthy()
    expect(pill()?.textContent).toBe('↑ v0.55.0')
    expect(pill()?.disabled).toBe(false)
    expect(pill()?.title).toContain('did not come back')
  })

  it('reports a failed install and lets the operator try again', async () => {
    const { fleet } = setup(available)
    await screen.findByRole('button', { name: '↑ v0.55.0' })
    fleet.json('POST', '/api/update', { error: 'npm could not write to the global folder.', code: 'UPSTREAM_ERROR' }, 502)
    fireEvent.click(pill()!)
    expect(await screen.findByText('npm could not write to the global folder.', { selector: '#toast' })).toBeTruthy()
    expect(pill()?.disabled).toBe(false)
    expect(pill()?.getAttribute('data-phase')).toBe('error')
  })

  it('says to restart when the install finished but the server is not restarting itself', async () => {
    const { fleet } = setup(available)
    await screen.findByRole('button', { name: '↑ v0.55.0' })
    fleet.json('POST', '/api/update', { update: { ...available, state: 'installed', installed: '0.55.0', restarting: false } })
    fireEvent.click(pill()!)
    expect(await screen.findByText('v0.55.0 installed. Restart Fleet to use it.', { selector: '#toast' })).toBeTruthy()
    expect(pill()?.getAttribute('data-phase')).toBe('idle')
  })

  it('ignores a second click while installing', async () => {
    const { fleet } = setup(available)
    await screen.findByRole('button', { name: '↑ v0.55.0' })
    const answer = deferred<Response>()
    fleet.on('POST', '/api/update', () => answer.promise)
    fireEvent.click(pill()!)
    await waitFor(() => expect(pill()?.textContent).toBe('Installing…'))
    fireEvent.click(pill()!)
    answer.resolve(jsonResponse({ update: { ...available, installed: '0.55.0', restarting: false } }))
    await waitFor(() => expect(pill()?.textContent).toBe('↑ v0.55.0'))
    expect(fleet.to('POST', '/api/update')).toHaveLength(1)
  })
})
