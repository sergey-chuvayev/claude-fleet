// A05 (F08): sessions started outside Fleet. A live Claude conversation is continued as
// a copy (a fork; the terminal's row is not merged into it), an offline one is taken
// over with its history, a live Codex session is refused without losing the draft,
// and an offline Codex one is resumed as Codex.
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { TranscriptId } from '../../domain/ids'
import forkFile from '../../test/fixtures/fleet-mixed/managed/m-fork-pending.json'
import sessionsFile from '../../test/fixtures/fleet-mixed/get-sessions.json'
import { jsonResponse, strip } from '../../test/fakes'
import { SessionDetail } from '../inspector/SessionDetail'
import { draftStoreFor } from '../composer/drafts'
import { type ConsoleFleet, consoleFleet, detailOf, mountConsole, postsTo } from '../session-header/testing'

const LIVE_CLAUDE = '000000c1-0000-4000-8000-000000000002' // api-review, open in its terminal, idle
const BUSY_CLAUDE = '000000c1-0000-4000-8000-000000000001' // checkout-refactor, working
const OFFLINE_CLAUDE = '000000c1-0000-4000-8000-000000000003'
const LIVE_CODEX = '000000c0-0000-4000-8000-000000000001'
const OFFLINE_CODEX = '000000c0-0000-4000-8000-000000000002'

const external = (engine: 'claude' | 'codex', id: string) => ({ kind: 'external', engine, transcriptId: id as TranscriptId, pid: null }) as const
const box = () => screen.getByRole('textbox', { name: 'Continue this conversation' }) as HTMLTextAreaElement
const button = () => document.getElementById('send-message') as HTMLButtonElement
const hint = () => document.getElementById('composer-hint')?.textContent

interface Row {
  sessionId?: string
  [key: string]: unknown
}
const rows = () => (strip(sessionsFile.response.body) as { sessions: Row[] }).sessions

let fleet: ConsoleFleet
beforeEach(() => {
  fleet = consoleFleet()
  fleet.sessions.set(strip(sessionsFile.response.body))
  for (const id of [LIVE_CLAUDE, BUSY_CLAUDE, OFFLINE_CLAUDE, LIVE_CODEX, OFFLINE_CODEX]) {
    fleet.history(id, { messages: [{ id: `${id}-u`, role: 'user', text: `Earlier prompt in ${id.slice(-1)}`, at: 1791270000000 }], truncated: false })
  }
  fleet.onPost = () => jsonResponse(detailOf(forkFile), 201)
})

