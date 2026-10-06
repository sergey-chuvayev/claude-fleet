// A09 (F12): rename, mode, model for the next turn, project tag, stop and close go
// through the session's own routes, the session is read again, and the header follows
// the server: the persisted title, the next-turn model, a close that needs a second
// click, stop that cancels a queued task, and a held session's message that waits.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ManagedId } from '../../domain/ids'
import errorFile from '../../test/fixtures/conversation-heavy/managed/c-error.json'
import codexFile from '../../test/fixtures/conversation-heavy/managed/c-codex.json'
import heldFile from '../../test/fixtures/fleet-mixed/managed/m-held.json'
import { jsonResponse } from '../../test/fakes'
import type { DetailBody } from '../conversation/testing'
import { type ConsoleFleet, consoleFleet, detailOf, mountConsole, postsTo } from '../session-header/testing'
import { SessionDetail } from './SessionDetail'

const managed = (id: string) => ({ kind: 'managed', managedId: id as ManagedId }) as const
const withSession = (detail: DetailBody, patch: Record<string, unknown>): DetailBody => ({ ...detail, session: { ...detail.session, ...patch } })

let fleet: ConsoleFleet
beforeEach(() => {
  fleet = consoleFleet()
  fleet.update('c-error', detailOf(errorFile))
})

const toast = () => document.getElementById('toast')?.textContent ?? ''

