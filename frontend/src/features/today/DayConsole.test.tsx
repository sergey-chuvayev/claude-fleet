// A15: the Day's console. Item threads and scout runs are tabs above it; a selected
// earlier run stays selected when a newer run of the same scout streams in; a thread
// shown belongs to this Day and this item; a subagent view has no composer. Board
// tool calls read as one grouped event.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { keys } from '../../transport/resources'
import { dayHeading } from './day'
import { type Json, copy, fakeDayFleet, mountToday } from './testing'

afterEach(() => {
  vi.unstubAllGlobals()
})

const THOMAS = '00000004-f1e1-4000-8000-000000000000'
const strip = () => screen.getByRole('navigation', { name: 'Day agent, item threads and subagents' })
const tab = (name: RegExp | string) => within(strip()).getByRole('button', { name })
const composer = () => document.querySelector('.day-console #composer textarea') as HTMLTextAreaElement | null

async function open(fleet = fakeDayFleet()) {
  const mounted = mountToday(fleet)
  await screen.findByRole('heading', { name: dayHeading('2026-10-06') })
  await screen.findByText('Here is your day. Five things need you.')
  return { fleet, ...mounted }
}

describe('The Day console (A15)', () => {
  it('shows the Day agent with its composer, and tabs for the open thread and each scout', async () => {
    await open()
    expect(screen.getByRole('heading', { name: 'Day agent' })).toBeTruthy()
    expect(composer()?.placeholder).toBe('Ask your day agent…')
    const names = within(strip()).getAllByRole('button').map(b => b.textContent)
    expect(names).toEqual(['Day agent', 'Reply to Thomas about the m…', 'Slack2', 'Linear2', 'GitHub2', 'Granola2', 'Calendar2'])
    expect(tab('Day agent').getAttribute('aria-pressed')).toBe('true')
  })

  it('opens an item thread from its tab: the thread of this Day and item, with its own composer', async () => {
    const { harness } = await open()
    fireEvent.click(tab(/Reply to Thomas/))
    expect(harness.store.getState().selection.today).toEqual({ kind: 'day-thread', itemId: THOMAS })
    expect(await screen.findByText('He asked whether the migration can ship on Friday.')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'About: Reply to Thomas' })).toBeTruthy()
    expect(document.getElementById('control-panel')?.dataset.session).toBe('thr-today')
    expect(composer()?.placeholder).toBe('Ask about this item…')
    expect(tab(/Reply to Thomas/).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(tab('Day agent'))
    expect(harness.store.getState().selection.today).toBeNull()
  })

  it('drops a thread selection that is not an open thread of this Day', async () => {
    const fleet = fakeDayFleet()
    const snapshot: Json = copy(fleet.snapshot)
    // The list says this thread now belongs to another Day.
    snapshot.sessions.find((s: Json) => s.managedId === 'thr-today').parentDayId = 'day-yesterday'
    fleet.setSessions(snapshot)
    const { harness } = await open(fleet)
    act(() => harness.store.dispatch({ type: 'select', selection: { kind: 'day-thread', itemId: THOMAS as never } }))
    await waitFor(() => expect(harness.store.getState().selection.today).toBeNull())
    expect(screen.getByRole('heading', { name: 'Day agent' })).toBeTruthy()
  })

  it('an item sent from another view without a thread is shown on the board, opened', async () => {
    const { fleet, harness } = await open()
    const item: string = fleet.day().session.dayBoard.items.find((i: Json) => i.status === 'today' && !i.thread).id
    act(() => harness.store.dispatch({ type: 'select', selection: { kind: 'day-thread', itemId: item as never }, reveal: true }))
    const row = document.querySelector(`#day-board li[data-card="${item}"]`) as HTMLElement
    await waitFor(() => expect(row.querySelector('details')?.open).toBe(true))
    expect(row.classList.contains('is-flash')).toBe(true)
    await waitFor(() => expect(harness.store.getState().selection.today).toBeNull())
    expect(screen.getByRole('heading', { name: 'Day agent' })).toBeTruthy()
  })

  it('a scout tab shows its latest run read-only; an earlier run picked stays picked when a newer run arrives', async () => {
    const { fleet, harness } = await open()
    fireEvent.click(tab(/Slack/))
    const view = await screen.findByRole('region', { name: 'slack-scout run' })
    expect(composer()).toBeNull()
    const runs = within(view).getAllByRole('button')
    expect(runs).toHaveLength(2)
    expect(runs[0]?.getAttribute('aria-current')).toBe('true')
    expect(within(view).getByText('slack: 1 new items found.', { selector: '.response' })).toBeTruthy()

    fireEvent.click(runs[1] as HTMLElement)
    expect(within(view).getAllByRole('button')[1]?.getAttribute('aria-current')).toBe('true')
    const older = (runs[1] as HTMLElement).dataset.agent

    // A new Slack run starts and streams in.
    const day: Json = copy(fleet.day())
    day.session.subagents.push({
      id: 'scout-slack-2',
      itemId: null,
      role: 'slack-scout',
      description: 'Scan Slack',
      prompt: 'Scan Slack again.',
      status: 'running',
      startedAt: day.session.subagents[0].startedAt + 3_600_000,
      finishedAt: null,
      output: 'Reading #general',
      report: '',
      steps: [],
    })
    fleet.setDay(day)
    act(() => harness.client.store.invalidate(keys.managed('day-today')))
    await waitFor(() => expect(tab(/Slack/).dataset.agent).toBe('scout-slack-2'))
    const after = screen.getByRole('region', { name: 'slack-scout run' })
    const current = within(after).getAllByRole('button').find(b => b.getAttribute('aria-current') === 'true')
    expect(current?.dataset.agent).toBe(older)
    expect(within(after).getAllByRole('button')).toHaveLength(3)
    expect(tab(/Slack/).getAttribute('aria-pressed')).toBe('true')
    expect(within(strip()).getByText('1 running')).toBeTruthy()
    expect(composer()).toBeNull()
  })

  it('a scout tab picked while a thread is open hands the console back to the Day', async () => {
    const { harness } = await open()
    fireEvent.click(tab(/Reply to Thomas/))
    await screen.findByText('He asked whether the migration can ship on Friday.')
    fireEvent.click(tab(/Linear/))
    expect(harness.store.getState().selection.today).toBeNull()
    expect(await screen.findByRole('region', { name: 'linear-scout run' })).toBeTruthy()
  })

  it('asks about an item from the board: one thread request, then the thread opens', async () => {
    const { fleet, harness } = await open()
    const day: Json = copy(fleet.day())
    const item: string = day.session.dayBoard.items.find((i: Json) => i.status === 'today' && !i.thread).id
    fleet.answer(post => {
      const answered: Json = copy(day)
      answered.session.dayBoard.items.find((i: Json) => i.id === item).thread = { sessionId: 'thr-new', at: 1 }
      fleet.setManaged('thr-new', { session: { id: 'thr-new', status: 'idle', kind: 'thread', name: 'New', messages: [] } })
      return { body: { result: { threadId: 'thr-new' }, session: answered.session, path: post.path } }
    })
    const row = document.querySelector(`#day-board li[data-card="${item}"]`) as HTMLElement
    fireEvent.click(row.querySelector('summary') as HTMLElement)
    const ask = await within(row).findByLabelText(/^Ask about /)
    fireEvent.change(ask, { target: { value: 'What is this about?' } })
    fireEvent.keyDown(ask, { key: 'Enter' })
    await waitFor(() => expect(harness.store.getState().selection.today).toEqual({ kind: 'day-thread', itemId: item }))
    expect(fleet.dayActions()).toEqual([{ op: 'thread', itemId: item, message: 'What is this about?', requestId: expect.any(String) }])
    await waitFor(() => expect(document.getElementById('control-panel')?.dataset.session).toBe('thr-new'))
  })

  it('sends a message to the Day agent with a request id, and clears the box', async () => {
    const { fleet } = await open()
    fleet.answer(post => ({ body: { session: { id: 'day-today' }, path: post.path } }))
    const box = composer() as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'What is left?' } })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(fleet.posted).toHaveLength(0)
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(fleet.posted).toHaveLength(1))
    expect(fleet.posted[0]).toEqual({ path: '/api/managed/day-today/messages', body: { message: 'What is left?', requestId: expect.any(String) } })
    await waitFor(() => expect(box.value).toBe(''))
  })

  it('groups the board tool calls into one readable event', async () => {
    const fleet = fakeDayFleet()
    const day: Json = copy(fleet.day())
    day.session.messages.push(
      { id: 'b1', role: 'tool', tool: 'mcp__fleet__day', input: { action: 'list' }, status: 'done', ms: 10, at: day.session.messages[1].at + 1 },
      { id: 'b2', role: 'tool', tool: 'mcp__fleet__day', input: { action: 'add', title: 'Reply to Marc' }, status: 'done', ms: 10, at: day.session.messages[1].at + 2 },
    )
    fleet.setDay(day)
    await open(fleet)
    const block = await waitFor(() => {
      const el = document.querySelector('[data-block="b1~board"]')
      if (!el) throw new Error('no grouped block')
      return el as HTMLElement
    })
    expect(block.querySelector('.block-tool')?.textContent).toBe('Board')
    expect(block.querySelector('.block-target')?.textContent).toBe('read the board · added 1')
    expect(document.querySelector('[data-block="b2"]')).toBeNull()
  })
})
