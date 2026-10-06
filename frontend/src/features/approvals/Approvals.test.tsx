// A10 (F13), a hard gate: partly answer a multiple-choice question and its free text,
// let an unrelated refresh arrive, and the picks, the text and the focus are all still
// there. Allow once and deny are sent once each; a stale approval (409) is explained
// and the session read again; nothing is ever answered without a click, also not after
// a restart.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ManagedId } from '../../domain/ids'
import heavyFile from '../../test/fixtures/conversation-heavy/managed/c-heavy.json'
import staleFile from '../../test/fixtures/conversation-heavy/post-approval-stale.json'
import { jsonResponse } from '../../test/fakes'
import type { DetailBody } from '../conversation/testing'
import { SessionDetail } from '../inspector/SessionDetail'
import { type ConsoleFleet, choose, consoleFleet, detailOf, mountConsole, postsTo, refreshManaged } from '../session-header/testing'

const managed = (id: string) => ({ kind: 'managed', managedId: id as ManagedId }) as const
const heavy = () => detailOf(heavyFile)
const withSession = (detail: DetailBody, patch: Record<string, unknown>): DetailBody => ({ ...detail, session: { ...detail.session, ...patch } })
const card = (id: string) => document.querySelector<HTMLFormElement>(`form[data-approval="${id}"]`)!

let fleet: ConsoleFleet
beforeEach(() => {
  fleet = consoleFleet()
  fleet.update('c-heavy', heavy())
})

/** The server streams on: one more assistant message, the approvals unchanged. */
function streamOn(detail: DetailBody, n: number): DetailBody {
  const extra = { id: `stream-${n}`, role: 'assistant', text: `still working ${n}`, at: 1791280799000 + n }
  return withSession(detail, { messages: [...detail.session.messages, extra], updatedAt: 1791280800000 + n })
}

