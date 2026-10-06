// The New agent dialog inside the real shell, against the fleet-mixed and teams-heavy
// fixtures: A03 (draft kept across dismissal, no request until Launch, discard clears,
// Codex always offered and refused only while missing, availability recovers on
// reopen), A04 (single, team and owner-review launches; a failed launch keeps the form
// and its request id), validation, the capacity and rate-limit notices, and the
// default approval mode applying to new drafts only (A20's launch half).
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AppShell } from '../../app/AppShell'
import { deferred } from '../../test/fakes'
import { type Harness, MemoryStorage, makeHarness, renderWith } from '../../test/shell'
import { CODEX_MISSING } from './LaunchDialog'
import { errorResponse, isPost, launchFleet } from './testing'

let harness: Harness | null = null

function boot(fleet = launchFleet(), storage?: MemoryStorage) {
  harness = makeHarness(fleet.fetch, storage)
  harness.client.start()
  renderWith(harness, <AppShell />)
  return { fleet, harness }
}

afterEach(() => {
  harness?.client.stop()
  harness = null
})

const dialog = () => screen.getByRole('dialog')
const prompt = () => document.getElementById('launch-prompt') as HTMLTextAreaElement
const cwd = () => document.getElementById('launch-cwd') as HTMLInputElement
const native = (id: string) => document.getElementById(id) as HTMLSelectElement | null
const choose = (id: string, value: string) => fireEvent.change(native(id)!, { target: { value } })
const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => fireEvent.change(el, { target: { value } })
const launchButton = () => document.getElementById('launch-submit') as HTMLButtonElement
const selection = () => harness!.store.getState().selection.sessions

async function openLaunch(how: 'button' | 'shortcut' = 'button') {
  if (how === 'button') fireEvent.click(screen.getByRole('button', { name: /New agent/ }))
  else fireEvent.keyDown(document, { key: 'n', ctrlKey: true })
  await screen.findByRole('dialog')
  // The directory is seeded from the server's control answer.
  await waitFor(() => expect(cwd().value).not.toBe(''))
}

async function sessionsLoaded() {
  // Wait for real session rows, not the shell's placeholder list.
  await waitFor(() => expect(document.querySelector('#session-list .session')).toBeTruthy())
  await waitFor(() => expect(selection()).not.toBeNull())
}

