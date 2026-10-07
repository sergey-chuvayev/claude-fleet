// A14: answering what waits on you sends exactly what the operator approved: the
// exact or edited draft, the chosen option, the information, the launch brief with
// its repository and team. A reply never approves; a failure keeps what was typed.
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import chooseFixture from '../../test/fixtures/day-full/post-day-answer-choose.json'
import conflictFixture from '../../test/fixtures/day-full/post-day-answer-choose-invalid.json'
import reportFixture from '../../test/fixtures/day-full/post-day-answer-report-done.json'
import { dayHeading } from './day'
import { type FakeDayFleet, fakeDayFleet, mountToday } from './testing'

afterEach(() => {
  vi.unstubAllGlobals()
})

const THOMAS = '00000004-f1e1-4000-8000-000000000000'
const PRICING = '00000005-f1e1-4000-8000-000000000000'
const TICKET = '00000007-f1e1-4000-8000-000000000000'
const LAUNCH = '00000008-f1e1-4000-8000-000000000000'
const REPORT = '00000009-f1e1-4000-8000-000000000000'
const DRAFT = 'Hi Thomas, yes, Friday works if QA signs off by Thursday. I will confirm tomorrow morning.'

const toast = () => document.getElementById('toast')?.textContent ?? ''
const card = (itemId: string) => document.querySelector(`[data-waiting="${itemId}"]`) as HTMLElement

async function open(fleet: FakeDayFleet = fakeDayFleet()) {
  const mounted = mountToday(fleet)
  await screen.findByRole('heading', { name: dayHeading('2026-10-06') })
  return { fleet, ...mounted }
}