describe('Approvals (A10)', () => {
  it('shows the tool, its input and reason, and the question with its options', async () => {
    mountConsole(fleet, <SessionDetail />, managed('c-heavy'))
    await waitFor(() => expect(card('ap-current')).toBeTruthy())
    const tool = within(card('ap-current'))
    expect(tool.getByText('APPROVAL REQUIRED')).toBeTruthy()
    expect(tool.getByRole('heading', { name: 'Force push the branch' })).toBeTruthy()
    expect(tool.getByText('Force pushes')).toBeTruthy()
    expect(card('ap-current').querySelector('.tool-input')?.textContent).toBe('{\n  "command": "git push --force origin feat/checkout"\n}')
    const ask = within(card('ap-ask'))
    expect(ask.getByText('CLAUDE HAS A QUESTION')).toBeTruthy()
    expect(ask.getAllByRole('radio').map(r => (r as HTMLInputElement).value)).toEqual(['vitest', 'jest'])
    expect(ask.getAllByRole('checkbox').map(r => (r as HTMLInputElement).value)).toEqual(['unit', 'e2e'])
    expect(ask.getByRole('button', { name: 'Skip question' })).toBeTruthy()
  })

  it('names the role that asked inside an initiative', async () => {
    const detail = heavy()
    const approvals = (detail.session.approvals as Array<Record<string, unknown>>).map(a => (a.id === 'ap-current' ? { ...a, role: 'developer' } : a))
    fleet.update('c-heavy', withSession(detail, { approvals }))
    mountConsole(fleet, <SessionDetail />, managed('c-heavy'))
    await waitFor(() => expect(card('ap-current')?.querySelector('.eyebrow')?.textContent).toBe('APPROVAL REQUIRED · DEVELOPER'))
  })

  it('keeps picks, typed text and focus through unrelated refreshes, and a switch away and back', async () => {
    const user = userEvent.setup()
    const mounted = mountConsole(fleet, <SessionDetail />, managed('c-heavy'))
    await waitFor(() => expect(card('ap-ask')).toBeTruthy())
    const ask = within(card('ap-ask'))
    await user.click(ask.getByRole('radio', { name: /jest/ }))
    await user.click(ask.getByRole('checkbox', { name: /e2e/ }))
    const other = ask.getAllByRole('textbox')[0] as HTMLInputElement
    await user.type(other, 'vitest, with jsd')
    const before = other
    for (let n = 1; n <= 3; n++) {
      fleet.update('c-heavy', streamOn(fleet.held('c-heavy')!, n))
      await refreshManaged(mounted, 'c-heavy')
    }
    await waitFor(() => expect(screen.getByText('still working 3')).toBeTruthy())
    const again = within(card('ap-ask'))
    expect(again.getAllByRole('textbox')[0]).toBe(before)
    expect(document.activeElement).toBe(before)
    expect((again.getAllByRole('textbox')[0] as HTMLInputElement).value).toBe('vitest, with jsd')
    expect((again.getByRole('radio', { name: /jest/ }) as HTMLInputElement).checked).toBe(true)
    expect((again.getByRole('checkbox', { name: /e2e/ }) as HTMLInputElement).checked).toBe(true)
    await user.type(before, 'om')
    expect(before.value).toBe('vitest, with jsdom')

    // Away and back: the answer draft is the session's, not the component's.
    fleet.update('c-other', withSession(heavy(), { id: 'c-other', approvals: [], name: 'Other' }))
    await choose(mounted, managed('c-other'))
    await waitFor(() => expect(card('ap-ask')).toBeNull())
    await choose(mounted, managed('c-heavy'))
    await waitFor(() => expect(card('ap-ask')).toBeTruthy())
    expect((within(card('ap-ask')).getAllByRole('textbox')[0] as HTMLInputElement).value).toBe('vitest, with jsdom')
    expect((within(card('ap-ask')).getByRole('radio', { name: /jest/ }) as HTMLInputElement).checked).toBe(true)
    expect(fleet.posts).toEqual([])
  })

  it('sends the answers keyed by question: typed text wins, picks are joined', async () => {
    const user = userEvent.setup()
    fleet.onPost = (_post, self) => {
      const next = withSession(self.held('c-heavy')!, { approvals: [(self.held('c-heavy')!.session.approvals as unknown[])[0]] })
      self.update('c-heavy', next)
      return jsonResponse(next)
    }
    mountConsole(fleet, <SessionDetail />, managed('c-heavy'))
    await waitFor(() => expect(card('ap-ask')).toBeTruthy())
    const ask = within(card('ap-ask'))
    await user.click(ask.getByRole('button', { name: 'Send answer' }))
    expect(ask.getByRole('alert').textContent).toBe('Answer each question before continuing.')
    expect(fleet.posts).toEqual([])
    await user.click(ask.getByRole('radio', { name: /vitest/ }))
    await user.click(ask.getByRole('checkbox', { name: /unit/ }))
    await user.click(ask.getByRole('checkbox', { name: /e2e/ }))
    await user.type(ask.getAllByRole('textbox')[0]!, '  ')
    await user.click(ask.getByRole('button', { name: 'Send answer' }))
    await waitFor(() => expect(card('ap-ask')).toBeNull())
    expect(postsTo(fleet, '/approvals/ap-ask')).toEqual([
      {
        path: '/api/managed/c-heavy/approvals/ap-ask',
        body: { decision: 'allow', answers: { 'Which test runner should I use?': 'vitest', 'Which areas to cover?': 'unit, e2e' } },
      },
    ])
  })

  it('allow once and deny each send exactly one decision', async () => {
    const user = userEvent.setup()
    fleet.onPost = (post, self) => {
      const id = post.path.split('/').at(-1)
      const approvals = (self.held('c-heavy')!.session.approvals as Array<{ id: string }>).filter(a => a.id !== id)
      const next = withSession(self.held('c-heavy')!, { approvals })
      self.update('c-heavy', next)
      return jsonResponse(next)
    }
    mountConsole(fleet, <SessionDetail />, managed('c-heavy'))
    await waitFor(() => expect(card('ap-current')).toBeTruthy())
    const allow = within(card('ap-current')).getByRole('button', { name: 'Allow once' })
    await user.dblClick(allow)
    await waitFor(() => expect(card('ap-current')).toBeNull())
    await user.click(within(card('ap-ask')).getByRole('button', { name: 'Skip question' }))
    await waitFor(() => expect(card('ap-ask')).toBeNull())
    expect(fleet.posts).toEqual([
      { path: '/api/managed/c-heavy/approvals/ap-current', body: { decision: 'allow' } },
      { path: '/api/managed/c-heavy/approvals/ap-ask', body: { decision: 'deny' } },
    ])
  })

  it('a stale approval (409) is explained, the session read again, and nothing is resent', async () => {
    const user = userEvent.setup()
    fleet.onPost = (_post, self) => {
      // Answered elsewhere: the server no longer has it.
      self.update('c-heavy', withSession(self.held('c-heavy')!, { approvals: [(self.held('c-heavy')!.session.approvals as unknown[])[1]] }))
      return jsonResponse(staleFile.response.body, staleFile.response.status)
    }
    mountConsole(fleet, <SessionDetail />, managed('c-heavy'))
    await waitFor(() => expect(card('ap-current')).toBeTruthy())
    const reads = () => fleet.requests.filter(r => r === '/api/managed/c-heavy').length
    const before = reads()
    await user.click(within(card('ap-current')).getByRole('button', { name: 'Allow once' }))
    await waitFor(() => expect(document.getElementById('toast')?.textContent).toMatch(/^This request is no longer waiting/))
    await waitFor(() => expect(card('ap-current')).toBeNull())
    expect(reads()).toBeGreaterThan(before)
    expect(postsTo(fleet, '/approvals/ap-current')).toHaveLength(1)
    expect(card('ap-ask')).toBeTruthy()
  })

  it('a refusal for another reason stays on the card and the buttons work again', async () => {
    const user = userEvent.setup()
    fleet.onPost = () => jsonResponse({ error: 'Answer must contain 1 to 4000 characters.', code: 'VALIDATION' }, 400)
    mountConsole(fleet, <SessionDetail />, managed('c-heavy'))
    await waitFor(() => expect(card('ap-current')).toBeTruthy())
    await user.click(within(card('ap-current')).getByRole('button', { name: 'Allow once' }))
    await waitFor(() => expect(within(card('ap-current')).getByRole('alert').textContent).toBe('Answer must contain 1 to 4000 characters.'))
    expect((within(card('ap-current')).getByRole('button', { name: 'Allow once' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('a restart (new control, the session read again) never answers on its own', async () => {
    const mounted = mountConsole(fleet, <SessionDetail />, managed('c-heavy'))
    await waitFor(() => expect(card('ap-ask')).toBeTruthy())
    fireEvent.click(within(card('ap-ask')).getByRole('radio', { name: /vitest/ }))
    await act(async () => {
      mounted.client.store.forgetConditional()
      await mounted.client.store.refresh(mounted.client.resources.control)
    })
    await refreshManaged(mounted, 'c-heavy')
    expect(fleet.posts).toEqual([])
    expect((within(card('ap-ask')).getByRole('radio', { name: /vitest/ }) as HTMLInputElement).checked).toBe(true)
  })
})
