// The project manager's console, as legacy drew it for any managed session: model
// picker, Connections and Close in the header; its pending approvals; the full
// composer posting to the manager's message route with the composer's draft and
// request id rules (A07).
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import projectsFixture from '../../test/fixtures/projects-collision/get-projects.json'
import { deferred, jsonResponse } from '../../test/fakes'
import type { Project } from '../../transport/contracts'
import { ProjectConsole } from './ProjectConsole'
import { fakeFleet, mount, mounted, unmount } from './testing'

const ALPHA = '00000001-f1e1-4000-8000-000000000000'
const alpha = (projectsFixture.response.body.projects as unknown as Project[]).find(p => p.id === ALPHA)!
const MESSAGES = '/api/managed/pm-1/messages'

afterEach(unmount)

const manager = (over: Record<string, unknown> = {}) => ({
  id: 'pm-1',
  status: 'idle',
  kind: 'project',
  name: 'Alpha launch',
  messages: [],
  approvals: [],
  ...over,
})

function setup(over: Record<string, unknown> = {}) {
  const fleet = fakeFleet()
  fleet.set('/api/projects', { projects: [{ ...alpha, managerId: 'pm-1' }] })
  fleet.set('/api/managed/pm-1', { session: manager(over) })
  mount(
    <aside id="detail">
      <ProjectConsole />
    </aside>,
    fleet,
  )
  return fleet
}

const box = () => document.getElementById('message-input') as HTMLTextAreaElement
const sends = (fleet: ReturnType<typeof fakeFleet>) => fleet.posted.filter(p => p.path === MESSAGES)

describe('ProjectConsole', () => {
  it('has the model picker, the gate note, Connections and Close in its header', async () => {
    setup()
    await waitFor(() => expect(document.getElementById('model-choice')).toBeTruthy())
    expect(screen.getByText('Changes need your approval')).toBeTruthy()
    expect(document.getElementById('agent-connections')).toBeTruthy()
    expect(document.getElementById('close-agent')?.textContent).toBe('Close')
    expect(document.getElementById('approval-mode')).toBeNull()
  })

  it('closes the manager on the second click', async () => {
    const fleet = setup()
    fleet.answer('/api/managed/pm-1/close', { ok: true })
    const close = await waitFor(() => {
      const el = document.getElementById('close-agent')
      if (!el) throw new Error('no Close yet')
      return el
    })
    fireEvent.click(close)
    expect(close.textContent).toBe('Close for good?')
    fireEvent.click(close)
    expect(await screen.findByText('Closed. Claude still has its own transcript of it.')).toBeTruthy()
    expect(fleet.posted.filter(p => p.path === '/api/managed/pm-1/close')).toHaveLength(1)
  })

  it("shows the manager's pending approvals, queued follow-ups and Cancel queued task", async () => {
    setup({
      status: 'queued',
      queue: [{ id: 'q1', message: 'And the deadline?' }],
      approvals: [{ id: 'ap-1', tool: 'mcp__linear__update_issue', description: 'Update TECH-12', input: { id: 'TECH-12' } }],
    })
    expect(await screen.findByText('Update TECH-12')).toBeTruthy()
    expect(document.querySelector('#approvals [data-approval="ap-1"]')).toBeTruthy()
    expect(screen.getByText('And the deadline?')).toBeTruthy()
    expect(document.getElementById('stop-agent')?.textContent).toBe('Cancel queued task')
  })

  it('sends through the full composer; a refused send keeps its text and request id', async () => {
    const fleet = setup()
    await waitFor(() => expect(box()).toBeTruthy())
    expect(box().getAttribute('role')).toBe('combobox')
    expect(document.getElementById('attach-tray')).toBeTruthy()
    fleet.answer(MESSAGES, { error: '8 agents are already running.', code: 'CAPACITY', retryable: true }, 409)
    fireEvent.change(box(), { target: { value: 'Where are we?' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(sends(fleet)).toHaveLength(1))
    expect(await screen.findByText('8 agents are already running.')).toBeTruthy()
    expect(box().value).toBe('Where are we?')
    const first = sends(fleet)[0]!.body
    expect(first).toMatchObject({ message: 'Where are we?', requestId: expect.any(String) })

    const answer = deferred<Response>()
    fleet.answer(MESSAGES, () => answer.promise)
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(sends(fleet)).toHaveLength(2))
    expect(sends(fleet)[1]!.body).toEqual(first)
    await act(async () => answer.resolve(jsonResponse({ session: manager({ status: 'running' }) })))
    await waitFor(() => expect(box().value).toBe(''))
    // Nothing went to the project page's ask route.
    expect(fleet.posted.filter(p => p.path.endsWith('/ask'))).toHaveLength(0)
  })

  it('has the composer height divider, on the preference the Sessions console uses', async () => {
    setup()
    const divider = await screen.findByRole('separator', { name: 'Resize message composer' })
    expect(divider.nextElementSibling?.id).toBe('composer')
    fireEvent.keyDown(divider, { key: 'Home' })
    expect(mounted().storage.getItem('fleet:minimal-composer-height')).toBe('110')
  })
})
