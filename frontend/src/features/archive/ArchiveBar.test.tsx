// The archive bar (A21, F24): the Offline filter offers the sweep and the standing
// rule, sharing one age; the Archived filter restores everything. The restored-row
// exemption and searchability are server rules (archive.test.js); here the page must
// send exactly the ids and rule the operator chose.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import mixedControl from '../../test/fixtures/fleet-mixed/get-control.json'
import mixedSessions from '../../test/fixtures/fleet-mixed/get-sessions.json'
import { resetSessionFilter, setSessionFilter } from '../sessions/filter'
import { SessionsPane } from '../sessions/SessionsPane'
import { T0, bodyOf, fakeFleet, mount } from '../sessions/testing'

type Row = Record<string, unknown>
const mixed = bodyOf<{ sessions: Row[]; archiveRule: { enabled: boolean; days: number } }>(mixedSessions)
const OLD = T0 - 10 * 86400000
// Make one offline external row old enough for the 7-day rule.
const oldId = '000000c1-0000-4000-8000-000000000010'
const aged = { ...mixed, sessions: mixed.sessions.map(row => (row.sessionId === oldId ? { ...row, lastActivity: OLD } : row)) }

const present = (id: string): HTMLElement => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`#${id} is not drawn yet`)
  return el
}

afterEach(() => resetSessionFilter())

function boot(sessions = aged) {
  const fleet = fakeFleet({ control: mixedControl.response.body, sessions })
  const view = mount(fleet, <SessionsPane />)
  return { fleet, ...view }
}

describe('ArchiveBar', () => {
  it('is hidden except on the Offline and Archived filters', async () => {
    boot()
    await screen.findByText('Clean up stale branches', { selector: '.session-title' })
    expect(document.getElementById('archive-bar')).toBeNull()
  })

  it('archives the offline sessions older than the rule, and only those', async () => {
    const { fleet } = boot()
    act(() => setSessionFilter({ status: 'dead' }))
    const bar = await waitFor(() => present('archive-bar'))
    expect(within(bar).getByText('Archive offline sessions untouched for over')).toBeTruthy()
    await act(async () => fireEvent.click(within(bar).getByRole('button', { name: 'Archive 1' })))
    expect(fleet.posts).toEqual([{ url: '/api/archive', body: { ids: [oldId], archived: true } }])
    expect(await screen.findByText('1 session archived')).toBeTruthy()
  })

  it('says when nothing is that old, and saves the age and the standing rule', async () => {
    const { fleet } = boot(mixed)
    act(() => setSessionFilter({ status: 'dead' }))
    const bar = await waitFor(() => present('archive-bar'))
    expect(within(bar).getByText('Nothing that old')).toBeTruthy()
    const rule = within(bar).getByRole('checkbox', { name: /Keep tidying automatically/ }) as HTMLInputElement
    expect(rule.checked).toBe(mixed.archiveRule.enabled)
    await act(async () => fireEvent.click(rule))
    expect(fleet.posts.at(-1)).toEqual({ url: '/api/archive/rule', body: { enabled: !mixed.archiveRule.enabled, days: mixed.archiveRule.days } })
    // The native select (touch widths) carries the same choices as the menu.
    const days = bar.querySelector('select') as HTMLSelectElement
    expect([...days.options].map(o => o.value)).toEqual(['3', '7', '14', '30'])
    await act(async () => fireEvent.change(days, { target: { value: '3' } }))
    expect(fleet.posts.at(-1)).toEqual({ url: '/api/archive/rule', body: { enabled: mixed.archiveRule.enabled, days: 3 } })
  })

  it('restores every archived session from the Archived filter', async () => {
    const { fleet } = boot()
    act(() => setSessionFilter({ status: 'archived' }))
    const bar = await waitFor(() => present('archive-bar'))
    expect(within(bar).getByText(/2 sessions put away/)).toBeTruthy()
    await act(async () => fireEvent.click(within(bar).getByRole('button', { name: 'Restore all' })))
    const ids = mixed.sessions.filter(row => row.archived).map(row => row.sessionId)
    expect(fleet.posts).toEqual([{ url: '/api/archive', body: { ids, archived: false } }])
    expect(await screen.findByText('2 sessions restored')).toBeTruthy()
  })

  it('leaves the Archived filter once the last archived session is restored', async () => {
    const { fleet, harness } = boot()
    act(() => setSessionFilter({ status: 'archived' }))
    await waitFor(() => expect(document.getElementById('archive-bar')).toBeTruthy())
    fleet.sessions.set({ ...aged, sessions: aged.sessions.map(row => ({ ...row, archived: false })) })
    await act(() => harness.client.store.refresh(harness.client.resources.sessions))
    await waitFor(() => expect(document.getElementById('filter-trigger')!.textContent).toBe('All sessions'))
    expect(document.getElementById('archive-bar')).toBeNull()
  })

  it('shows the server refusal instead of a false success', async () => {
    const fleet = fakeFleet({
      control: mixedControl.response.body,
      sessions: aged,
      post: () => new Response(JSON.stringify({ error: 'Archive is busy.' }), { status: 500, headers: { 'content-type': 'application/json' } }),
    })
    mount(fleet, <SessionsPane />)
    act(() => setSessionFilter({ status: 'dead' }))
    const bar = await waitFor(() => present('archive-bar'))
    await act(async () => fireEvent.click(within(bar).getByRole('button', { name: 'Archive 1' })))
    expect(await screen.findByText('Archive is busy.')).toBeTruthy()
  })
})
