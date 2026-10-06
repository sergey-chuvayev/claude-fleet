// The session list against the fixture packs, through the real transport and app
// store: rows, counts and filters (A01), selection fallback and outside selections
// (F02), unseen activity (F03), and nested delegations under a team session (A02).
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useSelection } from '../../app/AppStore'
import { selectionKey } from '../../app/state'
import type { ManagedId, TranscriptId } from '../../domain/ids'
import { MemoryStorage } from '../../test/shell'
import mixedControl from '../../test/fixtures/fleet-mixed/get-control.json'
import mixedSessions from '../../test/fixtures/fleet-mixed/get-sessions.json'
import teamControl from '../../test/fixtures/teams-heavy/get-control.json'
import teamSessions from '../../test/fixtures/teams-heavy/get-sessions.json'
import teamDetail from '../../test/fixtures/teams-heavy/managed/t-team.json'
import { DelegationDetail } from '../agents/DelegationDetail'
import { resetSessionFilter } from './filter'
import { SessionsPane } from './SessionsPane'
import { bodyOf, fakeFleet, mount } from './testing'

type Body = { sessions: Array<Record<string, unknown>>; [key: string]: unknown }
const mixed = bodyOf<Body>(mixedSessions)
const teams = bodyOf<Body>(teamSessions)

function Bench() {
  const selection = useSelection('sessions')
  return (
    <>
      <div className="sessions-pane" id="sessions-pane">
        <SessionsPane />
      </div>
      <output data-testid="selection">{selection ? selectionKey(selection) : ''}</output>
      <aside id="detail">{selection?.kind === 'delegation' ? <DelegationDetail selection={selection} /> : null}</aside>
    </>
  )
}

const selected = () => screen.getByTestId('selection').textContent
const list = () => document.getElementById('session-list')!
const rows = () => [...list().querySelectorAll<HTMLButtonElement>('button.session:not(.session-child)')]
const titles = () => rows().map(row => row.querySelector('.session-title')?.textContent)
const pressed = () => [...list().querySelectorAll<HTMLButtonElement>('button[aria-pressed="true"]')]
const trigger = () => document.getElementById('filter-trigger')!
const openFilter = () => fireEvent.click(trigger())

beforeEach(() => resetSessionFilter())
afterEach(() => resetSessionFilter())

