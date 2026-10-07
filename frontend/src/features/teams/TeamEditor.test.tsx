// The team editor as a mode of the New agent dialog (A11, F14): customizing a
// built-in team saves a copy, a custom team updates in place, roles are added,
// renamed and removed under the manager/verifier restrictions, the server's refusal
// is shown in the editor, Back returns to the draft as it was, and no save reaches a
// running initiative's team snapshot.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AppShell } from '../../app/AppShell'
import { deferred, jsonResponse, strip } from '../../test/fakes'
import tTeamFixture from '../../test/fixtures/teams-heavy/managed/t-team.json'
import { type Harness, makeHarness, renderWith } from '../../test/shell'
import { parseManagedDetail } from '../../transport/contracts'
import { errorResponse, isGet, isPost, launchFleet } from '../launch/testing'

let harness: Harness | null = null
afterEach(() => {
  harness?.client.stop()
  harness = null
})

function boot(fleet = launchFleet()) {
  harness = makeHarness(fleet.fetch)
  harness.client.start()
  renderWith(harness, <AppShell />)
  return fleet
}

const native = (id: string) => document.getElementById(id) as HTMLSelectElement
const editor = () => document.getElementById('team-editor')!
const roleRow = (id: string) => editor().querySelector<HTMLElement>(`.team-role[data-role-key="${id}"]`)!
const field = (root: HTMLElement, label: string) => within(root).getByLabelText(label) as HTMLInputElement
const tool = (row: HTMLElement, name: string) => row.querySelector<HTMLInputElement>(`input[data-tool="${name}"]`)!

async function openDialog() {
  fireEvent.keyDown(document, { key: 'n', ctrlKey: true })
  await screen.findByRole('dialog')
  await waitFor(() => expect(native('launch-team').disabled).toBe(false))
}

async function customize(team: string) {
  fireEvent.change(native('launch-team'), { target: { value: team } })
  fireEvent.click(screen.getByRole('button', { name: 'Customize team…' }))
  await screen.findByRole('dialog', { name: 'Shape the team.' })
}

