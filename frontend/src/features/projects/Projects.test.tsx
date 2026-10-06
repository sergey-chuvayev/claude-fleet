// A16, A32 (task side) and the Projects part of F19, F31, F33, F34 against the
// projects-collision pack, through the real transport and shell state.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useSelection } from '../../app/AppStore'
import archivedFixture from '../../test/fixtures/projects-collision/get-projects-archived.json'
import projectsFixture from '../../test/fixtures/projects-collision/get-projects.json'
import busyCreate from '../../test/fixtures/projects-collision/post-project-create-agents-busy.json'
import restoreAtCap from '../../test/fixtures/projects-collision/post-project-restore-at-cap.json'
import type { Project } from '../../transport/contracts'
import { keys } from '../../transport/resources'
import { ProjectConsole } from './ProjectConsole'
import { ProjectsPane } from './ProjectsPane'
import { type FakeFleet, type Mounted, fakeFleet, mount, mounted, unmount } from './testing'

const ALPHA = '00000001-f1e1-4000-8000-000000000000'
const BETA = '00000002-f1e1-4000-8000-000000000000'
const all = projectsFixture.response.body.projects as unknown as Project[]
const alpha = all.find(p => p.id === ALPHA)!
const beta = all.find(p => p.id === BETA)!

function Selected() {
  const selection = useSelection('projects')
  return <output data-testid="selected">{selection ? JSON.stringify(selection) : 'none'}</output>
}

function setup(projects: unknown[] = [alpha, beta], preferences: Record<string, string> = {}): { fleet: FakeFleet; view: Mounted } {
  const fleet = fakeFleet()
  fleet.set('/api/projects', { projects })
  fleet.set('/api/projects?archived=1', archivedFixture.response.body)
  const view = mount(
    <>
      <div id="projects-pane">
        <ProjectsPane />
      </div>
      <aside id="detail">
        <ProjectConsole />
      </aside>
      <Selected />
    </>,
    fleet,
    preferences,
  )
  return { fleet, view }
}

const toast = () => document.getElementById('toast')?.textContent ?? ''
const pane = () => document.getElementById('projects-pane')!
const nativeSelect = (label: string) => pane().querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!
const row = (title: string) => within(pane()).getByText(title).closest('li')!
const posts = (fleet: FakeFleet, path: string) => fleet.posted.filter(p => p.path === path)

afterEach(unmount)