describe('SessionsPane against fleet-mixed (A01)', () => {
  const boot = (storage?: MemoryStorage) => {
    const fleet = fakeFleet({ control: mixedControl.response.body, sessions: mixed })
    const view = mount(fleet, <Bench />, storage ? { storage } : {})
    return { fleet, ...view }
  }
  const foreground = mixed.sessions.filter(row => !row.archived && !row.background)

  it('lists the foreground in server order, counts it, and selects the first row', async () => {
    boot()
    await screen.findByText('Clean up stale branches', { selector: '.session-title' })
    expect(rows()).toHaveLength(foreground.length)
    expect(document.getElementById('shown-count')!.textContent).toBe(String(foreground.length))
    expect(rows()[0]!.dataset.session).toBe('m-claude-approval')
    await waitFor(() => expect(selected()).toBe('managed:m-claude-approval'))
    expect(pressed()).toEqual([rows()[0]])
  })

  it('draws engine identity, status words, background attribution and linked work', async () => {
    boot()
    await screen.findByText('Clean up stale branches', { selector: '.session-title' })
    const row = (title: string) => rows().find(r => r.querySelector('.session-title')?.textContent === title)!
    expect(within(row('Codex: add retry logic')).getByText('Codex')).toBeTruthy()
    expect(within(row('Clean up stale branches')).getByText('Needs approval')).toBeTruthy()
    expect(within(row('Waiting on the terminal')).getByText('In terminal')).toBeTruthy()
    expect(within(row('Waiting for a free agent')).getByText('Queued')).toBeTruthy()
    // A row with no title falls back to its last prompt, then "Untitled session".
    const linked = rows().find(r => r.textContent?.includes('checkout-refactor'))!
    expect(linked.querySelector('.session-meta')!.textContent).toContain('2')
    // The current step of a running turn.
    expect(row('Migrate settings screen').querySelector('.turn')!.getAttribute('aria-label')).toBe(
      'This turn: 1 running commands. Now: Bash npm test',
    )
    // Unknown context is a dash, never 0%.
    const unknown = mixed.sessions.find(r => !r.archived && !r.background && r.contextTokens == null)
    if (unknown) {
      const el = rows().find(r => r.dataset.session === (unknown.managedId ?? unknown.sessionId))
      if (el) expect(el.querySelector('.session-context')!.textContent).toMatch(/^—/)
    }
  })

  it('filters by state, background and archive, with counts, and says when nothing matches', async () => {
    boot()
    await screen.findByText('Clean up stale branches', { selector: '.session-title' })
    openFilter()
    const menu = screen.getByRole('menu', { name: 'Filter sessions' })
    const offline = within(menu).getByRole('button', { name: /Offline/ })
    const deadCount = foreground.filter(r => r.state === 'dead').length
    expect(offline.querySelector('span')!.textContent).toBe(String(deadCount))
    fireEvent.click(offline)
    expect(rows()).toHaveLength(deadCount)
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    // The selection fell back to a row still shown.
    await waitFor(() => expect(rows().some(r => r.getAttribute('aria-pressed') === 'true')).toBe(true))

    openFilter()
    fireEvent.click(within(screen.getByRole('menu')).getByRole('button', { name: /Background/ }))
    expect(titles()).toHaveLength(1)
    expect(rows()[0]!.textContent).toContain('via a background program')

    openFilter()
    fireEvent.click(within(screen.getByRole('menu')).getByRole('button', { name: /Archived/ }))
    expect(rows()).toHaveLength(2)
    expect(rows().every(r => r.textContent?.includes('archived'))).toBe(true)

    openFilter()
    fireEvent.click(within(screen.getByRole('menu')).getByRole('button', { name: /Stale/ }))
    openFilter()
    fireEvent.click(within(screen.getByRole('menu')).getByRole('button', { name: /^Today/ }))
    expect(trigger().textContent).toBe('Stale · Today')
    expect(list().textContent).toContain('No sessions match your filters.')
  })

  it('closes the filter menu on Escape and on a click outside', async () => {
    boot()
    await screen.findByText('Clean up stale branches', { selector: '.session-title' })
    openFilter()
    expect(screen.getByRole('menu', { hidden: true }).hidden).toBe(false)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('menu', { hidden: true }).hidden).toBe(true)
    expect(document.activeElement?.id).toBe('filter-trigger')
    openFilter()
    fireEvent.click(document.body)
    expect(screen.getByRole('menu', { hidden: true }).hidden).toBe(true)
  })

  it('marks rows with output not yet seen, and selecting one marks it read', async () => {
    const storage = new MemoryStorage({ 'fleet:seen': JSON.stringify({ 'm-claude-running': 1 }) })
    const { harness } = boot(storage)
    await screen.findByText('Clean up stale branches', { selector: '.session-title' })
    const running = rows().find(r => r.dataset.session === 'm-claude-running')!
    expect(running.querySelector('.unseen')).toBeTruthy()
    expect(running.title).toBe('New output since you last opened this')
    // The selected row never reads as unseen.
    expect(rows()[0]!.querySelector('.unseen')).toBeNull()
    fireEvent.click(running)
    await waitFor(() => expect(selected()).toBe('managed:m-claude-running'))
    const activity = mixed.sessions.find(r => r.managedId === 'm-claude-running')!.lastActivity
    await waitFor(() => expect(JSON.parse(storage.map.get('fleet:seen')!)['m-claude-running']).toBe(activity))
    expect(running.querySelector('.unseen')).toBeNull()
    expect(harness.store.preferences.get().seen['m-claude-running']).toBe(activity)
  })

  it('hands a vanished selection to the row now at its place', async () => {
    const { fleet, harness } = boot()
    await screen.findByText('Clean up stale branches', { selector: '.session-title' })
    fireEvent.click(rows()[2]!)
    const third = rows()[2]!.dataset.session
    const next = rows()[3]!.dataset.session
    await waitFor(() => expect(selected()).toBe(`managed:${third}`))
    fleet.sessions.set({ ...mixed, sessions: mixed.sessions.filter(r => r.managedId !== third) })
    await act(() => harness.client.store.refresh(harness.client.resources.sessions))
    await waitFor(() => expect(selected()).toBe(`managed:${next}`))
  })

  it('widens the filter for a selection made elsewhere instead of dropping it, and scrolls to it', async () => {
    const scrolled: string[] = []
    const original = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.dataset.session ?? '')
    }
    try {
      const { harness } = boot()
      await screen.findByText('Clean up stale branches', { selector: '.session-title' })
      openFilter()
      fireEvent.click(within(screen.getByRole('menu')).getByRole('button', { name: /Offline/ }))
      await waitFor(() => expect(rows().every(r => r.textContent?.includes('Offline'))).toBe(true))

      // Search's Open in Fleet: select a busy row the Offline filter hides.
      act(() => harness.store.dispatch({ type: 'select', selection: { kind: 'managed', managedId: 'm-claude-running' as ManagedId } }))
      await waitFor(() => expect(trigger().textContent).toBe('All sessions'))
      expect(selected()).toBe('managed:m-claude-running')
      expect(pressed().map(r => r.dataset.session)).toEqual(['m-claude-running'])
      expect(scrolled).toContain('m-claude-running')

      // An archived row opens the archive.
      const archived = mixed.sessions.find(r => r.archived)!
      act(() =>
        harness.store.dispatch({
          type: 'select',
          selection: { kind: 'external', engine: 'claude', transcriptId: archived.sessionId as TranscriptId, pid: null },
        }),
      )
      await waitFor(() => expect(trigger().textContent).toBe('Archived'))
      expect(selected()).toBe(`claude:${archived.sessionId}`)

      // A filter the operator picks afterwards still reconciles the selection normally.
      openFilter()
      fireEvent.click(within(screen.getByRole('menu')).getByRole('button', { name: /Working/ }))
      await waitFor(() => expect(rows().every(r => !r.textContent?.includes('archived'))).toBe(true))
      expect(trigger().textContent).toBe('Working')
      await waitFor(() => expect(selected()).not.toBe(`claude:${archived.sessionId}`))
    } finally {
      HTMLElement.prototype.scrollIntoView = original
    }
  })

  it('says the fleet is quiet when there is nothing at all', async () => {
    const fleet = fakeFleet({ control: mixedControl.response.body, sessions: { sessions: [], counts: { busy: 0, idle: 0, stale: 0, dead: 0 }, total: 0 } })
    mount(fleet, <Bench />)
    expect(await screen.findByText(/Your fleet is quiet\./)).toBeTruthy()
    expect(selected()).toBe('')
  })
})

