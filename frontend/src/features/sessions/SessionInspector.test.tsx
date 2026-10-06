// The session inspector and its review strip against fleet-mixed (A01, F04, F30):
// external sessions show their latest request/response, linked work, environment and
// identity, context thresholds, archive and the resume command; a managed session
// gets the Feedback form on its PR strip, which posts through the message route.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Selection } from '../../app/state'
import type { ManagedId, TranscriptId } from '../../domain/ids'
import ciFailing from '../../test/fixtures/conversation-heavy/get-pr-status-open-ci-failing.json'
import mixedControl from '../../test/fixtures/fleet-mixed/get-control.json'
import mixedSessions from '../../test/fixtures/fleet-mixed/get-sessions.json'
import { SessionInspector } from '../inspector/SessionInspector'
import { bodyOf, fakeFleet, mount } from './testing'

type Row = Record<string, unknown>
const mixed = bodyOf<{ sessions: Row[] }>(mixedSessions)
const PR = 'https://github.com/example-org/web-app/pull/41'
const prStatus = (ciFailing.response.body as { status: unknown }).status

const external = (row: Row): Extract<Selection, { kind: 'external' }> => ({
  kind: 'external',
  engine: (row.engine as 'claude' | 'codex' | undefined) ?? 'claude',
  transcriptId: row.sessionId as TranscriptId,
  pid: null,
})

function boot(selection: Extract<Selection, { kind: 'managed' | 'external' }>, sessions: { sessions: Row[] } = mixed) {
  const fleet = fakeFleet({ control: mixedControl.response.body, sessions: { ...mixed, ...sessions }, prStatus: { [PR]: prStatus } })
  const view = mount(fleet, <SessionInspector selection={selection} />)
  return { fleet, ...view }
}

const checkout = mixed.sessions.find(row => row.name === 'checkout-refactor')!

const present = (id: string): HTMLElement => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`#${id} is not drawn yet`)
  return el
}

