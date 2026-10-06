// A12 and A13: starting the Day (one per local date, carry-over shown, failures kept)
// and working the board (add, triage, Take all Must, Later, Done and its constraint),
// against the day-full fixture pack through the real transport.
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import duplicateFixture from '../../test/fixtures/day-full/post-day-create-duplicate.json'
import limitFixture from '../../test/fixtures/day-full/post-day-add-limit.json'
import { dayHeading } from './day'
import { type Json, T0, copy, fakeDayFleet, mountToday } from './testing'

/** 'Tuesday 6 October' in en-GB; the heading follows the machine's locale. */
const HEADING = dayHeading('2026-10-06')

afterEach(() => {
  vi.unstubAllGlobals()
})

const MISSING_ITEM = { error: 'Item not found. Read the Day board.', code: 'NOT_FOUND' }

/** The list with no Day for today: yesterday's Day only. */
function withoutToday(fleet: ReturnType<typeof fakeDayFleet>) {
  const snapshot: Json = copy(fleet.snapshot)
  snapshot.sessions = snapshot.sessions.filter((s: Json) => s.managedId !== 'day-today')
  fleet.setSessions(snapshot)
  return snapshot
}

const board = () => document.getElementById('day-board') as HTMLElement
const toast = () => document.getElementById('toast')?.textContent ?? ''