describe('External sessions (A05)', () => {
  it('a live Claude session continues as a copy: fork, the copy is selected, the source row stays', async () => {
    const user = userEvent.setup()
    const mounted = mountConsole(fleet, <SessionDetail />, external('claude', LIVE_CLAUDE))
    expect(await screen.findByText('Earlier prompt in 2')).toBeTruthy()
    expect(document.getElementById('outside-state')?.textContent).toBe('Open in a terminal')
    expect(button().textContent).toBe('Continue a copy here ')
    expect(hint()).toBe('Sends to a copy in Fleet. The terminal keeps the original.')
    expect(box().placeholder).toBe('Continue a copy of this conversation…')
    await user.type(box(), 'pick up the review{Enter}')
    await waitFor(() => expect(mounted.store.getState().selection.sessions).toEqual({ kind: 'managed', managedId: 'm-fork-pending' }))
    const [post] = postsTo(fleet, '/api/managed')
    expect(post?.body).toEqual({
      cwd: '/fixture/repos/api-service',
      name: 'api-review',
      prompt: 'pick up the review',
      requestId: expect.any(String),
      resumeSessionId: LIVE_CLAUDE,
      fork: true,
    })
    expect(document.getElementById('toast')?.textContent).toBe('Continuing a copy in Fleet. The terminal keeps the original.')
    // The terminal's own row is untouched: nothing on the client merges it into the copy.
    const source = mounted.client.store.get(mounted.client.resources.sessions).data?.sessions.find(s => s.sessionId === LIVE_CLAUDE && !s.managedId)
    expect(source?.alive).toBe(true)
    expect(draftStoreFor(mounted.client).get(`claude:${LIVE_CLAUDE}`).text).toBe('')
  })

  it('an offline Claude session is taken over with its history, without a fork', async () => {
    const user = userEvent.setup()
    mountConsole(fleet, <SessionDetail />, external('claude', OFFLINE_CLAUDE))
    expect(await screen.findByText('Earlier prompt in 3')).toBeTruthy()
    expect(document.getElementById('outside-state')?.textContent).toBe('From a terminal · stopped')
    expect(button().textContent).toBe('Continue here ')
    expect(hint()).toBe('Your message continues this conversation in Fleet.')
    await user.type(box(), 'carry on{Enter}')
    await waitFor(() => expect(postsTo(fleet, '/api/managed')).toHaveLength(1))
    const body = postsTo(fleet, '/api/managed')[0]!.body
    expect(body).toMatchObject({ resumeSessionId: OFFLINE_CLAUDE, prompt: 'carry on', cwd: '/fixture/repos/docs-site' })
    expect(body).not.toHaveProperty('fork')
    expect(body).not.toHaveProperty('engine')
    expect(document.getElementById('toast')?.textContent).toBe('Continuing in Fleet')
  })

  it('a live Codex session is refused here, and a draft typed earlier is kept for later', async () => {
    const mounted = mountConsole(fleet, <SessionDetail />, external('codex', LIVE_CODEX))
    act(() => {
      draftStoreFor(mounted.client).edit(`codex:${LIVE_CODEX}`, { text: 'when you are done, add tests' })
    })
    expect(await screen.findByText('Earlier prompt in 1')).toBeTruthy()
    expect(document.getElementById('outside-state')?.textContent).toBe('Codex is working on it')
    expect(hint()).toBe('Codex is still working on this in its own window. Continue it here once it finishes.')
    expect(box().disabled).toBe(true)
    expect(button().disabled).toBe(true)
    expect(box().value).toBe('when you are done, add tests')
    expect(document.getElementById('now-line')?.textContent).toContain('Working in Codex')
    expect(fleet.posts).toEqual([])
  })

  it('an offline Codex session resumes as Codex; a refusal (it came back to life) keeps the draft', async () => {
    const user = userEvent.setup()
    fleet.onPost = () => jsonResponse({ error: 'Codex is still working on that session. Continue it here once it finishes.', code: 'UNSUPPORTED_ENGINE' }, 409)
    const mounted = mountConsole(fleet, <SessionDetail />, external('codex', OFFLINE_CODEX))
    expect(await screen.findByText('Earlier prompt in 2')).toBeTruthy()
    expect(document.getElementById('outside-state')?.textContent).toBe('From Codex · stopped')
    expect(hint()).toBe('Your message continues this Codex conversation in Fleet.')
    await user.type(box(), 'rewrite the intro{Enter}')
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Codex is still working on that session. Continue it here once it finishes.')
    expect(postsTo(fleet, '/api/managed')[0]?.body).toMatchObject({ engine: 'codex', resumeSessionId: OFFLINE_CODEX, prompt: 'rewrite the intro' })
    expect(postsTo(fleet, '/api/managed')[0]?.body).not.toHaveProperty('fork')
    expect(box().value).toBe('rewrite the intro')
    expect(mounted.store.getState().selection.sessions).toEqual(external('codex', OFFLINE_CODEX))
  })

  it('a working terminal session shows the step it runs', async () => {
    const list = rows().map(r =>
      r.sessionId === BUSY_CLAUDE && !r.managedId ? { ...r, turn: { steps: [], turnStartedAt: 1791280710000, current: { t: 'Write', target: 'refund.test.ts', at: 1791280740000 } } } : r,
    )
    fleet.sessions.set({ ...(strip(sessionsFile.response.body) as object), sessions: list })
    mountConsole(fleet, <SessionDetail />, external('claude', BUSY_CLAUDE))
    await waitFor(() => expect(document.querySelector('#now-line .now-text')?.textContent).toBe('Running Write · refund.test.ts'))
    expect(document.getElementById('outside-state')?.textContent).toBe('Working in a terminal')
  })
})
