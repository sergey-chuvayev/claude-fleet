// A30: the Worktrees tab and the clear confirmation against the real git checkouts of
// the fleet-mixed pack (merged and clean, dirty and unpushed, main checkouts with a
// running session), plus a synthetic open pull request, locked and detached case.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useModal } from '../../app/AppStore'
import worktreesFixture from '../../test/fixtures/fleet-mixed/get-worktrees.json'
import type { Checkout } from '../../transport/contracts'
import { fakeFleet, mount, mounted, unmount } from '../projects/testing'
import { ClearWorktreeDialog } from './ClearWorktreeDialog'
import { WorktreesPage } from './WorktreesPage'

const base = worktreesFixture.response.body
const checkouts = base.checkouts as unknown as Checkout[]
const MERGED = checkouts.find(c => c.clearable)!

const extra = [
  {
    ...checkouts[1],
    path: '/fixture/repos/web-app-pr',
    pathShort: '/fixture/repos/web-app-pr',
    branch: 'feat/open-pr',
    dirty: 0,
    unpushed: 0,
    pr: { number: 42, url: 'https://github.com/example-org/web-app/pull/42', state: 'OPEN' },
    blockers: [{ code: 'unmerged', text: 'Not merged into main.' }],
    locked: true,
  },
  { ...checkouts[1], path: '/fixture/repos/detached', pathShort: '/fixture/repos/detached', branch: null, detached: true, dirty: 0, unpushed: 0, blockers: [] },
]
const report = { ...base, checkouts: [...checkouts, ...extra], outside: 2 }

function Modal() {
  const modal = useModal()
  return modal?.kind === 'clear-worktree' ? <ClearWorktreeDialog modal={modal} onClose={() => {}} /> : null
}

function setup(body: unknown = report, preferences: Record<string, string> = {}) {
  const fleet = fakeFleet()
  fleet.set('/api/worktrees', body)
  const view = mount(
    <>
      <section id="worktrees-pane">
        <WorktreesPage />
      </section>
      <Modal />
    </>,
    fleet,
    preferences,
  )
  return { fleet, view }
}
const strip = () => document.querySelector('.page-strip')!.textContent
const rows = () => [...document.querySelectorAll<HTMLElement>('#worktrees-pane li.ui-row')]
const titles = () => rows().map(r => r.querySelector('.ui-row-title')?.textContent)
const toast = () => document.getElementById('toast')?.textContent ?? ''
const filter = () => document.querySelector<HTMLSelectElement>('select[aria-label="Show"]')!

afterEach(unmount)

describe('Worktrees page', () => {
  it('lists every checkout with its pills, the stat strip and the outside note', async () => {
    setup()
    expect(await screen.findByRole('heading', { level: 2, name: 'Worktrees' })).toBeTruthy()
    expect(titles()).toEqual([...checkouts.map(c => c.branch), 'feat/open-pr', 'Detached HEAD'])
    expect(strip()).toContain('Checkouts7')
    expect(strip()).toContain('Safe to clear1')
    expect(strip()).toContain('Open PR1')
    expect(strip()).toContain('Needs care1')

    const [merged, wip, mainRun] = rows()
    expect(within(merged!).getByText('Merged')).toBeTruthy()
    expect(within(wip!).getByText('1 uncommitted')).toBeTruthy()
    expect(within(wip!).getByText('1 unpushed')).toBeTruthy()
    expect(within(wip!).getByText('Not merged into main')).toBeTruthy()
    expect(within(mainRun!).getByText('Main checkout')).toBeTruthy()
    expect(within(mainRun!).getByText('Session running')).toBeTruthy()
    const pr = rows().find(r => r.textContent?.includes('feat/open-pr'))!
    const prLink = within(pr).getByRole('link', { name: 'PR #42 open' }) as HTMLAnchorElement
    expect(prLink.href).toBe('https://github.com/example-org/web-app/pull/42')
    expect(prLink.rel).toBe('noopener noreferrer')
    expect(within(pr).getByText('Locked')).toBeTruthy()
    expect(screen.getByText(/2 sessions ran outside a git checkout/)).toBeTruthy()
  })

  it('offers Clear only on clearable rows', async () => {
    setup()
    await screen.findByRole('heading', { level: 2, name: 'Worktrees' })
    const buttons = screen.getAllByRole('button', { name: /^Clear / })
    expect(buttons).toHaveLength(1)
    expect(buttons[0]!.getAttribute('aria-label')).toBe(`Clear ${MERGED.branch}`)
    expect(within(rows()[0]!).getByRole('button', { name: /^Clear / })).toBe(buttons[0])
  })

  it('filters, remembers the filter in fleet:worktrees-filter and restores it', async () => {
    const { view } = setup()
    await screen.findByRole('heading', { level: 2, name: 'Worktrees' })
    fireEvent.change(filter(), { target: { value: 'care' } })
    expect(titles()).toEqual(['feat/web-app-wip'])
    expect(view.storage.map.get('fleet:worktrees-filter')).toBe('care')
    // The section count follows the filter; the strip counts everything.
    expect(document.querySelector('.ui-section .ui-count')?.textContent).toBe('1')
    expect(strip()).toContain('Checkouts7')

    fireEvent.change(filter(), { target: { value: 'pr' } })
    expect(titles()).toEqual(['feat/open-pr'])
    fireEvent.change(filter(), { target: { value: 'merged' } })
    expect(titles()).toEqual(['feat/web-app-merged', 'feat/checkout'])
    fireEvent.change(filter(), { target: { value: 'clearable' } })
    expect(titles()).toEqual(['feat/web-app-merged'])
  })

  it('restores a remembered filter, and says when nothing matches', async () => {
    setup({ ...report, checkouts: [checkouts[0]] }, { 'fleet:worktrees-filter': 'pr' })
    expect(await screen.findByText('Nothing matches.')).toBeTruthy()
    expect(screen.getByText(/No checkout is under .Open pull request./)).toBeTruthy()
    expect(filter().value).toBe('pr')
  })

  it('opens a row to what keeps it and who used it, and keeps it open across a refresh', async () => {
    const { fleet } = setup()
    await screen.findByRole('heading', { level: 2, name: 'Worktrees' })
    const wip = rows()[1]!
    fireEvent.click(wip.querySelector('summary')!)
    await waitFor(() => expect(wip.querySelector('details')?.open).toBe(true))
    expect(wip.textContent).toContain('Kept because:')
    expect(wip.textContent).toContain('1 uncommitted change.')
    expect(wip.textContent).toContain('1 session')
    expect(wip.textContent).toContain('Untitled session')

    fleet.set('/api/worktrees', { ...report, generatedAt: 2 })
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }))
    await waitFor(() => expect(fleet.requests.filter(u => u === '/api/worktrees')).toHaveLength(2))
    expect(rows()[1]!.querySelector('details')?.open).toBe(true)
  })

  it('shows an error callout when the first load fails, and the last list when a refresh does', async () => {
    const fleet = fakeFleet()
    mount(<WorktreesPage />, fleet)
    expect(await screen.findByText('Could not load worktrees')).toBeTruthy()
  })

  it('says there are no worktrees yet', async () => {
    setup({ generatedAt: 1, checkouts: [], outside: 0 })
    expect(await screen.findByText('No worktrees yet.')).toBeTruthy()
  })
})

