// The read-only delegation detail against teams-heavy (F05): mandate, steps (200 on
// the oldest), report, model and duration from the parent's task board; no composer;
// an approval on the parent is pointed back to its row; an opened step stays open.
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ManagedId } from '../../domain/ids'
import teamControl from '../../test/fixtures/teams-heavy/get-control.json'
import teamSessions from '../../test/fixtures/teams-heavy/get-sessions.json'
import teamDetail from '../../test/fixtures/teams-heavy/managed/t-team.json'
import { bodyOf, fakeFleet, mount } from '../sessions/testing'
import { DelegationDetail } from './DelegationDetail'

type Body = { sessions: Array<Record<string, unknown>> }
const teams = bodyOf<Body>(teamSessions)
const detail = bodyOf<{ session: { taskBoard: { delegations: Array<Record<string, unknown>> } } }>(teamDetail)
const delegations = detail.session.taskBoard.delegations

function boot(delegationId: string, sessions: Body = teams) {
  const fleet = fakeFleet({ control: teamControl.response.body, sessions, managed: { 't-team': detail } })
  const view = mount(fleet, <DelegationDetail selection={{ kind: 'delegation', parent: 't-team' as ManagedId, delegationId }} />)
  return { fleet, ...view }
}

describe('DelegationDetail', () => {
  it('shows the mandate, the steps and the report, read only', async () => {
    const second = delegations[1]!
    boot(second.id as string)
    await waitFor(() => expect([...document.querySelectorAll('.response')].map(el => el.textContent)).toEqual([second.prompt, second.report]))
    expect(screen.getByText('Sub-agent · read only')).toBeTruthy()
    expect(document.querySelectorAll('.child-step')).toHaveLength((second.steps as unknown[]).length)
    expect(screen.getByText('Done', { selector: '.badge' })).toBeTruthy()
    expect(screen.getByText('2m 00s')).toBeTruthy()
    expect(document.querySelector('textarea, input')).toBeNull()
  })

  it('draws 200 steps and keeps an opened one open through a refresh', async () => {
    const { harness } = boot(delegations[0]!.id as string)
    await waitFor(() => expect(document.querySelectorAll('.child-step')).toHaveLength(200))
    const step = document.querySelector<HTMLDetailsElement>('[data-child-step="d1-step-5"]')!
    act(() => {
      step.open = true
      fireEvent(step, new Event('toggle'))
    })
    expect(step.querySelector('pre')!.textContent).toContain('src/file-5.ts')
    await act(() => harness.client.store.refresh(harness.client.resources.managed('t-team')))
    expect(document.querySelector<HTMLDetailsElement>('[data-child-step="d1-step-5"]')!.open).toBe(true)
  })

  it('points an approval on the parent back to its row', async () => {
    const waiting = { ...teams, sessions: teams.sessions.map(row => (row.managedId === 't-team' ? { ...row, managedStatus: 'approval' } : row)) }
    boot(delegations[1]!.id as string, waiting)
    expect(await screen.findByText(/needs your approval to continue/)).toBeTruthy()
  })
})