describe('Waiting on you (A14)', () => {
  it('approves the exact draft as shown', async () => {
    const { fleet } = await open()
    fireEvent.click(within(card(THOMAS)).getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(toast()).toBe('Answered'))
    expect(fleet.dayActions()).toEqual([
      { op: 'answer', itemId: THOMAS, needId: '000000cc-f1e1-4000-8000-000000000000', answer: 'approve', decision: 'approve' },
    ])
  })

  it('approves an edited draft with exactly the edited text', async () => {
    const { fleet } = await open()
    const box = within(card(THOMAS)).getByLabelText('The exact text that will be sent') as HTMLTextAreaElement
    expect(box.value).toBe(DRAFT)
    const edited = `${DRAFT}\n\nThanks!  `
    fireEvent.change(box, { target: { value: edited } })
    fireEvent.click(within(card(THOMAS)).getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(fleet.dayActions()).toHaveLength(1))
    expect(fleet.dayActions()[0]).toMatchObject({ answer: edited, decision: 'edit' })
  })

  it('a reply goes to the agent as words and never approves the draft', async () => {
    const { fleet } = await open()
    const box = within(card(THOMAS)).getByLabelText('The exact text that will be sent')
    fireEvent.change(box, { target: { value: 'An edited draft that must not be sent' } })
    const reply = within(card(THOMAS)).getByLabelText('Reply to your day agent')
    fireEvent.click(within(card(THOMAS)).getByRole('button', { name: 'Reply' }))
    expect(toast()).toBe('Type a reply first.')
    fireEvent.change(reply, { target: { value: '  Not yet, ask Thomas first.  ' } })
    fireEvent.keyDown(reply, { key: 'Enter' })
    await waitFor(() => expect(toast()).toBe('Sent to your day agent'))
    expect(fleet.dayActions()).toEqual([
      { op: 'answer', itemId: THOMAS, needId: '000000cc-f1e1-4000-8000-000000000000', answer: 'Not yet, ask Thomas first.', decision: 'reply' },
    ])
  })

  it('rejects', async () => {
    const { fleet } = await open()
    fireEvent.click(within(card(THOMAS)).getByRole('button', { name: 'Reject' }))
    await waitFor(() => expect(toast()).toBe('Rejected'))
    expect(fleet.dayActions()[0]).toMatchObject({ answer: 'reject', decision: 'reject' })
  })

  it('chooses an option; an already answered question says so and refreshes the board', async () => {
    const { fleet } = await open()
    fleet.answer(() => ({ status: 409, body: conflictFixture.response.body }))
    fireEvent.click(within(card(PRICING)).getByRole('button', { name: 'staging' }))
    await waitFor(() => expect(toast()).toBe('This question is already answered. The board has been refreshed.'))
    fleet.answer(() => ({ body: chooseFixture.response.body }))
    fireEvent.click(within(card(PRICING)).getByRole('button', { name: 'staging' }))
    await waitFor(() => expect(toast()).toBe('Answered'))
    expect(fleet.dayActions().at(-1)).toEqual(chooseFixture.request.body)
    // The answer's session is the board now: the question is gone.
    await waitFor(() => expect(card(PRICING)).toBeNull())
  })

  it('gives information, and keeps it when sending fails', async () => {
    const { fleet } = await open()
    const field = within(card(TICKET)).getByLabelText('Answer: What is the ticket number for the pricing change?') as HTMLInputElement
    fireEvent.click(within(card(TICKET)).getByRole('button', { name: 'Answer' }))
    expect(toast()).toBe('Type an answer first.')
    fleet.answer(() => ({ status: 500, body: { error: 'Fleet could not save the board.', code: 'INTERNAL' } }))
    fireEvent.change(field, { target: { value: 'TECH-4410' } })
    fireEvent.click(within(card(TICKET)).getByRole('button', { name: 'Answer' }))
    await waitFor(() => expect(toast()).toBe('Fleet could not save the board.'))
    expect(field.value).toBe('TECH-4410')
    expect((within(card(TICKET)).getByRole('button', { name: 'Answer' }) as HTMLButtonElement).disabled).toBe(false)
    fleet.answer(() => ({ body: { result: {}, session: fleet.day().session } }))
    fireEvent.click(within(card(TICKET)).getByRole('button', { name: 'Answer' }))
    await waitFor(() => expect(toast()).toBe('Answered'))
    expect(fleet.dayActions().at(-1)).toMatchObject({ itemId: TICKET, answer: 'TECH-4410', decision: 'info' })
  })

  it('launches from an edited brief with the repository and team the operator chose, once', async () => {
    const { fleet } = await open()
    const launch = card(LAUNCH)
    const brief = within(launch).getByLabelText('Brief the new session starts from') as HTMLTextAreaElement
    expect(brief.value).toBe('Implement the totals cache described in TECH-110. Add tests.')
    const repo = within(launch).getByLabelText('Repository') as HTMLInputElement
    expect(repo.value).toBe('/fixture/repos/day-repo')
    const team = launch.querySelector('select[aria-label="Who"]') as HTMLSelectElement
    await waitFor(() => expect([...team.options].map(o => o.value)).toContain('bugfix'))
    expect(team.value).toBe('quick')
    fireEvent.change(brief, { target: { value: 'Implement the totals cache; keep the change small.' } })
    fireEvent.change(repo, { target: { value: '  /fixture/repos/other  ' } })
    fireEvent.change(team, { target: { value: 'bugfix' } })
    const go = within(launch).getByRole('button', { name: /Launch/ })
    fireEvent.click(go)
    fireEvent.click(go)
    await waitFor(() => expect(toast()).toBe('Launched. It is in Sessions now.'))
    expect(fleet.dayActions()).toEqual([
      {
        op: 'answer',
        itemId: LAUNCH,
        needId: '000000cf-f1e1-4000-8000-000000000000',
        answer: 'Implement the totals cache; keep the change small.',
        decision: 'edit',
        cwd: '/fixture/repos/other',
        teamId: 'bugfix',
      },
    ])
  })

  it('launches as a single agent when the team is cleared, and Not now rejects', async () => {
    const { fleet } = await open()
    const launch = card(LAUNCH)
    const team = launch.querySelector('select[aria-label="Who"]') as HTMLSelectElement
    fireEvent.change(team, { target: { value: '' } })
    fireEvent.click(within(launch).getByRole('button', { name: /Launch/ }))
    await waitFor(() => expect(fleet.dayActions()).toHaveLength(1))
    expect(fleet.dayActions()[0]).toMatchObject({ answer: 'approve', decision: 'approve', cwd: '/fixture/repos/day-repo', teamId: '' })
    fireEvent.click(within(launch).getByRole('button', { name: 'Not now' }))
    await waitFor(() => expect(fleet.dayActions()).toHaveLength(2))
    expect(fleet.dayActions()[1]).toMatchObject({ answer: 'reject', decision: 'reject' })
  })

  it("Done on an agent's report closes the item", async () => {
    const { fleet } = await open()
    const report = card(REPORT)
    expect(within(report).getByText('The agent finished and opened a pull request: Cached totals, tests green.')).toBeTruthy()
    fleet.answer(() => ({ body: reportFixture.response.body }))
    fireEvent.click(within(report).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(card(REPORT)).toBeNull())
    expect(fleet.dayActions()).toEqual([reportFixture.request.body])
    // Closed: it sits under Done now, not on today's list.
    expect(document.querySelector(`#day-board .ui-subgroup [data-card="${REPORT}"]`)).toBeNull()
  })

  it('a card ends with the session, the thread, the links and a jump to the full item', async () => {
    const { harness } = await open()
    const thomas = card(THOMAS)
    const foot = thomas.querySelector('.day-card-foot') as HTMLElement
    expect(within(foot).getByRole('link', { name: /Slack/ }).getAttribute('href')).toBe('https://example.slack.com/archives/C1/p1')
    fireEvent.click(within(foot).getByRole('button', { name: /Thread/ }))
    expect(harness.store.getState().selection.today).toEqual({ kind: 'day-thread', itemId: THOMAS })
    fireEvent.click(within(foot).getByRole('button', { name: 'Details' }))
    const row = document.querySelector(`#day-board li[data-card="${THOMAS}"]`) as HTMLElement
    await waitFor(() => expect(row.querySelector('details')?.open).toBe(true))
    expect(row.classList.contains('is-flash')).toBe(true)
  })
})
