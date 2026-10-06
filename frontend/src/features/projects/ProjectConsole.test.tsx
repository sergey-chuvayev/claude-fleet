// The project manager's console: its pending approvals through features/approvals,
// and a composer on the shared draft store asking through /api/projects/:id/ask with
// the composer's draft and request id rules (A07).
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import projectsFixture from '../../test/fixtures/projects-collision/get-projects.json'
import { deferred, jsonResponse } from '../../test/fakes'
import type { Project } from '../../transport/contracts'
import { ProjectConsole } from './ProjectConsole'
import { fakeFleet, mount, unmount } from './testing'

const ALPHA = '00000001-f1e1-4000-8000-000000000000'
const alpha = (projectsFixture.response.body.projects as unknown as Project[]).find(p => p.id === ALPHA)!
const ASK = `/api/projects/${ALPHA}/ask`

afterEach(unmount)

function setup(approvals: unknown[] = []) {
  const fleet = fakeFleet()
  fleet.set('/api/projects', { projects: [{ ...alpha, managerId: 'pm-1' }] })
  fleet.set('/api/managed/pm-1', {
    session: { id: 'pm-1', status: approvals.length ? 'approval' : 'idle', kind: 'project', name: 'Alpha launch', messages: [], approvals },
  })
  mount(
    <aside id="detail">
      <ProjectConsole />
    </aside>,
    fleet,
  )
  return fleet
}

const box = () => screen.getByLabelText('Message to the project manager') as HTMLTextAreaElement
const asks = (fleet: ReturnType<typeof fakeFleet>) => fleet.posted.filter(p => p.path === ASK)

describe('ProjectConsole', () => {
  it("shows the manager's pending approvals as approval cards", async () => {
    setup([{ id: 'ap-1', tool: 'mcp__linear__update_issue', description: 'Update TECH-12', input: { id: 'TECH-12' } }])
    expect(await screen.findByText('Update TECH-12')).toBeTruthy()
    expect(document.querySelector('#approvals [data-approval="ap-1"]')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeTruthy()
  })

  it('keeps the text and request id after a refused ask, and clears only on success', async () => {
    const fleet = setup()
    await screen.findByLabelText('Message to the project manager')
    fleet.answer(ASK, { error: '8 agents are already running.', code: 'CAPACITY', retryable: true }, 409)
    fireEvent.change(box(), { target: { value: 'Where are we?' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(asks(fleet)).toHaveLength(1))
    expect(await screen.findByText('8 agents are already running.')).toBeTruthy()
    expect(box().value).toBe('Where are we?')
    const first = asks(fleet)[0]!.body

    // The retry of the same words is the same request.
    const answer = deferred<Response>()
    fleet.answer(ASK, () => answer.promise)
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(asks(fleet)).toHaveLength(2))
    expect(asks(fleet)[1]!.body).toEqual(first)
    expect(first).toMatchObject({ message: 'Where are we?' })
    expect(typeof first.requestId).toBe('string')

    // Text typed while the ask is out survives its answer.
    fireEvent.change(box(), { target: { value: 'Where are we? And the deadline?' } })
    await act(async () => answer.resolve(jsonResponse({ session: { id: 'pm-1' } })))
    expect(box().value).toBe('Where are we? And the deadline?')

    // A fresh ask goes out with a new request id and, answered, clears the box.
    fleet.answer(ASK, { session: { id: 'pm-1' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(asks(fleet)).toHaveLength(3))
    expect(asks(fleet)[2]!.body.requestId).not.toBe(first.requestId)
    await waitFor(() => expect(box().value).toBe(''))
  })

  it('says so when Send is pressed with nothing typed', async () => {
    const fleet = setup()
    await screen.findByLabelText('Message to the project manager')
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(document.getElementById('toast')?.textContent).toBe('Type your question first.'))
    expect(asks(fleet)).toHaveLength(0)
  })
})