describe('delegation rows against teams-heavy (A02)', () => {
  const boot = (storage = new MemoryStorage()) => {
    const fleet = fakeFleet({ control: teamControl.response.body, sessions: teams, managed: { 't-team': bodyOf(teamDetail) } })
    return { fleet, storage, ...mount(fleet, <Bench />, { storage }) }
  }
  const team = teams.sessions.find(r => r.managedId === 't-team')!
  const delegations = team.delegations as Array<{ id: string; role: string; model: string; status: string }>
  const children = () => [...list().querySelectorAll<HTMLButtonElement>('button.session-child[data-session="t-team"]')]
  const toggle = () => list().querySelector<HTMLButtonElement>('[data-fold-session="t-team"]')!

  it('nests the recent 20 under the parent with role, model and status, and counts the rest', async () => {
    boot()
    await screen.findByText('Ship the checkout flow', { selector: '.session-title' })
    expect(children()).toHaveLength(20)
    expect(list().querySelector('#children-t-team .session-child-more')!.textContent).toBe('+5 earlier')
    const last = delegations.at(-1)!
    const lastRow = children().at(-1)!
    expect(lastRow.dataset.delegation).toBe(last.id)
    expect(lastRow.querySelector('.session-name')!.textContent).toContain(last.role)
    expect(lastRow.querySelector('.session-title')!.textContent).toBe(last.model.replace('claude-', ''))
    expect(toggle().textContent).toMatch(/25 sub-agents/)
  })

  it('keeps the oldest delegation selected and reachable while a newer one streams in, with stable focus', async () => {
    const { fleet, harness } = boot()
    await screen.findByText('Ship the checkout flow', { selector: '.session-title' })
    const oldest = delegations[0]!
    act(() => harness.store.dispatch({ type: 'select', selection: { kind: 'delegation', parent: 't-team' as ManagedId, delegationId: oldest.id } }))
    await waitFor(() => expect(children()[0]!.dataset.delegation).toBe(oldest.id))
    expect(pressed().map(r => r.dataset.delegation)).toEqual([oldest.id])
    // The parent is an ancestor of the selection, not pressed.
    const parent = rows().find(r => r.dataset.session === 't-team')!
    expect(parent.classList.contains('session-ancestor')).toBe(true)
    expect(parent.getAttribute('aria-pressed')).toBe('false')
    // The read-only detail, no composer.
    expect(await screen.findByText('Sub-agent · read only')).toBeTruthy()
    expect(document.querySelector('textarea')).toBeNull()

    children()[0]!.focus()
    const focused = document.activeElement
    const newer = { id: 'zz-new', role: 'qa', model: 'haiku', status: 'running' }
    fleet.sessions.set({ ...teams, sessions: teams.sessions.map(r => (r.managedId === 't-team' ? { ...r, delegations: [...delegations, newer] } : r)) })
    await act(() => harness.client.store.refresh(harness.client.resources.sessions))
    await waitFor(() => expect(children().at(-1)!.dataset.delegation).toBe('zz-new'))
    expect(selected()).toBe(`delegation:t-team:${oldest.id}`)
    expect(children()[0]!.dataset.delegation).toBe(oldest.id)
    expect(document.activeElement).toBe(focused)
    expect(toggle().textContent).toMatch(/26 sub-agents · 2 working/)
  })

  it('folding a group that holds the selection hands it to the parent, and the fold is remembered', async () => {
    const { harness, storage } = boot()
    await screen.findByText('Ship the checkout flow', { selector: '.session-title' })
    fireEvent.click(children()[3]!)
    await waitFor(() => expect(selected()).toMatch(/^delegation:t-team:/))
    fireEvent.click(toggle())
    await waitFor(() => expect(selected()).toBe('managed:t-team'))
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(children()).toHaveLength(0)
    expect(JSON.parse(storage.map.get('fleet:children-collapsed')!)).toEqual(['t-team'])
    expect(harness.store.preferences.get().childrenCollapsed).toEqual(['t-team'])
    // The other team's group is untouched.
    expect(list().querySelector('[data-fold-session="t-owner"]')!.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(toggle())
    expect(children()).toHaveLength(20)
  })

  it('draws a remembered fold open while it holds the selected delegation', async () => {
    const { harness } = boot(new MemoryStorage({ 'fleet:children-collapsed': '["t-team"]' }))
    await screen.findByText('Ship the checkout flow', { selector: '.session-title' })
    expect(children()).toHaveLength(0)
    act(() =>
      harness.store.dispatch({ type: 'select', selection: { kind: 'delegation', parent: 't-team' as ManagedId, delegationId: delegations[4]!.id } }),
    )
    await waitFor(() => expect(children().length).toBeGreaterThan(0))
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
  })
})