describe('Projects pane', () => {
  it('draws the selected project from the file: head, strip, deliverables, sections and links', async () => {
    setup()
    expect(await screen.findByRole('heading', { level: 2, name: 'Alpha launch' })).toBeTruthy()
    const strip = pane().querySelector('.page-strip')!
    expect(strip.textContent).toMatch(/Deadline(18 Oct|Oct 18)/)
    expect(strip.textContent).toContain('Done1 of 9')
    expect(strip.textContent).toContain('Sessions0')
    const deliverables = within(pane()).getByText('Deliverables').closest('section')!
    expect(deliverables.querySelector('.ui-count')?.textContent).toBe('1/9')
    expect(deliverables.querySelectorAll('li.ui-row')).toHaveLength(9)
    // Arbitrary sections of the file survive, as folds.
    const folds = [...pane().querySelectorAll('.ui-folds > details > summary')].map(s => s.textContent)
    for (const heading of ['Sources', 'Decisions', 'Risks', 'Hand notes']) expect(folds).toContain(heading)
    expect(within(pane()).getByText('Brief')).toBeTruthy()
    expect(pane().querySelector('.day-links a')?.textContent).toContain('github.com/example-org/web-app/pull/41')
    // Without a manager the pane asks, and the console says what goes beside it.
    expect(pane().querySelector('input[data-project-ask]')).toBeTruthy()
    // It has a brief and deliverables, so there is nothing to say about setting up.
    expect(within(pane()).queryByText('Not set up yet')).toBeNull()
    expect(document.querySelector('#detail .console-empty')?.textContent).toContain('No project manager yet')
  })

  it('remembers the project in fleet:project and restores it', async () => {
    const { view } = setup([alpha, beta], { 'fleet:project': BETA })
    expect(await screen.findByRole('heading', { level: 2, name: 'Beta launch' })).toBeTruthy()
    expect(screen.getByTestId('selected').textContent).toContain(BETA)

    fireEvent.change(nativeSelect('Switch project'), { target: { value: ALPHA } })
    expect(await screen.findByRole('heading', { level: 2, name: 'Alpha launch' })).toBeTruthy()
    expect(view.storage.map.get('fleet:project')).toBe(ALPHA)
  })

  it('falls back to the first project when the remembered one is gone, without rewriting the preference', async () => {
    const { view } = setup([alpha, beta], { 'fleet:project': 'gone' })
    expect(await screen.findByRole('heading', { level: 2, name: 'Alpha launch' })).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId('selected').textContent).toContain(ALPHA))
    expect(view.storage.map.get('fleet:project')).toBe('gone')
  })

  it('creates from a title and a note, selects the new project and reports a manager that did not start', async () => {
    const { fleet, view } = setup()
    await screen.findByRole('heading', { level: 2, name: 'Alpha launch' })
    fireEvent.click(within(pane()).getByRole('button', { name: /New project/ }))
    expect(await screen.findByRole('heading', { level: 2, name: 'New project' })).toBeTruthy()

    // An empty title is refused before any request.
    const form = pane().querySelector('form')!
    fireEvent.submit(form)
    expect(toast()).toBe('Give it a title.')
    expect(posts(fleet, '/api/projects')).toHaveLength(0)

    fleet.answer('/api/projects', busyCreate.response.body)
    fleet.set('/api/projects', { projects: [alpha, beta, busyCreate.response.body.project] })
    fireEvent.change(screen.getByLabelText('Project title'), { target: { value: 'Created while busy' } })
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Asked by Franco' } })
    fireEvent.submit(form)

    await waitFor(() => expect(posts(fleet, '/api/projects')).toHaveLength(1))
    const [sent] = posts(fleet, '/api/projects')
    expect(sent?.body).toMatchObject({ name: 'Created while busy', note: 'Asked by Franco' })
    expect(typeof sent?.body.requestId).toBe('string')
    expect(sent?.token).toBeTruthy()
    // The honest outcome: kept, selected, and the manager did not start.
    await waitFor(() => expect(toast()).toBe(`Project created. Its manager did not start: ${busyCreate.response.body.project.setup.error}`))
    expect(await screen.findByRole('heading', { level: 2, name: 'Created while busy' })).toBeTruthy()
    expect(view.storage.map.get('fleet:project')).toBe(busyCreate.response.body.project.id)
    // No storage-error latch from a capacity refusal: control was never refetched as failed.
    expect(view.harness.client.store.get(view.harness.client.resources.control).error).toBeNull()
  })

  it('says the manager is starting when it did', async () => {
    const { fleet } = setup([alpha])
    await screen.findByRole('heading', { level: 2, name: 'Alpha launch' })
    fireEvent.click(within(pane()).getByRole('button', { name: /New project/ }))
    const started = { ...busyCreate.response.body.project, id: 'p-new', name: 'Fresh', setup: { started: true } }
    fleet.answer('/api/projects', { project: started })
    fleet.set('/api/projects', { projects: [alpha, started] })
    fireEvent.change(await screen.findByLabelText('Project title'), { target: { value: 'Fresh' } })
    fireEvent.submit(pane().querySelector('form')!)
    await waitFor(() => expect(toast()).toBe('Project created. Its manager is setting it up.'))
    expect(posts(fleet, '/api/projects')[0]?.body).not.toHaveProperty('note')
  })

  it('opens the create form when there are no projects, and the empty page after cancelling', async () => {
    setup([])
    expect(await screen.findByRole('heading', { level: 3, name: 'What are you working towards?' })).toBeTruthy()
    fireEvent.click(within(pane()).getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByRole('heading', { name: 'Group your work by outcome.' })).toBeTruthy()
    expect(document.querySelector('#detail .console-empty')?.textContent).toContain('No project selected')
    fireEvent.click(within(pane()).getByRole('button', { name: /Create a project/ }))
    expect(await screen.findByRole('heading', { level: 3, name: 'What are you working towards?' })).toBeTruthy()
  })

  it('changes a deliverable by its stable id, so equal titles in two projects stay separate', async () => {
    const { fleet } = setup()
    await screen.findByRole('heading', { level: 2, name: 'Alpha launch' })
    fleet.answer(`/api/projects/${ALPHA}/deliverable`, { deliverable: { id: '00000003f1e1', state: 'review' } })
    fireEvent.change(nativeSelect('State of Ship it'), { target: { value: 'review' } })
    await waitFor(() => expect(posts(fleet, `/api/projects/${ALPHA}/deliverable`)).toHaveLength(1))
    expect(posts(fleet, `/api/projects/${ALPHA}/deliverable`)[0]?.body).toEqual({ deliverableId: '00000003f1e1', state: 'review' })

    // Beta has its own "Ship it", with its own id.
    fireEvent.change(nativeSelect('Switch project'), { target: { value: BETA } })
    await screen.findByRole('heading', { level: 2, name: 'Beta launch' })
    fleet.answer(`/api/projects/${BETA}/deliverable`, { deliverable: { id: '0000000bf1e1', state: 'done' } })
    fireEvent.change(nativeSelect('State of Ship it'), { target: { value: 'done' } })
    await waitFor(() => expect(posts(fleet, `/api/projects/${BETA}/deliverable`)).toHaveLength(1))
    expect(posts(fleet, `/api/projects/${BETA}/deliverable`)[0]?.body).toEqual({ deliverableId: '0000000bf1e1', state: 'done' })
  })

  it('plans a task on Today, says so when it is already there, and leads to its Day item', async () => {
    const { fleet } = setup()
    await screen.findByRole('heading', { level: 2, name: 'Alpha launch' })
    const ship = row('Ship it')
    fleet.answer(`/api/projects/${ALPHA}/today`, { item: { id: 'item-1' }, existing: false })
    fireEvent.click(within(ship).getByRole('button', { name: /Today/ }))
    await waitFor(() => expect(toast()).toBe('On today. The Day agent is preparing a launch brief.'))
    expect(posts(fleet, `/api/projects/${ALPHA}/today`)[0]?.body).toEqual({ deliverableId: '00000003f1e1' })

    // Once the project reports it on the Day, the button leads there; a done task has no button.
    const onToday = { ...alpha, onToday: { '00000003f1e1': { itemId: 'item-1', status: 'in_progress' } } }
    fleet.set('/api/projects', { projects: [onToday, beta] })
    act(() => invalidateProjects())
    const lead = await within(pane()).findByRole('button', { name: /On Today/ })
    expect(lead.getAttribute('title')).toBe("On today's Day: in progress")
    expect(within(row('Fix login!')).queryByRole('button', { name: /Today/ })).toBeNull()
    fireEvent.click(lead)
    // The Day item thread is selected in Today, and the view moves there.
    expect(mounted().harness.store.getState().view).toBe('today')
    expect(mounted().harness.store.getState().selection.today).toEqual({ kind: 'day-thread', itemId: 'item-1' })

    fleet.answer(`/api/projects/${ALPHA}/today`, { item: { id: 'item-1' }, existing: true })
  })

  it('opens a task to its brief and sources, sends comments with Enter, keeps the text when refused', async () => {
    const { fleet } = setup()
    await screen.findByRole('heading', { level: 2, name: 'Alpha launch' })
    const ship = row('Ship it')
    fireEvent.click(ship.querySelector('summary')!)
    await waitFor(() => expect(ship.querySelector('details')?.open).toBe(true))
    const detail = ship.querySelector('.task-detail')!
    expect(detail.textContent).toContain('Cut the release.')
    expect(detail.querySelector('.task-sources a')?.textContent).toContain('TECH-301')
    // At most three chips on the closed row; the note sits beside them.
    expect(ship.querySelector('.ui-row-latest')?.textContent).toBe('PR #41 rebasing')

    const box = within(ship as HTMLElement).getByLabelText('Comment on Ship it') as HTMLTextAreaElement
    // Empty is refused with its toast; nothing is sent.
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(toast()).toBe('Write your comment first.')
    expect(posts(fleet, `/api/projects/${ALPHA}/comment`)).toHaveLength(0)

    // Shift+Enter breaks the line and sends nothing.
    fireEvent.change(box, { target: { value: 'Needs a rollback plan' } })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(posts(fleet, `/api/projects/${ALPHA}/comment`)).toHaveLength(0)

    // Refused (the agents are busy): the text stays.
    fleet.answer(`/api/projects/${ALPHA}/comment`, { error: '8 agents are already running. Stop one or wait for it to finish.', code: 'CAPACITY', retryable: true }, 409)
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(toast()).toBe('8 agents are already running. Stop one or wait for it to finish.'))
    expect(box.value).toBe('Needs a rollback plan')

    fleet.answer(`/api/projects/${ALPHA}/comment`, { session: { id: 'pm' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(toast()).toBe('Comment sent. The project manager is updating the task.'))
    const sent = posts(fleet, `/api/projects/${ALPHA}/comment`)
    expect(sent.at(-1)?.body).toMatchObject({ deliverableId: '00000003f1e1', message: 'Needs a rollback plan' })
    expect(typeof sent.at(-1)?.body.requestId).toBe('string')
    await waitFor(() => expect(box.value).toBe(''))
  })

  it('keeps an open task, typed text and the selected project across a refresh', async () => {
    const { fleet } = setup()
    await screen.findByRole('heading', { level: 2, name: 'Alpha launch' })
    const ship = row('Ship it')
    fireEvent.click(ship.querySelector('summary')!)
    const box = within(ship as HTMLElement).getByLabelText('Comment on Ship it') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'draft in progress' } })

    // The file was edited by hand: a refresh brings the new title and keeps what is open.
    const edited = { ...alpha, name: 'Alpha launch (edited)', deliverables: alpha.deliverables.map(d => (d.id === '00000003f1e1' ? { ...d, note: 'edited by hand' } : d)) }
    fleet.set('/api/projects', { projects: [edited, beta] })
    act(() => invalidateProjects())
    expect(await screen.findByRole('heading', { level: 2, name: 'Alpha launch (edited)' })).toBeTruthy()
    const after = row('Ship it')
    expect(after.querySelector('details')?.open).toBe(true)
    expect((within(after as HTMLElement).getByLabelText('Comment on Ship it') as HTMLTextAreaElement).value).toBe('draft in progress')
    expect(after.querySelector('.ui-row-latest')?.textContent).toBe('edited by hand')
  })

  it('archives with two clicks and moves to another project', async () => {
    const { fleet } = setup()
    await screen.findByRole('heading', { level: 2, name: 'Alpha launch' })
    fleet.answer(`/api/projects/${ALPHA}/archive`, { project: { ...alpha, archived: true } })
    fleet.set('/api/projects', { projects: [beta] })
    const button = within(pane()).getByRole('button', { name: 'Archive' })
    fireEvent.click(button)
    expect(button.textContent).toBe('Archive for good?')
    expect(posts(fleet, `/api/projects/${ALPHA}/archive`)).toHaveLength(0)
    fireEvent.click(button)
    await waitFor(() => expect(posts(fleet, `/api/projects/${ALPHA}/archive`)).toHaveLength(1))
    expect(posts(fleet, `/api/projects/${ALPHA}/archive`)[0]?.body).toEqual({ archived: true })
    expect(await screen.findByRole('heading', { level: 2, name: 'Beta launch' })).toBeTruthy()
  })

  it('restores an archived project, and keeps it archived with the server reason when there is no free slot', async () => {
    const { fleet } = setup()
    await screen.findByRole('heading', { level: 2, name: 'Alpha launch' })
    fireEvent.click(within(pane()).getByText('Archived projects'))
    const old = await within(pane()).findByText('Old research')
    const restoreButton = within(old.closest('li')!).getByRole('button', { name: 'Restore' })
    const oldId = (archivedFixture.response.body.projects as unknown as Project[]).find(p => p.name === 'Old research')!.id

    // At the cap the server answers CAPACITY: the reason shows, the project stays archived.
    fleet.answer(`/api/projects/${oldId}/archive`, restoreAtCap.response.body, 409)
    fireEvent.click(restoreButton)
    await waitFor(() => expect(toast()).toBe('Fleet keeps up to 30 active projects. Archive one before restoring this one.'))
    expect(posts(fleet, `/api/projects/${oldId}/archive`)[0]?.body).toEqual({ archived: false })
    expect(screen.getByTestId('selected').textContent).toContain(ALPHA)
    expect(within(pane()).getByText('Old research')).toBeTruthy()

    // With room, it comes back and is selected.
    const restored = { ...alpha, id: oldId, name: 'Old research', archived: false, deliverables: [] }
    fleet.answer(`/api/projects/${oldId}/archive`, { project: restored })
    fleet.set('/api/projects', { projects: [alpha, beta, restored] })
    fireEvent.click(restoreButton)
    await waitFor(() => expect(screen.getByTestId('selected').textContent).toContain(oldId))
    expect(await screen.findByRole('heading', { level: 2, name: 'Old research' })).toBeTruthy()
    expect(toast()).toBe('Restored Old research.')
  })

  it('copies the file path and says the file can be edited by hand', async () => {
    const written: string[] = []
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => void written.push(text) } })
    setup()
    await screen.findByRole('heading', { level: 2, name: 'Alpha launch' })
    fireEvent.click(within(pane()).getByRole('button', { name: 'Copy file path' }))
    await waitFor(() => expect(toast()).toBe('Path copied. Edit the file by hand any time; Fleet reads it.'))
    expect(written).toEqual([alpha.file])
  })

  it('asks the project manager before it has one, and refuses an empty question', async () => {
    const { fleet } = setup()
    await screen.findByRole('heading', { level: 2, name: 'Alpha launch' })
    const input = pane().querySelector<HTMLInputElement>('input[data-project-ask]')!
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(toast()).toBe('Type your question first.')
    fleet.answer(`/api/projects/${ALPHA}/ask`, { session: { id: 'pm' } })
    fireEvent.change(input, { target: { value: 'Where are we?' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(posts(fleet, `/api/projects/${ALPHA}/ask`)).toHaveLength(1))
    expect(posts(fleet, `/api/projects/${ALPHA}/ask`)[0]?.body).toMatchObject({ message: 'Where are we?' })
    await waitFor(() => expect(input.value).toBe(''))
  })

  it('shows Setting up while the manager runs its first time, and its conversation in the console', async () => {
    const withManager = { ...alpha, brief: '', deliverables: [], managerId: 'pm-1' }
    const fleet = fakeFleet()
    fleet.set('/api/projects', { projects: [withManager] })
    fleet.sessions.set({
      sessions: [{ managedId: 'pm-1', state: 'busy', managed: true, managedStatus: 'running', kind: 'project', projectId: ALPHA, name: 'Alpha launch' }],
      counts: { busy: 1, idle: 0, stale: 0, dead: 0 },
      total: 1,
    })
    fleet.set('/api/managed/pm-1', { session: { id: 'pm-1', status: 'running', kind: 'project', messages: [{ id: 'm1', role: 'user', text: 'Set this up', at: 1 }], approvals: [] } })
    mount(
      <>
        <div id="projects-pane">
          <ProjectsPane />
        </div>
        <aside id="detail">
          <ProjectConsole />
        </aside>
      </>,
      fleet,
    )
    expect(await within(pane()).findByText(/Setting up/)).toBeTruthy()
    // The manager is not a member; it has its own console with the approval gate stated.
    expect(pane().querySelector('input[data-project-ask]')).toBeNull()
    expect(await screen.findByText('Project manager · Alpha launch')).toBeTruthy()
    expect(screen.getByText('Changes need your approval').getAttribute('title')).toContain('never messages people')
    expect((await screen.findAllByText('Set this up')).length).toBeGreaterThan(0)
    expect((document.getElementById('message-input') as HTMLTextAreaElement).placeholder).toBe('Ask about this project: status, blockers, are we on track…')
  })

  it('lists member sessions and opens one in Sessions', async () => {
    const fleet = fakeFleet()
    fleet.set('/api/projects', { projects: [alpha] })
    fleet.sessions.set({
      sessions: [
        { managedId: 'm-1', state: 'busy', managed: true, managedStatus: 'running', projectId: ALPHA, title: 'Fix the checkout' },
        { managedId: 'pm-x', state: 'idle', managed: true, managedStatus: 'idle', kind: 'project', projectId: ALPHA, name: 'Manager' },
        { managedId: 'm-2', state: 'idle', managed: true, managedStatus: 'idle', projectId: BETA, title: 'Elsewhere' },
      ],
      counts: { busy: 1, idle: 2, stale: 0, dead: 0 },
      total: 3,
    })
    const view = mount(<ProjectsPane />, fleet)
    await screen.findByRole('heading', { level: 2, name: 'Alpha launch' })
    const sessions = (await screen.findByText('Sessions', { selector: 'h4' })).closest('section')!
    expect(sessions.querySelectorAll('li.ui-row')).toHaveLength(1)
    expect(within(sessions).getByText('Fix the checkout')).toBeTruthy()
    fireEvent.click(within(sessions).getByRole('button', { name: /Open/ }))
    expect(view.harness.store.getState().view).toBe('sessions')
    expect(view.harness.store.getState().selection.sessions).toEqual({ kind: 'managed', managedId: 'm-1' })
  })

  it('refreshes while visible, so a hand-edited file shows up without an event', async () => {
    const { fleet } = setup()
    await screen.findByRole('heading', { level: 2, name: 'Alpha launch' })
    const before = fleet.requests.filter(url => url === '/api/projects').length
    fleet.set('/api/projects', { projects: [{ ...alpha, name: 'Alpha, renamed in an editor' }, beta] })
    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'Alpha, renamed in an editor' })).toBeTruthy(), { timeout: 8000 })
    expect(fleet.requests.filter(url => url === '/api/projects').length).toBeGreaterThan(before)
  }, 12_000)

  it('shows an error and a retry when projects cannot be read at all', async () => {
    const fleet = fakeFleet()
    mount(<ProjectsPane />, fleet)
    expect(await screen.findByText('Could not load projects')).toBeTruthy()
  })
})

/** The project list is out of date, as a `projects` event says. */
const invalidateProjects = () => mounted().harness.client.store.invalidate(keys.projects)
