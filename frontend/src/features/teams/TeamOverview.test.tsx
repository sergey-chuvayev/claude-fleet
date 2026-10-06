// A11, the overview part (F15): the initiative board over the conversation. The roster
// shows configured models and who is active, a handoff shows the model its delegation
// actually reported, disclosures start collapsed and stay as the operator left them
// through a refresh (same DOM nodes), owner + review shows its evidence, and there are
// no money controls anywhere.
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ManagedId } from '../../domain/ids'
import teamFile from '../../test/fixtures/teams-heavy/managed/t-team.json'
import ownerFile from '../../test/fixtures/teams-heavy/managed/t-owner.json'
import type { DetailBody } from '../conversation/testing'
import { SessionDetail } from '../inspector/SessionDetail'
import { type ConsoleFleet, consoleFleet, detailOf, mountConsole, refreshManaged } from '../session-header/testing'

const managed = (id: string) => ({ kind: 'managed', managedId: id as ManagedId }) as const
const board = () => document.getElementById('initiative-board') as HTMLDetailsElement
const RUNNING = '000000d1-0000-4000-8000-000000000025'
const TASK_1 = '0000007a-0000-4000-8000-000000000001'

interface Board {
  tasks: Array<Record<string, unknown>>
  delegations: Array<Record<string, unknown>>
}
function withBoard(detail: DetailBody, change: (board: Board) => Board): DetailBody {
  return { ...detail, session: { ...detail.session, taskBoard: change(structuredClone(detail.session.taskBoard as Board)) } }
}

let fleet: ConsoleFleet
beforeEach(() => {
  fleet = consoleFleet()
  fleet.update('t-team', detailOf(teamFile))
  fleet.update('t-owner', detailOf(ownerFile))
})