describe('TeamEditor in the launch dialog (A11)', () => {
  it('saves a customized copy of a built-in team and comes back to the draft with it chosen', async () => {
    const fleet = boot()
    // A running initiative's snapshot, held in the store as the console would hold it.
    const snapshot = parseManagedDetail(strip(tTeamFixture.response.body))
    harness!.client.store.set(harness!.client.resources.managed('t-team'), snapshot)

    await openDialog()
    fireEvent.change(document.getElementById('launch-prompt')!, { target: { value: 'Fix the login bug' } })
    await customize('bugfix')

    // The launch form gives way to the editor; nothing is stacked.
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(document.getElementById('launch-prompt')).toBeNull()
    expect(document.activeElement).toBe(field(editor(), 'Team name'))
    expect(field(editor(), 'Team name').value).toBe('Bug fix · custom')
    expect(field(editor(), 'Team ID').value).toBe('bugfix-custom')
    expect(field(editor(), 'Team ID').readOnly).toBe(false)
    expect(field(editor(), 'Repair attempts per task').value).toBe('3')

    // The manager only reads; a verifier cannot edit.
    const manager = roleRow('manager')
    expect(tool(manager, 'Bash').disabled).toBe(true)
    expect(tool(manager, 'Read').checked).toBe(true)
    const qa = roleRow('qa')
    expect(tool(qa, 'Write').disabled).toBe(true)
    expect(tool(qa, 'Bash').checked).toBe(true)

    // Rename the verifier, add a specialist, change limits and instructions.
    fireEvent.change(field(qa, 'Role ID'), { target: { value: 'checker' } })
    expect(roleRow('checker')).toBe(qa)
    fireEvent.click(screen.getByRole('button', { name: '+ Add role' }))
    const specialist = roleRow('specialist')
    fireEvent.change(field(specialist, 'Model'), { target: { value: 'haiku' } })
    fireEvent.change(field(specialist, 'Turn limit'), { target: { value: '12' } })
    fireEvent.click(tool(specialist, 'Bash'))
    fireEvent.change(field(roleRow('developer'), 'Instructions'), { target: { value: 'Implement it with tests.' } })
    fireEvent.change(field(editor(), 'Repair attempts per task'), { target: { value: '4' } })
    // Making the specialist a verifier takes its edit tools away.
    fireEvent.click(tool(specialist, 'Write'))
    expect(tool(specialist, 'Write').checked).toBe(true)
    fireEvent.click(within(specialist).getByLabelText('Required verifier'))
    expect(tool(specialist, 'Write').checked).toBe(false)
    expect(tool(specialist, 'Write').disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Save team' }))
    await screen.findByRole('dialog', { name: 'Give your team a brief.' })

    const [save] = fleet.posts('/api/teams')
    expect(save!.body).toMatchObject({
      id: 'bugfix-custom',
      name: 'Bug fix · custom',
      manager: 'manager',
      workflow: { reviewers: ['checker', 'specialist'], maxAttempts: 4 },
    })
    const roles = save!.body!.roles as Record<string, { tools: string[]; model: string; maxTurns: number; prompt: string }>
    expect(Object.keys(roles)).toEqual(['manager', 'developer', 'checker', 'specialist'])
    expect(roles.specialist).toMatchObject({ model: 'haiku', maxTurns: 12, tools: ['Read', 'Glob', 'Grep', 'Bash'] })
    expect(roles.developer!.prompt).toBe('Implement it with tests.')
    expect(roles.manager!.tools.every(t => ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'].includes(t))).toBe(true)

    // Back on the draft, with the saved team chosen and the prompt kept.
    expect(native('launch-team').value).toBe('bugfix-custom')
    expect((document.getElementById('launch-prompt') as HTMLTextAreaElement).value).toBe('Fix the login bug')
    expect(document.activeElement).toBe(document.getElementById('launch-prompt'))
    expect(harness!.notifier.getToast()).toBe('Team saved. Ready for your task.')

    // A save touches the catalog only: no running session was asked or changed.
    expect(fleet.requests.filter(r => r.url.startsWith('/api/managed') && (r.method === 'POST' || r.url.includes('t-team')))).toEqual([])
    expect(harness!.client.store.get(harness!.client.resources.managed('t-team')).data).toBe(snapshot)

    // Customizing the saved team again updates it in place.
    await customize('bugfix-custom')
    expect(field(editor(), 'Team ID').readOnly).toBe(true)
    expect(field(editor(), 'Team name').value).toBe('Bug fix · custom')
  })

  it('shows the server refusal in the editor and keeps the edits', async () => {
    const fleet = launchFleet()
    fleet.once(isPost('/api/teams'), () => errorResponse(400, 'A team needs 3–8 roles, including its manager.', 'VALIDATION'))
    boot(fleet)
    await openDialog()
    await customize('quick')
    fireEvent.change(field(editor().querySelector<HTMLElement>('.team-meta')!, 'Purpose'), { target: { value: 'Tiny fixes' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save team' }))
    expect((await within(editor()).findByRole('alert')).textContent).toBe('A team needs 3–8 roles, including its manager.')
    expect(field(editor().querySelector<HTMLElement>('.team-meta')!, 'Purpose').value).toBe('Tiny fixes')
    // A role id the server would refuse is caught before sending.
    fireEvent.change(field(roleRow('developer'), 'Role ID'), { target: { value: 'Dev Ops' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save team' }))
    expect(within(editor()).getByRole('alert').textContent).toBe('Role IDs need lowercase letters, numbers and hyphens.')
    expect(fleet.posts('/api/teams')).toHaveLength(1)
    // The manager cannot be removed.
    fireEvent.click(within(roleRow('manager')).getByRole('button', { name: 'Remove role' }))
    expect(within(editor()).getByRole('alert').textContent).toBe('Choose another manager before removing this role.')
  })

  it('survives closing the dialog, and Back returns to the draft on its own team', async () => {
    boot()
    await openDialog()
    await customize('delivery')
    fireEvent.change(field(editor(), 'Team name'), { target: { value: 'Delivery, my way' } })
    fireEvent.keyDown(field(editor(), 'Team name'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.keyDown(document, { key: 'n', ctrlKey: true })
    await screen.findByRole('dialog', { name: 'Shape the team.' })
    expect(field(editor(), 'Team name').value).toBe('Delivery, my way')
    expect(document.activeElement).toBe(field(editor(), 'Team name'))

    fireEvent.click(screen.getByRole('button', { name: 'Back to draft' }))
    await screen.findByRole('dialog', { name: 'Give your team a brief.' })
    expect(native('launch-team').value).toBe('delivery')
  })

  it('shows the owner-review shape: an owner, one reviewer, and no roles to add or remove', async () => {
    boot()
    await openDialog()
    await customize('owner-review')
    expect(field(editor(), 'Reviewed implementations per request').value).toBe('3')
    expect(screen.getByRole('button', { name: '+ Add role' })).toHaveProperty('disabled', true)
    const owner = roleRow('owner')
    expect(within(owner).getByLabelText('Owner')).toHaveProperty('checked', true)
    expect(within(owner).getByRole('button', { name: 'Remove role' })).toHaveProperty('disabled', true)
    expect(tool(owner, 'Write').disabled).toBe(false)
    expect(tool(roleRow('reviewer'), 'Edit').disabled).toBe(true)
  })

  it('ignores a team that arrives after the draft was discarded', async () => {
    const fleet = launchFleet()
    const slow = deferred<Response>()
    fleet.once(isGet('/api/teams/bugfix'), () => slow.promise)
    boot(fleet)
    await openDialog()
    fireEvent.change(native('launch-team'), { target: { value: 'bugfix' } })
    fireEvent.click(screen.getByRole('button', { name: 'Customize team…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    await act(async () => slow.resolve(jsonResponse({ team: strip((await import('../../test/fixtures/teams-heavy/team-bugfix.json')).response.body.team) })))
    await openDialog()
    expect(document.getElementById('team-editor')).toBeNull()
    expect(screen.getByRole('dialog', { name: 'What are we working on?' })).toBeTruthy()
  })
})