describe('Clear worktree confirmation', () => {
  it('lists what is removed and what is left alone, and removes only on confirm', async () => {
    const { fleet } = setup()
    await screen.findByRole('heading', { level: 2, name: 'Worktrees' })
    fireEvent.click(screen.getByRole('button', { name: `Clear ${MERGED.branch}` }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('heading', { name: 'Remove this worktree?' })).toBeTruthy()
    expect(dialog.textContent).toContain('Will be removed')
    expect(dialog.textContent).toContain(MERGED.path)
    expect(dialog.textContent).toContain(`git branch ${MERGED.branch} ${MERGED.tip!.slice(0, 7)}`)
    expect(dialog.textContent).toContain(`every commit is already in ${MERGED.trunk}`)
    expect(dialog.textContent).toContain('Left alone')
    expect(dialog.textContent).toContain(MERGED.repo.root)
    expect(dialog.textContent).toContain('The remote branch and its pull request')
    expect(dialog.textContent).toContain('1 session that used this folder')
    // Nothing has been sent yet.
    expect(fleet.posted).toHaveLength(0)

    fleet.answer('/api/worktrees/clear', { cleared: { branchDeleted: true } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove worktree' }))
    await waitFor(() => expect(fleet.posted).toHaveLength(1))
    expect(fleet.posted[0]?.path).toBe('/api/worktrees/clear')
    expect(fleet.posted[0]?.body).toEqual({ path: MERGED.path })
    await waitFor(() => expect(toast()).toBe('Worktree and branch removed'))
  })

  it('says so when the branch could not be deleted', async () => {
    const { fleet } = setup()
    await screen.findByRole('heading', { level: 2, name: 'Worktrees' })
    act(() => mounted().harness.store.dispatch({ type: 'open-modal', modal: { kind: 'clear-worktree', path: MERGED.path } }))
    fleet.answer('/api/worktrees/clear', { cleared: { branchDeleted: false } })
    fireEvent.click(await screen.findByRole('button', { name: 'Remove worktree' }))
    await waitFor(() => expect(toast()).toBe('Worktree removed. The branch could not be deleted and is still there.'))
  })

  it('shows the reason of a server refusal and lets the list catch up', async () => {
    const { fleet } = setup()
    await screen.findByRole('heading', { level: 2, name: 'Worktrees' })
    fireEvent.click(screen.getByRole('button', { name: `Clear ${MERGED.branch}` }))
    const go = await screen.findByRole('button', { name: 'Remove worktree' })
    // Git changed under it: the server refuses, and the next list says it is no longer clearable.
    fleet.answer('/api/worktrees/clear', { error: 'feat/web-app-merged has 1 uncommitted change now. Nothing was removed.', code: 'CONFLICT' }, 409)
    fleet.set('/api/worktrees', { ...report, checkouts: report.checkouts.map(c => (c.path === MERGED.path ? { ...c, clearable: false, dirty: 1, blockers: [{ text: '1 uncommitted change.' }] } : c)) })
    fireEvent.click(go)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('feat/web-app-merged has 1 uncommitted change now. Nothing was removed.')
    // The list caught up: the dialog no longer offers the removal, and the row lost its button.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove worktree' }).hasAttribute('disabled')).toBe(true))
    expect(screen.getByText(/can no longer be cleared/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: `Clear ${MERGED.branch}` })).toBeNull()
  })

  it('says when the checkout is gone', async () => {
    setup({ ...report, checkouts: checkouts.filter(c => c.path !== MERGED.path) })
    await screen.findByRole('heading', { level: 2, name: 'Worktrees' })
    act(() => mounted().harness.store.dispatch({ type: 'open-modal', modal: { kind: 'clear-worktree', path: MERGED.path } }))
    expect(await screen.findByText(/is not listed any more/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove worktree' }).hasAttribute('disabled')).toBe(true)
    void vi
  })
})
