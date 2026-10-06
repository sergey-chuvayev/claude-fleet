// The Day console's session controls, as the legacy console drew them for a Day: the
// model picker, Close and tool approvals from features/session-header and
// features/approvals, Stop or Cancel queued task, queued follow-ups, and the full
// composer (features/composer: images, @ references, / commands) that keeps its
// request id for a retry.
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deferred } from '../../test/fakes'
import { keys } from '../../transport/resources'
import { dayHeading } from './day'
import { type Json, copy, fakeDayFleet, mountToday } from './testing'

afterEach(() => {
  vi.unstubAllGlobals()
})

const composer = () => document.querySelector('.day-console #composer textarea') as HTMLTextAreaElement
const MESSAGES = '/api/managed/day-today/messages'

async function open(fleet = fakeDayFleet()) {
  const mounted = mountToday(fleet)
  await screen.findByRole('heading', { name: dayHeading('2026-10-06') })
  await screen.findByText('Here is your day. Five things need you.')
  return { fleet, ...mounted }
}

describe('The Day console controls', () => {
  it('has the model picker, the outward-gate note, Connections and Close', async () => {
    await open()
    await waitFor(() => expect(document.getElementById('model-choice')).toBeTruthy())
    expect(screen.getByText('Sends need your approval')).toBeTruthy()
    expect(document.getElementById('agent-connections')).toBeTruthy()
    expect(document.getElementById('close-agent')?.textContent).toBe('Close')
    // No approval-mode picker: the Day's outward gate decides.
    expect(document.getElementById('approval-mode')).toBeNull()
  })

  it("shows the Day's tool approvals and Stop while it works", async () => {
    const { fleet, harness } = await open()
    expect(document.getElementById('stop-agent')).toBeNull()
    const day: Json = copy(fleet.day())
    day.session.status = 'approval'
    day.session.approvals = [{ id: 'ap-9', tool: 'Bash', description: 'Run the migration check', input: { command: 'npm run check' } }]
    fleet.setDay(day)
    await act(async () => harness.client.store.invalidate(keys.managed('day-today')))
    expect(await screen.findByText('Run the migration check')).toBeTruthy()
    expect(document.querySelector('#approvals [data-approval="ap-9"]')).toBeTruthy()
    expect(document.getElementById('stop-agent')).toBeTruthy()
  })

  it('keeps the draft and its request id after a failed send, and clears it once sent', async () => {
    const { fleet } = await open()
    fleet.answer(post => (post.path === MESSAGES ? { status: 503, body: { error: 'Fleet is busy.' } } : { body: {} }))
    fireEvent.change(composer(), { target: { value: 'What is left today?' } })
    fireEvent.keyDown(composer(), { key: 'Enter' })
    expect(await screen.findByText('Fleet is busy.')).toBeTruthy()
    expect(composer().value).toBe('What is left today?')
    const sends = () => fleet.posted.filter(p => p.path === MESSAGES)
    const first = sends()[0]!.body

    const answer = deferred<{ body: unknown }>()
    fleet.answer(() => answer.promise)
    fireEvent.keyDown(composer(), { key: 'Enter' })
    await waitFor(() => expect(sends()).toHaveLength(2))
    expect(sends()[1]!.body).toEqual(first)
    expect(first).toMatchObject({ message: 'What is left today?' })
    await act(async () => answer.resolve({ body: { session: fleet.day().session } }))
    await waitFor(() => expect(composer().value).toBe(''))
  })

  it('is the full composer for the Day and for a thread, with queued follow-ups and Cancel queued task', async () => {
    const { fleet, harness } = await open()
    // The full composer: the combobox text box with its pickers and trays.
    expect(composer().id).toBe('message-input')
    expect(composer().getAttribute('role')).toBe('combobox')
    expect(document.getElementById('slash-picker')).toBeTruthy()
    expect(document.getElementById('attach-tray')).toBeTruthy()
    expect(document.getElementById('reference-tray')).toBeTruthy()

    const day: Json = copy(fleet.day())
    day.session.status = 'queued'
    day.session.queue = [{ id: 'q1', message: 'Then check the calendar' }]
    fleet.setDay(day)
    await act(async () => harness.client.store.invalidate(keys.managed('day-today')))
    expect(await screen.findByText('Then check the calendar')).toBeTruthy()
    expect(document.getElementById('stop-agent')?.textContent).toBe('Cancel queued task')

    // An item thread gets the same composer, keyed by its own session.
    fireEvent.click(screen.getByRole('button', { name: /Reply to Thomas/ }))
    await waitFor(() => expect(document.getElementById('control-panel')?.dataset.session).toBe('thr-today'))
    await waitFor(() => expect(composer()?.placeholder).toBe('Ask about this item…'))
    expect(composer().id).toBe('message-input')
  })

  it('has the composer height divider, on the preference the Sessions console uses', async () => {
    const { harness } = await open()
    const divider = await screen.findByRole('separator', { name: 'Resize message composer' })
    expect(divider.nextElementSibling?.id).toBe('composer')
    fireEvent.keyDown(divider, { key: 'Home' })
    expect(harness.storage.getItem('fleet:minimal-composer-height')).toBe('110')
    expect((document.getElementById('composer') as HTMLElement).style.minHeight).toBe('110px')
  })
})