describe('SessionDetail header (A09)', () => {
  it('shows the title, context share, state with the queue, the error line and queued follow-ups', async () => {
    fleet.update(
      'c-error',
      withSession(detailOf(errorFile), {
        status: 'running',
        contextTokens: 180000,
        contextLimit: 200000,
        queue: [{ message: 'After that, update the changelog' }, { message: '', attachments: [{ id: 'a.png' }, { id: 'b.png' }] }],
        error: 'The model request failed: 529 overloaded. Send a message to retry.',
      }),
    )
    mountConsole(fleet, <SessionDetail />, managed('c-error'))
    expect(await screen.findByRole('button', { name: 'Run that failed' })).toBeTruthy()
    const chip = document.getElementById('agent-context')!
    expect(chip.textContent).toBe('90%')
    expect(chip.className).toContain('hot')
    expect(document.getElementById('agent-state')?.textContent).toBe('Working on your task · 2 queued')
    const queued = within(screen.getByRole('list', { name: 'Messages waiting to send' }))
      .getAllByRole('listitem')
      .map(li => li.textContent)
    expect(queued).toEqual(['#1After that, update the changelogQueued', '#22 imagesQueued'])
    expect(document.getElementById('agent-error')?.textContent).toContain('529 overloaded')
    expect(screen.getByRole('button', { name: /Queue/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Stop/ })).toBeTruthy()
    expect(document.getElementById('composer-hint')?.textContent).toBe('Claude is still working. This joins the queue and sends the moment it’s free.')
  })

  it('renames in place: Enter posts the name once and the header shows the persisted title', async () => {
    const user = userEvent.setup()
    fleet.onPost = (post, self) => {
      const renamed = withSession(self.held('c-error')!, { name: String(post.body.name), renamed: true })
      self.update('c-error', renamed)
      return jsonResponse(renamed)
    }
    mountConsole(fleet, <SessionDetail />, managed('c-error'))
    await user.click(await screen.findByRole('button', { name: 'Run that failed' }))
    const input = screen.getByRole('textbox', { name: 'Name this agent' })
    await user.clear(input)
    await user.type(input, 'Suite after the outage{Enter}')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Suite after the outage' })).toBeTruthy())
    expect(postsTo(fleet, '/name')).toEqual([{ path: '/api/managed/c-error/name', body: { name: 'Suite after the outage' } }])
  })

  it('Escape cancels a rename without a request', async () => {
    const user = userEvent.setup()
    mountConsole(fleet, <SessionDetail />, managed('c-error'))
    await user.click(await screen.findByRole('button', { name: 'Run that failed' }))
    await user.type(screen.getByRole('textbox', { name: 'Name this agent' }), ' later{Escape}')
    expect(await screen.findByRole('button', { name: 'Run that failed' })).toBeTruthy()
    expect(fleet.posts).toEqual([])
  })

  it('a model change applies from the next message, and says so', async () => {
    fleet.models = [
      { value: '', displayName: 'Fleet default' },
      { value: 'opus', displayName: 'Opus' },
    ]
    fleet.onPost = (post, self) => {
      const next = withSession(self.held('c-error')!, { selectedModel: post.body.model })
      self.update('c-error', next)
      return jsonResponse(next)
    }
    mountConsole(fleet, <SessionDetail />, managed('c-error'))
    const select = (await screen.findAllByLabelText('Model for this agent')).find(el => el.tagName === 'SELECT') as HTMLSelectElement
    await waitFor(() => expect([...select.options].map(o => o.textContent)).toEqual(['Fleet default', 'Opus']))
    fireEvent.change(select, { target: { value: 'opus' } })
    await waitFor(() => expect(toast()).toBe('Next message uses Opus'))
    expect(postsTo(fleet, '/model')).toEqual([{ path: '/api/managed/c-error/model', body: { model: 'opus' } }])
    expect(select.value).toBe('opus')
  })

  it('the approval mode posts the mode and a refused change returns to the server value', async () => {
    fleet.onPost = () => jsonResponse({ error: 'Choose ask, auto or all.', code: 'VALIDATION' }, 400)
    mountConsole(fleet, <SessionDetail />, managed('c-error'))
    const select = (await screen.findAllByLabelText('Approvals for this agent')).find(el => el.tagName === 'SELECT') as HTMLSelectElement
    expect(select.value).toBe('ask')
    fireEvent.change(select, { target: { value: 'all' } })
    await waitFor(() => expect(toast()).toBe('Choose ask, auto or all.'))
    await waitFor(() => expect(select.value).toBe('ask'))
    expect(postsTo(fleet, '/mode')).toEqual([{ path: '/api/managed/c-error/mode', body: { mode: 'all' } }])
  })

  it('tags the session to a project and removes it again; no projects, no picker', async () => {
    mountConsole(fleet, <SessionDetail />, managed('c-error'))
    await screen.findByRole('button', { name: 'Run that failed' })
    expect(screen.queryAllByLabelText('Project')).toEqual([])
  })

  it('tags with a project and untags with null', async () => {
    fleet.projects = [{ id: 'p-1', name: 'Checkout' }]
    fleet.onPost = (post, self) => {
      const next = withSession(self.held('c-error')!, { projectId: post.body.projectId })
      self.update('c-error', next)
      return jsonResponse(next)
    }
    mountConsole(fleet, <SessionDetail />, managed('c-error'))
    const select = () => screen.getAllByLabelText('Project').find(el => el.tagName === 'SELECT') as HTMLSelectElement
    await waitFor(() => expect(select()).toBeTruthy())
    fireEvent.change(select(), { target: { value: 'p-1' } })
    await waitFor(() => expect(toast()).toBe('Added to the project'))
    fireEvent.change(select(), { target: { value: '' } })
    await waitFor(() => expect(toast()).toBe('Removed from the project'))
    expect(postsTo(fleet, '/project').map(p => p.body)).toEqual([{ projectId: 'p-1' }, { projectId: null }])
  })

  it('stop posts once; a queued task offers to cancel instead', async () => {
    fleet.update('c-error', withSession(detailOf(errorFile), { status: 'queued', error: null }))
    fleet.onPost = (_post, self) => {
      const next = withSession(self.held('c-error')!, { status: 'stopped', queue: [] })
      self.update('c-error', next)
      return jsonResponse(next)
    }
    const user = userEvent.setup()
    mountConsole(fleet, <SessionDetail />, managed('c-error'))
    await user.click(await screen.findByRole('button', { name: 'Cancel queued task' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel queued task' })).toBeNull())
    expect(postsTo(fleet, '/stop')).toEqual([{ path: '/api/managed/c-error/stop', body: {} }])
    expect(document.getElementById('agent-state')?.textContent).toBe('Stopped · ready to continue')
  })

  it('close needs a second click, then says it is closed', async () => {
    const user = userEvent.setup()
    fleet.onPost = () => jsonResponse({ closed: true })
    mountConsole(fleet, <SessionDetail />, managed('c-error'))
    await user.click(await screen.findByRole('button', { name: 'Close' }))
    expect(fleet.posts).toEqual([])
    expect(screen.getByRole('button', { name: 'Close for good?' }).dataset.armed).toBe('1')
    await user.click(screen.getByRole('button', { name: 'Close for good?' }))
    await waitFor(() => expect(toast()).toBe('Closed. Claude still has its own transcript of it.'))
    expect(postsTo(fleet, '/close')).toEqual([{ path: '/api/managed/c-error/close', body: {} }])
    expect(screen.queryByRole('textbox', { name: 'Message this agent' })).toBeNull()
  })

  it('a working session asks "Stop and close?" on the first click', async () => {
    fleet.update('c-error', withSession(detailOf(errorFile), { status: 'running' }))
    const user = userEvent.setup()
    mountConsole(fleet, <SessionDetail />, managed('c-error'))
    await user.click(await screen.findByRole('button', { name: 'Close' }))
    expect(screen.getByRole('button', { name: 'Stop and close?' })).toBeTruthy()
  })

  it('a session held by a terminal says so, queues the message and lets the server hold it', async () => {
    fleet.update('m-held', detailOf(heldFile))
    const user = userEvent.setup()
    mountConsole(fleet, <SessionDetail />, managed('m-held'))
    const box = await screen.findByRole('combobox', { name: 'Message this agent' })
    expect(document.getElementById('agent-state')?.textContent).toBe('Working in a terminal')
    const hint = document.getElementById('composer-hint')!
    expect(hint.className).toContain('is-held')
    expect(hint.textContent).toMatch(/^Open in a terminal · held-in-terminal · since .+\. Messages wait here and send once it is closed there\.$/)
    expect(screen.getByRole('button', { name: /Queue/ })).toBeTruthy()
    expect(within(screen.getByRole('list', { name: 'Messages waiting to send' })).getByText('Continue when free')).toBeTruthy()
    await user.type(box, 'And then the docs{Enter}')
    await waitFor(() => expect(postsTo(fleet, '/messages')).toHaveLength(1))
    expect(postsTo(fleet, '/messages')[0]?.body).toMatchObject({ message: 'And then the docs' })
  })

  it('a Codex agent has no Claude model picker, and its approval mode explains the sandbox', async () => {
    fleet.update('c-codex', detailOf(codexFile))
    mountConsole(fleet, <SessionDetail />, managed('c-codex'))
    await screen.findByRole('button', { name: 'Codex: add retries' })
    expect(screen.queryAllByLabelText('Model for this agent')).toEqual([])
    const mode = screen.getAllByLabelText('Approvals for this agent').find(el => el.tagName === 'SELECT')!
    expect(mode.getAttribute('title')).toBe('Codex reads the project but changes nothing.')
  })

  it('a delegation is read only: no control panel, no composer', async () => {
    mountConsole(fleet, <SessionDetail />, { kind: 'delegation', parent: 'c-error' as ManagedId, delegationId: 'd-1' })
    await act(async () => {})
    expect(document.getElementById('control-panel')).toBeNull()
    expect(document.getElementById('composer')).toBeNull()
    expect(document.getElementById('detail-content')).toBeTruthy()
  })
})
