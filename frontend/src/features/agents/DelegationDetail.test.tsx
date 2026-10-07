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

describe('DelegationDetail extras (legacy inspector invariants)', () => {
  const NOW = 1_700_000_000_000
  const record = (extra: Record<string, unknown> = {}) => ({
    id: 'dev-1',
    role: 'developer',
    model: 'claude-sonnet-5',
    status: 'completed',
    startedAt: NOW - 45_000,
    finishedAt: NOW,
    attempt: 2,
    costUsd: 0.05,
    usage: { input_tokens: 950, output_tokens: 320, cache_read_input_tokens: 12000 },
    prompt: 'Fix the login',
    steps: [{ id: 'tool1', tool: 'Bash', status: 'done', ms: 1000, input: { command: '<script>unsafe</script>' }, result: '6 tests passed' }],
    report: 'PASS with test evidence',
    ...extra,
  })
  const bootRecord = (extra?: Record<string, unknown>) => {
    const sessions = {
      ...teams,
      sessions: teams.sessions.map(row =>
        row.managedId === 't-team' ? { ...row, delegations: [{ id: 'dev-1', role: 'developer', model: 'claude-sonnet-5', status: 'completed' }] } : row,
      ),
    }
    const managed = { ...detail, session: { ...detail.session, taskBoard: { ...detail.session.taskBoard, delegations: [record(extra)] } } }
    const fleet = fakeFleet({ control: teamControl.response.body, sessions, managed: { 't-team': managed } })
    return mount(fleet, <DelegationDetail selection={{ kind: 'delegation', parent: 't-team' as ManagedId, delegationId: 'dev-1' }} />)
  }
  const note = () => [...document.querySelectorAll('#detail-content > .page-body > .note')].map(el => el.textContent)

  it('shows duration, attempt and the token line, and no cost even when one was reported', async () => {
    bootRecord()
    await waitFor(() => expect(document.querySelectorAll('.child-step')).toHaveLength(1))
    expect(screen.getByText('Duration').parentElement?.textContent).toContain('45s')
    expect(screen.getByText('Attempt').parentElement?.textContent).toContain('2')
    expect(note()[0]).toBe('950 input · 320 output · 12k cache read · 0 cache write.')
    const text = document.getElementById('detail-content')!.textContent!
    expect(text).not.toMatch(/Reported cost|Per-agent cost|\$/)
  })

  it('escapes a step input instead of treating it as markup', async () => {
    bootRecord()
    await waitFor(() => expect(document.querySelectorAll('.child-step')).toHaveLength(1))
    const step = document.querySelector<HTMLDetailsElement>('[data-child-step="tool1"]')!
    act(() => {
      step.open = true
      fireEvent(step, new Event('toggle'))
    })
    expect(step.textContent).toContain('6 tests passed')
    expect(document.querySelector('#detail-content script')).toBeNull()
    expect(step.querySelector('pre')!.textContent).toContain('<script>unsafe</script>')
    expect(step.innerHTML).toContain('&lt;script&gt;unsafe&lt;/script&gt;')
  })

  it('falls back to the runtime token total, then to saying nothing was reported', async () => {
    const { unmount } = bootRecord({ usage: null, runtimeUsage: { total_tokens: 1300 } })
    await waitFor(() => expect(note()[0]).toBe('1k tokens reported.'))
    unmount()
    bootRecord({ usage: null, runtimeUsage: null })
    await waitFor(() => expect(note()[0]).toBe('Token usage not reported.'))
  })

  it('leaves out the attempt when none was recorded', async () => {
    bootRecord({ attempt: null })
    await waitFor(() => expect(document.querySelectorAll('.child-step')).toHaveLength(1))
    expect(screen.queryByText('Attempt')).toBeNull()
  })
})