describe('SessionInspector', () => {
  it('shows an external session: latest response, linked work, environment, identity and the resume command', async () => {
    boot(external(checkout))
    const content = await waitFor(() => {
      const el = document.getElementById('detail-content')!
      expect(el.querySelector('.detail-head')).toBeTruthy()
      return el
    })
    expect(within(content).getByText(checkout.latestResponse as string)).toBeTruthy()
    expect(within(content).getByText('TECH-101').closest('a')!.getAttribute('href')).toBe('https://linear.app/team/issue/TECH-101/checkout')
    expect(within(content).getByText('PR #41').closest('a')!.getAttribute('rel')).toBe('noopener noreferrer')
    expect(within(content).getByText('Recorded references, not live status.')).toBeTruthy()
    const facts = [...content.querySelectorAll('.facts dt')].map(dt => [dt.textContent, dt.nextElementSibling?.textContent])
    expect(facts).toEqual([
      ['Project', '/fixture/repos/web-app'],
      ['Branch', 'feat/checkout'],
      ['Model', 'opus-fixture'],
      ['Permissions', 'Default'],
      ['Control', 'Terminal · monitor only'],
      ['Session', checkout.sessionId],
    ])
    expect(within(content).getByText('21%')).toBeTruthy()
    expect(within(content).getByRole('button', { name: 'Copy resume command' })).toBeTruthy()
    expect(within(content).getByRole('button', { name: 'Archive' })).toBeTruthy()
    // No context warning at 21%.
    expect(content.querySelector('.ui-callout')).toBeNull()
  })

  it('warns as the context fills, keeps unknown context unknown, and discloses a truncated transcript', async () => {
    const hot = { ...checkout, contextTokens: 185000, transcriptTruncated: true }
    const view = boot(external(hot), { sessions: mixed.sessions.map(row => (row === checkout ? hot : row)) })
    expect(await screen.findByText('Context nearly full')).toBeTruthy()
    expect(screen.getByText('Compaction may happen soon.')).toBeTruthy()
    expect(screen.getByText(/most recent 6 MB/)).toBeTruthy()
    view.unmount()

    const warm = { ...checkout, contextTokens: 160000 }
    const second = boot(external(warm), { sessions: mixed.sessions.map(row => (row === checkout ? warm : row)) })
    expect(await screen.findByText('Context is getting full')).toBeTruthy()
    second.unmount()

    const unknown = { ...checkout, contextTokens: null }
    boot(external(unknown), { sessions: mixed.sessions.map(row => (row === checkout ? unknown : row)) })
    expect(await screen.findByText('Not available')).toBeTruthy()
  })

  it('copies the resume command, and shows it when the clipboard refuses', async () => {
    boot(external(checkout))
    const button = await screen.findByRole('button', { name: 'Copy resume command' })
    const writes: string[] = []
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => void writes.push(text) } })
    await act(async () => fireEvent.click(button))
    expect(writes).toEqual([checkout.resumeCmd])
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => Promise.reject(new Error('no')) } })
    await act(async () => fireEvent.click(button))
    expect(await screen.findByText(checkout.resumeCmd as string, { selector: 'pre' })).toBeTruthy()
  })

  it('draws the PR strip with state and CI, failing checks in the tooltip, and no form for a terminal session', async () => {
    boot(external(checkout))
    const panel = await waitFor(() => present('review-panel'))
    const ci = await within(panel).findByText('CI failing')
    expect(ci.getAttribute('title')).toBe('Failing: build, lint')
    expect(within(panel).getByText('Open')).toBeTruthy()
    expect(within(panel).queryByRole('button', { name: 'Feedback' })).toBeNull()
  })

  it('a managed session gets the Feedback form; the CI preset fills the message and Send posts it', async () => {
    const managed = { ...mixed.sessions.find(row => row.managedId === 'm-claude-idle')!, links: [{ url: PR, kind: 'pr', label: 'PR #41' }] }
    const { fleet } = boot({ kind: 'managed', managedId: 'm-claude-idle' as ManagedId }, { sessions: mixed.sessions.map(row => (row.managedId === 'm-claude-idle' ? managed : row)) })
    const toggle = await screen.findByRole('button', { name: 'Feedback' })
    await screen.findByText('CI failing')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const quick = await screen.findByRole('button', { name: 'Send CI fix request' })
    expect(quick.hidden).toBe(false)
    await act(async () => fireEvent.click(quick))
    const post = fleet.posts.find(p => p.url === '/api/managed/m-claude-idle/messages')!
    expect(post.body.message).toBe('CI failed on build, lint (PR #41). Fix it and push.')
    expect(typeof post.body.requestId).toBe('string')
    expect(await screen.findByText('Feedback sent to this session.')).toBeTruthy()

    // An empty message sends nothing.
    const before = fleet.posts.length
    await act(async () => fireEvent.submit(document.getElementById('review-form')!))
    expect(fleet.posts.length).toBe(before)
  })

  it('archives and restores an external session', async () => {
    const { fleet } = boot(external(checkout))
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: 'Archive' })))
    expect(fleet.posts).toEqual([{ url: '/api/archive', body: { ids: [checkout.sessionId], archived: true } }])
    const archived = mixed.sessions.find(row => row.archived)!
    const view = boot(external(archived))
    expect(await view.findByText(/still resumable and still searchable/)).toBeTruthy()
    await act(async () => fireEvent.click(view.getByRole('button', { name: 'Restore' })))
    expect(view.fleet.posts).toEqual([{ url: '/api/archive', body: { ids: [archived.sessionId], archived: false } }])
  })

  it('never offers archive for a managed session: it is closed instead', async () => {
    boot({ kind: 'managed', managedId: 'm-claude-idle' as ManagedId })
    await waitFor(() => expect(document.querySelector('.detail-head')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Copy resume command' })).toBeNull()
    expect(screen.queryByText('Latest response')).toBeNull()
    expect([...document.querySelectorAll('.facts dd')].map(dd => dd.textContent)).toContain('Fleet-managed')
  })
})