describe('LaunchDialog: the draft (A03)', () => {
  it('keeps the draft and the selection across dismissal, sends nothing until Launch, and Discard clears it', async () => {
    const { fleet } = boot()
    await sessionsLoaded()
    const before = selection()

    await openLaunch()
    expect(dialog().getAttribute('aria-modal')).toBe('true')
    expect(screen.getByRole('dialog', { name: 'What are we working on?' })).toBeTruthy()
    expect(document.activeElement).toBe(prompt())
    expect((document.querySelector('main')!.closest('body > *') as HTMLElement).inert).toBe(true)
    expect(cwd().value).toBe('/fixture/user')

    type(prompt(), 'Fix the flaky upload test')
    type(cwd(), '/fixture/repos')
    choose('launch-mode', 'auto')
    fireEvent.keyDown(prompt(), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect((document.querySelector('main')!.closest('body > *') as HTMLElement).inert).toBe(false)

    await openLaunch('shortcut')
    expect(prompt().value).toBe('Fix the flaky upload test')
    expect(cwd().value).toBe('/fixture/repos')
    expect(native('launch-mode')!.value).toBe('auto')
    // The close button and the backdrop keep the draft too.
    fireEvent.click(screen.getByRole('button', { name: 'Close new agent' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await openLaunch()
    expect(prompt().value).toBe('Fix the flaky upload test')

    expect(fleet.posts()).toEqual([])
    expect(selection()).toBe(before)

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await openLaunch()
    expect(prompt().value).toBe('')
    expect(cwd().value).toBe('/fixture/user')
    expect(native('launch-mode')!.value).toBe('all')
    expect(fleet.posts()).toEqual([])
    expect(selection()).toBe(before)
  })

  it('opens from another view without switching view or selection', async () => {
    boot()
    await sessionsLoaded()
    const before = selection()
    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    await openLaunch('shortcut')
    expect(harness!.store.getState().view).toBe('today')
    expect(selection()).toBe(before)
  })

  it('always offers Codex; while it is missing it explains setup and refuses only its launch, then recovers on reopen', async () => {
    const fleet = launchFleet()
    fleet.setCodex({ available: false })
    boot(fleet)
    await sessionsLoaded()
    await openLaunch()

    expect([...native('launch-engine')!.options].map(o => o.textContent)).toEqual(['Claude', 'Codex'])
    choose('launch-engine', 'codex')
    expect(screen.getByRole('dialog', { name: 'What should Codex work on?' })).toBeTruthy()
    expect(document.getElementById('draft-lead')?.textContent).toBe('Start a focused coding task with Codex.')
    expect(document.getElementById('launch-engine-note')?.textContent).toBe(CODEX_MISSING)
    // Codex runs one agent on its own model: no team, model or customize controls.
    expect(native('launch-team')).toBeNull()
    expect(native('launch-model')).toBeNull()
    expect(document.getElementById('customize-team')).toBeNull()

    type(prompt(), 'Add retry logic')
    fireEvent.click(launchButton())
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Codex is unavailable. Check the setup instructions above, then reopen New agent to retry.',
    )
    expect(fleet.posts('/api/managed')).toEqual([])

    // Claude still launches from the same dialog.
    choose('launch-engine', 'claude')
    expect(native('launch-team')).not.toBeNull()

    // Installed meanwhile: reopening asks the server again.
    fleet.setCodex({ available: true, model: 'gpt-5-codex' })
    choose('launch-engine', 'codex')
    fireEvent.keyDown(prompt(), { key: 'Escape' })
    const controls = fleet.gets('/api/control').length
    await openLaunch()
    await waitFor(() => expect(fleet.gets('/api/control').length).toBeGreaterThan(controls))
    await waitFor(() =>
      expect(document.getElementById('launch-engine-note')?.textContent).toBe(
        'Codex edits inside the project and can use the network. It does not ask before each command. Model: gpt-5-codex.',
      ),
    )
    // The sandbox explanation follows the approval mode.
    choose('launch-mode', 'ask')
    expect(document.getElementById('launch-engine-note')?.textContent).toBe(
      'Codex reads the project but changes nothing. Model: gpt-5-codex.',
    )
    fireEvent.click(launchButton())
    await waitFor(() => expect(fleet.posts('/api/managed')).toHaveLength(1))
    const sent = fleet.posts('/api/managed')[0]!.body!
    expect(sent).toMatchObject({ engine: 'codex', model: '', approvalMode: 'ask', prompt: 'Add retry logic' })
    expect(sent).not.toHaveProperty('teamId')
  })

  it('applies the server default approval mode to a new draft only', async () => {
    const fleet = launchFleet()
    fleet.setDefaultApprovalMode('ask')
    boot(fleet)
    await sessionsLoaded()
    await openLaunch()
    await waitFor(() => expect(native('launch-mode')!.value).toBe('ask'))
    type(prompt(), 'Draft in progress')

    // The operator changes the default in Settings; the open draft keeps its mode.
    fleet.setDefaultApprovalMode('auto')
    fireEvent.keyDown(prompt(), { key: 'Escape' })
    await openLaunch()
    await waitFor(() => expect(fleet.gets('/api/control').length).toBeGreaterThan(1))
    expect(native('launch-mode')!.value).toBe('ask')

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    await openLaunch()
    await waitFor(() => expect(native('launch-mode')!.value).toBe('auto'))
  })
})

describe('LaunchDialog: launching (A04)', () => {
  it('launches a single agent from Today: one POST, then Sessions with the new session selected', async () => {
    const storage = new MemoryStorage()
    const { fleet } = boot(launchFleet(), storage)
    await sessionsLoaded()
    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    await openLaunch('shortcut')
    type(prompt(), 'Start a new fixture agent')
    type(cwd(), '/fixture/repos')
    await waitFor(() => expect([...native('launch-model')!.options].map(o => o.value)).toContain('auto-jev'))
    choose('launch-model', 'sonnet')
    choose('launch-mode', 'auto')

    // Shift + Enter and IME composition are new lines, not launches.
    fireEvent.keyDown(prompt(), { key: 'Enter', shiftKey: true })
    fireEvent.keyDown(prompt(), { key: 'Enter', isComposing: true })
    expect(fleet.posts('/api/managed')).toEqual([])
    fireEvent.keyDown(prompt(), { key: 'Enter' })

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const posts = fleet.posts('/api/managed')
    expect(posts).toHaveLength(1)
    const sent = posts[0]!.body!
    expect(sent).toEqual({
      cwd: '/fixture/repos',
      prompt: 'Start a new fixture agent',
      approvalMode: 'auto',
      model: 'sonnet',
      requestId: expect.any(String),
    })
    expect(harness!.store.getState().view).toBe('sessions')
    expect(selection()).toEqual({ kind: 'managed', managedId: 'm-launched-1' })
    expect(harness!.notifier.getToast()).toBe('Agent launched')
    expect(storage.getItem('fleet:launch-cwd')).toBe('/fixture/repos')
    // The selection holds once the list catches up with the new row.
    await waitFor(() => expect(harness!.client.store.get(harness!.client.resources.sessions).data?.sessions[0]?.managedId).toBe('m-launched-1'))
    expect(selection()).toEqual({ kind: 'managed', managedId: 'm-launched-1' })

    // The next draft is new, in the directory just used.
    await openLaunch()
    expect(prompt().value).toBe('')
    expect(cwd().value).toBe('/fixture/repos')
    expect(native('launch-model')!.value).toBe('')
  })

  it('launches a team initiative and an owner-review request with their own wording', async () => {
    const { fleet } = boot()
    await sessionsLoaded()
    await openLaunch()
    await waitFor(() => expect(native('launch-team')!.disabled).toBe(false))
    expect([...native('launch-team')!.options].map(o => o.textContent)).toEqual([
      'No team · single agent',
      'Bug fix',
      'Software delivery',
      'Quick task',
      'Owner + review',
    ])

    choose('launch-team', 'owner-review')
    expect(screen.getByRole('dialog', { name: 'Give your owner a task.' })).toBeTruthy()
    expect(screen.getByLabelText('Task for the owner')).toBe(prompt())

    choose('launch-team', 'quick')
    expect(screen.getByRole('dialog', { name: 'Give your team a brief.' })).toBeTruthy()
    expect(screen.getByLabelText('Brief for the manager')).toBe(prompt())
    expect(document.getElementById('launch-team-note')?.textContent).toMatch(/^Small, clear changes.*Roles: manager, developer, qa\.$/)
    expect(launchButton().textContent).toContain('Launch initiative')

    type(prompt(), 'Start a team initiative')
    fireEvent.click(launchButton())
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(fleet.posts('/api/managed')[0]!.body).toMatchObject({ teamId: 'quick', prompt: 'Start a team initiative', model: '' })
    expect(harness!.notifier.getToast()).toBe('Initiative launched')
  })

  it('keeps the exact form and request id when a launch fails, and retries with the same id', async () => {
    const { fleet } = boot()
    await sessionsLoaded()
    await openLaunch()
    type(prompt(), 'Busy fleet')
    choose('launch-mode', 'ask')
    const wait = deferred<Response>()
    fleet.once(isPost('/api/managed'), () => wait.promise)

    fireEvent.click(launchButton())
    await waitFor(() => expect(launchButton().textContent).toBe('Launching…'))
    expect(prompt().disabled).toBe(true)
    // A second press while one is in flight sends nothing more.
    fireEvent.click(launchButton())
    await act(async () => wait.resolve(errorResponse(409, '8 agents are already running. Stop one or wait for it to finish.', 'CAPACITY')))

    const notice = await screen.findByText(/8 agents are already running/)
    expect(notice.id).toBe('launch-capacity')
    expect(notice.textContent).toContain('Your draft is kept')
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(prompt().value).toBe('Busy fleet')
    expect(native('launch-mode')!.value).toBe('ask')
    expect(prompt().disabled).toBe(false)

    fleet.once(isPost('/api/managed'), () => errorResponse(400, 'Project directory does not exist or is not accessible.', 'VALIDATION'))
    fireEvent.click(launchButton())
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Project directory does not exist or is not accessible.')

    fireEvent.click(launchButton())
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const ids = fleet.posts('/api/managed').map(p => p.body!.requestId)
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(1)
  })

  it('mints a new request id once the draft changes after a failure', async () => {
    const { fleet } = boot()
    await sessionsLoaded()
    await openLaunch()
    type(prompt(), 'First try')
    fleet.once(isPost('/api/managed'), () => errorResponse(500, 'Fleet hit an internal error.', 'INTERNAL'))
    fireEvent.click(launchButton())
    await screen.findByRole('alert')
    type(prompt(), 'Second try')
    fireEvent.click(launchButton())
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const [first, second] = fleet.posts('/api/managed').map(p => p.body!.requestId)
    expect(first).not.toBe(second)
  })

  it('retries once with a fresh token when the server restarted, under the same request id', async () => {
    const { fleet } = boot()
    await sessionsLoaded()
    await openLaunch()
    type(prompt(), 'After a restart')
    fleet.once(isPost('/api/managed'), () => errorResponse(403, 'Reload Fleet before sending commands.', 'TOKEN_INVALID'))
    fireEvent.click(launchButton())
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const posts = fleet.posts('/api/managed')
    expect(posts).toHaveLength(2)
    expect(posts[0]!.body!.requestId).toBe(posts[1]!.body!.requestId)
  })
})

describe('LaunchDialog: validation and notices', () => {
  it('asks for a task and a directory before sending anything', async () => {
    const { fleet } = boot()
    await sessionsLoaded()
    await openLaunch()
    fireEvent.click(launchButton())
    expect((await screen.findByRole('alert')).textContent).toBe('Describe the task first.')
    expect(document.activeElement).toBe(prompt())

    type(prompt(), 'Something')
    type(cwd(), '   ')
    fireEvent.click(launchButton())
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Choose the directory this agent works in.'))
    expect(document.activeElement).toBe(cwd())
    expect(fleet.posts('/api/managed')).toEqual([])
  })

  it('warns in the dialog while the account is rate limited', async () => {
    const fleet = launchFleet()
    const resetsAt = Date.UTC(2026, 9, 6, 12, 30)
    fleet.setUsage({ ...fleet.snapshot.usage, blocked: { rateLimitType: 'five_hour', resetsAt, reason: null } })
    boot(fleet)
    await sessionsLoaded()
    await openLaunch()
    const warning = await waitFor(() => {
      const el = document.getElementById('launch-blocked')
      expect(el).not.toBeNull()
      return el!
    })
    expect(warning.getAttribute('role')).toBe('status')
    expect(warning.textContent).toMatch(/^Rate limited until .+\. A new agent will not get past its first message until this window resets\.$/)
  })

  it('explains Auto · Jev only while it is the chosen model', async () => {
    boot()
    await sessionsLoaded()
    await openLaunch()
    const note = () => document.getElementById('launch-model-note')!
    expect(note().hidden).toBe(true)
    await waitFor(() => expect([...native('launch-model')!.options].map(o => o.value)).toContain('auto-jev'))
    choose('launch-model', 'auto-jev')
    expect(note().hidden).toBe(false)
    expect(within(dialog()).getByText(/Vercel AI Gateway/)).toBe(note())
  })
})