describe('Today: starting the Day (A12)', () => {
  it('offers to start the day, promising carry-over, and starts exactly one Day', async () => {
    const fleet = fakeDayFleet()
    const snapshot = withoutToday(fleet)
    const gate: { release: (() => void) | null } = { release: null }
    fleet.answer(post => new Promise(resolve => {
      gate.release = () => resolve({ status: 201, body: { session: { id: 'day-today' }, path: post.path } })
    }))
    mountToday(fleet)

    expect(await screen.findByRole('heading', { name: 'Good morning.' })).toBeTruthy()
    expect(screen.getByText('Unfinished items from your last Day carry over, with their open questions.')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Anything to add before it starts'), { target: { value: '  Focus on the release.  ' } })
    const start = screen.getByRole('button', { name: /Start my day/ })
    fireEvent.click(start)
    fireEvent.click(start)
    await waitFor(() => expect(fleet.posted).toHaveLength(1))
    const sent = fleet.posted[0]
    expect(sent?.path).toBe('/api/managed')
    expect(sent?.body).toMatchObject({ kind: 'day', prompt: 'Focus on the release.' })
    expect(typeof sent?.body.requestId).toBe('string')

    // The Day appears once the list says so.
    fleet.setSessions({ ...snapshot, sessions: [...fleet.snapshot.sessions] })
    gate.release?.()
    await waitFor(() => expect(toast()).toBe('Good morning. Gathering your day.'))
    expect(await screen.findByRole('heading', { name: HEADING })).toBeTruthy()
  })

  it('a second start on the same date is refused, keeps the note and shows the Day that exists', async () => {
    const fleet = fakeDayFleet()
    const snapshot = withoutToday(fleet)
    fleet.answer(() => {
      // Another window started it: the server already has today's Day.
      fleet.setSessions({ ...snapshot, sessions: [...fleet.snapshot.sessions] })
      return { status: 409, body: duplicateFixture.response.body }
    })
    mountToday(fleet)
    fireEvent.change(await screen.findByLabelText('Anything to add before it starts'), { target: { value: 'Note' } })
    fireEvent.click(screen.getByRole('button', { name: /Start my day/ }))
    await waitFor(() => expect(toast()).toBe('Today already has a Day. Open it from the list. The board has been refreshed.'))
    expect(await screen.findByRole('heading', { name: HEADING })).toBeTruthy()
    expect(fleet.posted).toHaveLength(1)
  })

  it('finds today by the local date: a Day for another date is not today', async () => {
    const fleet = fakeDayFleet()
    // The next local day: today's fixture Day is yesterday's now.
    mountToday(fleet, { now: T0 + 86_400_000 })
    expect(await screen.findByRole('heading', { name: 'Good morning.' })).toBeTruthy()
  })

  it('shows carried items with the day they came from, and an earlier thread', async () => {
    const fleet = fakeDayFleet()
    mountToday(fleet)
    const card = await waitFor(() => {
      const el = board()?.querySelector('[data-waiting="00000004-f1e1-4000-8000-000000000000"]')
      if (!el) throw new Error('no card yet')
      return el as HTMLElement
    })
    expect(within(card).getByText('from Mon').getAttribute('title')).toBe('Carried over from 2026-10-05')
    expect(card.querySelector('.day-source')?.textContent).toBe('Slack')
  })
})

describe('Today: the board (A13)', () => {
  it('draws the page head, the waiting cards and the sections from the fixture', async () => {
    const fleet = fakeDayFleet()
    mountToday(fleet)
    expect(await screen.findByRole('heading', { name: HEADING })).toBeTruthy()
    const head = board().querySelector('.page-head') as HTMLElement
    expect(within(head).getByText('5 waiting on you')).toBeTruthy()
    expect(within(head).getByRole('button', { name: /Check now/ })).toBeTruthy()
    expect(within(head).getByText(/^Checked /)).toBeTruthy()
    expect(within(head).getByText('Plan limits')).toBeTruthy()
    const labels = [...board().querySelectorAll('.ui-label')].map(el => el.firstChild?.textContent)
    expect(labels).toEqual(['Waiting on you', 'To triage', 'Today'])
    // Capacity: today's estimates against the free time the calendar left.
    expect(board().querySelector('.day-capacity')?.textContent).toMatch(/planned · 3h 10m free/)
  })

  it('adds an item with title, context and the links in it; a failure keeps what was typed', async () => {
    const fleet = fakeDayFleet()
    mountToday(fleet)
    await screen.findByRole('heading', { name: HEADING })
    fireEvent.click(screen.getByRole('button', { name: /Add to today/ }))
    expect(toast()).toBe('Give it a title.')
    expect(fleet.dayActions()).toHaveLength(0)

    fleet.answer(() => ({ status: 409, body: limitFixture.response.body }))
    fireEvent.change(screen.getByLabelText('What needs doing?'), { target: { value: 'Call the accountant' } })
    fireEvent.change(screen.getByLabelText('Context'), { target: { value: 'About https://example.com/ledger please' } })
    fireEvent.click(screen.getByRole('button', { name: /Add to today/ }))
    await waitFor(() => expect(toast()).toBe('The Day board has reached its 200-item limit. Finish or drop something, then try again.'))
    expect((screen.getByLabelText('What needs doing?') as HTMLInputElement).value).toBe('Call the accountant')

    fleet.answer(() => ({ body: { result: {}, session: fleet.day().session } }))
    fireEvent.click(screen.getByRole('button', { name: /Add to today/ }))
    await waitFor(() => expect(toast()).toBe('Added to today'))
    expect(fleet.dayActions().at(-1)).toEqual({
      op: 'add',
      item: { title: 'Call the accountant', source: 'me', context: 'About https://example.com/ledger please', links: ['https://example.com/ledger'], priority: 'should', mode: 'me' },
    })
    expect((screen.getByLabelText('What needs doing?') as HTMLInputElement).value).toBe('')
  })

  it('triages a proposal with its chosen priority and mode', async () => {
    const fleet = fakeDayFleet()
    mountToday(fleet)
    await screen.findByRole('heading', { name: HEADING })
    const proposed = fleet.day().session.dayBoard.items.find((i: Json) => i.status === 'proposed' && i.priority === 'should')
    const card = board().querySelector(`[data-card="${proposed.id}"]`) as HTMLElement
    fireEvent.change(card.querySelector('select[aria-label="Priority"]') as HTMLSelectElement, { target: { value: 'must' } })
    fireEvent.change(card.querySelector('select[aria-label="How"]') as HTMLSelectElement, { target: { value: 'agent' } })
    fireEvent.click(within(card).getByRole('button', { name: 'Later' }))
    await waitFor(() => expect(fleet.dayActions()).toHaveLength(1))
    expect(fleet.dayActions()[0]).toEqual({ op: 'triage', itemId: proposed.id, status: 'later', priority: 'must', mode: 'agent' })
  })

  it('Take all Must moves every Must proposal, and says so honestly when some fail', async () => {
    const fleet = fakeDayFleet()
    mountToday(fleet)
    await screen.findByRole('heading', { name: HEADING })
    const must = fleet.day().session.dayBoard.items.filter((i: Json) => i.status === 'proposed' && i.priority === 'must')
    expect(must.length).toBeGreaterThan(2)
    const failing = must[1].id
    fleet.answer(post => (post.body.itemId === failing ? { status: 404, body: MISSING_ITEM } : { body: { result: {}, session: fleet.day().session } }))
    fireEvent.click(screen.getByRole('button', { name: 'Take all Must' }))
    await waitFor(() => expect(toast()).toMatch(/could not move/))
    expect(toast()).toBe(`${must.length - 1} of ${must.length} on today. 1 could not move: Item not found. The board has been refreshed.`)
    expect(fleet.dayActions().map(a => a.itemId).sort()).toEqual(must.map((i: Json) => i.id).sort())
    expect(fleet.dayActions().every(a => a.op === 'triage' && a.status === 'today')).toBe(true)

    fleet.answer(() => ({ body: { result: {}, session: fleet.day().session } }))
    fireEvent.click(screen.getByRole('button', { name: 'Take all Must' }))
    await waitFor(() => expect(toast()).toBe(`${must.length} on today`))
  })

  it('opens a today row to its details; Done waits for its questions, and Later and the mode go at once', async () => {
    const fleet = fakeDayFleet()
    mountToday(fleet)
    await screen.findByRole('heading', { name: HEADING })
    const items: Json[] = fleet.day().session.dayBoard.items
    const waiting = items.find(i => i.id === '00000007-f1e1-4000-8000-000000000000')
    const row = board().querySelector(`li[data-card="${waiting.id}"]`) as HTMLElement
    fireEvent.click(row.querySelector('summary') as HTMLElement)
    const done = await within(row).findByRole('button', { name: 'Done' })
    expect((done as HTMLButtonElement).disabled).toBe(true)
    expect(done.getAttribute('title')).toBe('Answer its questions first')
    // Long context with a heading folds under a title; the log shows its latest lines.
    expect(within(row).getByText('Context')).toBeTruthy()
    expect(row.querySelector('.ui-log li')?.textContent).toMatch(/Scout noted: item 0 changed\.$/)
    expect(row.querySelector('.ui-row-latest')?.textContent).toBe('Scout noted: item 0 changed.')

    const free = items.find(i => i.status === 'today' && !i.needs.some((n: Json) => n.answer === undefined))
    const freeRow = board().querySelector(`li[data-card="${free.id}"]`) as HTMLElement
    fireEvent.click(freeRow.querySelector('summary') as HTMLElement)
    const freeDone = await within(freeRow).findByRole('button', { name: 'Done' })
    expect((freeDone as HTMLButtonElement).disabled).toBe(false)
    fireEvent.change(freeRow.querySelector('select[aria-label="How"]') as HTMLSelectElement, { target: { value: 'ask' } })
    await waitFor(() => expect(toast()).toBe('Updated'))
    fireEvent.click(freeDone)
    await waitFor(() => expect(fleet.dayActions()).toHaveLength(2))
    expect(fleet.dayActions()).toEqual([
      { op: 'triage', itemId: free.id, mode: 'ask' },
      { op: 'triage', itemId: free.id, status: 'done' },
    ])
  })

  it('a refused Done (an approval still open on the server) says why', async () => {
    const fleet = fakeDayFleet()
    mountToday(fleet)
    await screen.findByRole('heading', { name: HEADING })
    const free = fleet.day().session.dayBoard.items.find((i: Json) => i.status === 'today' && !i.needs.length)
    fleet.answer(() => ({ status: 409, body: { error: 'This item has an unanswered approval. It cannot be done before the operator decides.', code: 'CONFLICT' } }))
    const row = board().querySelector(`li[data-card="${free.id}"]`) as HTMLElement
    fireEvent.click(row.querySelector('summary') as HTMLElement)
    fireEvent.click(await within(row).findByRole('button', { name: 'Done' }))
    await waitFor(() => expect(toast()).toBe('This item has an unanswered approval. It cannot be done before the operator decides. The board has been refreshed.'))
  })

  it('the launched session chip opens it in Sessions, titled with its name and state', async () => {
    const fleet = fakeDayFleet()
    const { harness } = mountToday(fleet)
    await screen.findByRole('heading', { name: HEADING })
    const card = board().querySelector('[data-waiting="00000008-f1e1-4000-8000-000000000000"]') as HTMLElement
    const chip = within(card).getByRole('button', { name: /Totals cache · ready/ })
    expect(chip.getAttribute('title')).toBe('Open in Sessions: Totals cache')
    fireEvent.click(chip)
    expect(harness.store.getState().view).toBe('sessions')
    expect(harness.store.getState().selection.sessions).toEqual({ kind: 'managed', managedId: 'm-launched' })
  })

  it('Check now asks for a sweep', async () => {
    const fleet = fakeDayFleet()
    mountToday(fleet)
    fireEvent.click(await screen.findByRole('button', { name: /Check now/ }))
    await waitFor(() => expect(toast()).toBe('Checking your sources'))
    expect(fleet.dayActions()).toEqual([{ op: 'sweep' }])
  })
})