describe('TeamOverview (A11, F15)', () => {
  it('summarises the team: verified count, roster with configured models, the active role', async () => {
    mountConsole(fleet, <SessionDetail />, managed('t-team'))
    await waitFor(() => expect(board()).toBeTruthy())
    const summary = board().querySelector('summary')!
    expect(summary.textContent).toBe('Bug fix2/6 verified')
    const roster = within(screen.getByLabelText('Team and active agent'))
    const roles = [...document.querySelectorAll('.initiative-role')].map(el => el.textContent)
    expect(roles).toEqual(['manageropus · your contact', 'developersonnet · working', 'qahaiku'])
    expect(document.querySelector('.initiative-role.is-active strong')?.textContent).toBe('developer')
    expect(roster.getAllByText('·', { selector: '.team-connector' })).toHaveLength(2)
    expect((screen.getByRole('combobox', { name: 'Message this agent' }) as HTMLTextAreaElement).placeholder).toBe('Message manager…')
  })

  it('draws each task with its state, attempt, blocker and dependencies', async () => {
    mountConsole(fleet, <SessionDetail />, managed('t-team'))
    await waitFor(() => expect(board()).toBeTruthy())
    const tasks = [...document.querySelectorAll('.initiative-tasks > li > details > summary')].map(s => s.textContent)
    expect(tasks[0]).toBe('verifiedTask 1: Add the endpointdeveloper · attempt 1')
    expect(tasks[3]).toBe('changes requestedTask 4: Write the docsdeveloper · attempt 2')
    expect(document.querySelectorAll('.initiative-tasks > li')).toHaveLength(6)
    expect(screen.getByText('Delegation failed. Read the report before retrying.').className).toBe('form-error')
    expect(screen.getAllByText('After: Task 1: Add the endpoint')).toHaveLength(1)
    expect(screen.getByText(/Verified means all configured verifiers returned passing reports/)).toBeTruthy()
  })

  it('a handoff shows the model its delegation reported, else the role’s model', async () => {
    fleet.update(
      't-team',
      withBoard(detailOf(teamFile), b => ({ ...b, delegations: b.delegations.map(d => (d.id === RUNNING ? { ...d, model: 'claude-sonnet-reported' } : d)) })),
    )
    mountConsole(fleet, <SessionDetail />, managed('t-team'))
    await waitFor(() => expect(board()).toBeTruthy())
    const running = document.querySelector(`[data-evidence="${RUNNING}"] > summary`)!
    expect(running.textContent).toBe('manager → developer running · Edit src/form.tsclaude-sonnet-reported')
    const finished = document.querySelector('[data-evidence="000000d1-0000-4000-8000-000000000002"] > summary')!
    expect(finished.textContent).toBe('manager → qa completedhaiku')
  })

  it('disclosures start collapsed and stay open, on the same nodes, through a refresh', async () => {
    const user = userEvent.setup()
    const mounted = mountConsole(fleet, <SessionDetail />, managed('t-team'))
    await waitFor(() => expect(board()).toBeTruthy())
    const task = document.querySelector<HTMLDetailsElement>(`details[data-evidence="${TASK_1}"]`)!
    expect(task.open).toBe(false)
    await user.click(task.querySelector('summary')!)
    const handoff = document.querySelector<HTMLDetailsElement>(`details[data-evidence="${RUNNING}"]`)!
    await user.click(handoff.querySelector('summary')!)
    const mandate = document.querySelector<HTMLDetailsElement>(`details[data-evidence="${RUNNING}-mandate"]`)!
    const report = document.querySelector<HTMLDetailsElement>(`details[data-evidence="${RUNNING}-report"]`)!
    expect(mandate.open).toBe(false)
    expect(report.open).toBe(false)
    await user.click(mandate.querySelector('summary')!)
    const body = board().querySelector<HTMLElement>('.initiative-body')!
    body.scrollTop = 140

    fleet.update(
      't-team',
      withBoard(fleet.held('t-team')!, b => ({ ...b, delegations: b.delegations.map(d => (d.id === RUNNING ? { ...d, activity: 'Bash npm test' } : d)) })),
    )
    await refreshManaged(mounted, 't-team')
    await waitFor(() => expect(document.querySelector(`[data-evidence="${RUNNING}"] > summary`)?.textContent).toContain('Bash npm test'))
    expect(document.querySelector(`details[data-evidence="${TASK_1}"]`)).toBe(task)
    expect(task.open).toBe(true)
    expect(handoff.open).toBe(true)
    expect(mandate.open).toBe(true)
    expect(report.open).toBe(false)
    expect(board().querySelector('.initiative-body')).toBe(body)
    expect(body.scrollTop).toBe(140)
  })

  it('has no money controls, only attempt-count evidence', async () => {
    mountConsole(fleet, <SessionDetail />, managed('t-team'))
    await waitFor(() => expect(board()).toBeTruthy())
    const text = board().textContent ?? ''
    expect(text).not.toMatch(/Adjust limits|Usage cap|budget|\$\d/i)
    expect(board().querySelector('input')).toBeNull()
  })

  it('owner + review shows the reviewed commit, the implementation count and when a review goes stale', async () => {
    mountConsole(fleet, <SessionDetail />, managed('t-owner'))
    await waitFor(() => expect(board()).toBeTruthy())
    expect(board().querySelector('summary')?.textContent).toBe('Owner + review1/1 verified')
    expect(document.querySelector('.initiative-tasks summary')?.textContent).toBe('verifiedImplement the requestowner · reviewed implementation 2')
    expect(screen.getByText('Review commit: 876361053ae1 · 2/3 implementations submitted · 0/2 review execution errors')).toBeTruthy()
    expect(screen.getByText(/Later code changes make that review stale/)).toBeTruthy()
    expect((screen.getByRole('combobox', { name: 'Message this agent' }) as HTMLTextAreaElement).placeholder).toBe('Message owner…')
  })

  it('the overview has its own divider, gone while the overview is folded', async () => {
    const user = userEvent.setup()
    mountConsole(fleet, <SessionDetail />, managed('t-team'))
    await waitFor(() => expect(board()).toBeTruthy())
    expect(screen.getByRole('separator', { name: 'Resize team overview' })).toBeTruthy()
    expect(screen.getByRole('separator', { name: 'Resize message composer' })).toBeTruthy()
    await user.click(board().querySelector('summary')!)
    await act(async () => {})
    expect(board().open).toBe(false)
    expect(screen.queryByRole('separator', { name: 'Resize team overview' })).toBeNull()
  })

  it('a session without a team has no overview', async () => {
    fleet.update('plain', { ...detailOf(teamFile), session: { ...detailOf(teamFile).session, id: 'plain', teamSnapshot: null, taskBoard: null, kind: 'agent' } })
    mountConsole(fleet, <SessionDetail />, managed('plain'))
    await screen.findByRole('combobox', { name: 'Message this agent' })
    expect(board()).toBeNull()
    expect(screen.queryByRole('separator', { name: 'Resize team overview' })).toBeNull()
  })
})
