// A18: the search dialog against a fake Fleet. Keyword hits first, the answer by
// polling, cited order, a late answer for an older search never replacing the current
// one, Open in Fleet through the app's actions, resume command for a session that is
// not open, and failures that keep the keyword hits.
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import searchJob from '../../test/fixtures/fleet-mixed/get-search-job.json'
import postSearch from '../../test/fixtures/fleet-mixed/post-search.json'
import { deferred, jsonResponse } from '../../test/fakes'
import { type Fleet, fakeFleet, mount, unmountAll } from '../settings/testing'
import { SearchDialog } from './SearchDialog'

const thinking = postSearch.response.body.job
const done = searchJob.response.body.job
const LIVE = '000000c1-0000-4000-8000-000000000001'
const GONE = '99999999-0000-4000-8000-000000000009'

const hit = (sessionId: string, title: string) => ({
  sessionId,
  title,
  cwd: '/fixture/repos/web-app',
  project: 'web-app',
  firstAt: 1791280620000,
  lastAt: 1791280740000,
  matches: 2,
  snippets: [
    { role: 'user', text: `question about ${title}` },
    { role: 'assistant', text: `answer about ${title}` },
  ],
})

function open(fleet: Fleet) {
  const onClose = vi.fn()
  const view = mount(fleet, <SearchDialog modal={{ kind: 'search' }} onClose={onClose} />)
  return { ...view, onClose }
}

const ask = async (text: string) => {
  const input = screen.getByLabelText('Search all sessions')
  await userEvent.clear(input)
  await userEvent.type(input, text)
  await userEvent.click(screen.getByRole('button', { name: /^Search/ }))
}

afterEach(unmountAll)

describe('SearchDialog', () => {
  it('opens on the input with the three suggestions, which fill it', async () => {
    open(fakeFleet())
    expect(document.activeElement).toBe(screen.getByLabelText('Search all sessions'))
    expect(document.getElementById('ask-backdrop')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /Find that fix/ }))
    expect((screen.getByLabelText('Search all sessions') as HTMLInputElement).value).toBe('How did we fix ')
    expect(document.activeElement).toBe(screen.getByLabelText('Search all sessions'))
  })

  it('shows keyword hits at once, then the answer in the order Claude cited, folding the rest', async () => {
    const fleet = fakeFleet()
    const hits = [hit(GONE, 'Uncited thread'), hit(LIVE, 'Cited second'), hit('77777777-0000-4000-8000-000000000007', 'Cited first')]
    fleet.json('POST', '/api/search', { job: { ...thinking, hits, question: 'checkout' } }, 201)
    fleet.json('GET', `/api/search/${thinking.id}`, {
      job: {
        ...done,
        question: 'checkout',
        hits,
        ai: {
          answer: 'We chose the hosted checkout.',
          matches: [
            { sessionId: '77777777-0000-4000-8000-000000000007', relevance: 'high', context: 'Decided here.', quote: 'hosted it is' },
            { sessionId: LIVE, relevance: 'low', context: null, quote: null },
          ],
        },
      },
    })
    open(fleet)
    await ask('checkout')

    // Keyword hits and the thinking status come first.
    expect(await screen.findByText('Uncited thread')).toBeTruthy()
    expect(screen.getByText(/Reading the 3 best matches with haiku/)).toBeTruthy()
    expect(fleet.to('POST', '/api/search')[0]?.body).toEqual({ question: 'checkout', model: 'haiku' })
    expect(document.getElementById('ask-results')?.getAttribute('aria-busy')).toBe('true')

    // The answer arrives by polling (about 700 ms).
    await screen.findByText('We chose the hosted checkout.', {}, { timeout: 3000 })
    const titles = [...document.querySelectorAll('.ask-hit-title')].map(el => el.textContent)
    expect(titles).toEqual(['Cited first', 'Cited second', 'Uncited thread'])
    const cards = document.querySelectorAll('.ask-hit')
    expect(cards[0]?.getAttribute('data-relevance')).toBe('high')
    expect(within(cards[0] as HTMLElement).getByText('strong match')).toBeTruthy()
    expect(within(cards[0] as HTMLElement).getByText('hosted it is')).toBeTruthy()
    expect(within(cards[1] as HTMLElement).getByText('loosely related')).toBeTruthy()
    const rest = document.querySelector('.ask-rest') as HTMLElement
    expect(rest.querySelector('summary')?.textContent).toBe('1 other keyword match Claude did not find relevant')
    expect(rest.querySelector('.ask-hit-title')?.textContent).toBe('Uncited thread')
    expect(document.getElementById('ask-results')?.getAttribute('aria-busy')).toBe('false')
    expect(document.querySelector('.ask-stats')?.textContent).toBe('10 sessions · 20 passages · 0 ms')
  }, 8000)

  it('keeps the newest search when an older answer arrives late (A then B, A resolves last)', async () => {
    const fleet = fakeFleet()
    const first = deferred<Response>()
    let count = 0
    fleet.on('POST', '/api/search', () => {
      count++
      if (count === 1) return first.promise
      return jsonResponse({ job: { ...done, id: 'job-b', question: 'second', hits: [hit(GONE, 'From B')], ai: null, status: 'done' } }, 201)
    })
    open(fleet)
    await ask('first')
    // The first request is still out; the operator searches again.
    await ask('second')
    expect(await screen.findByText('From B')).toBeTruthy()

    first.resolve(jsonResponse({ job: { ...done, id: 'job-a', question: 'first', hits: [hit(LIVE, 'From A')], ai: null, status: 'done' } }, 201))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(screen.queryByText('From A')).toBeNull()
    expect(screen.getByText('From B')).toBeTruthy()
    expect(screen.getByText('“second”')).toBeTruthy()
  })

  it('does not let a poll for an older job replace the current job', async () => {
    const fleet = fakeFleet()
    const poll = deferred<Response>()
    let count = 0
    fleet.on('POST', '/api/search', () => {
      count++
      return jsonResponse(
        { job: { ...thinking, id: count === 1 ? 'job-a' : 'job-b', question: count === 1 ? 'first' : 'second', hits: [hit(GONE, count === 1 ? 'A hit' : 'B hit')] } },
        201,
      )
    })
    fleet.on('GET', '/api/search/job-a', () => poll.promise)
    fleet.json('GET', '/api/search/job-b', { job: { ...thinking, id: 'job-b', question: 'second', hits: [hit(GONE, 'B hit')] } })
    open(fleet)
    await ask('first')
    await screen.findByText('A hit')
    await waitFor(() => expect(fleet.to('GET', '/api/search/job-a').length).toBe(1), { timeout: 3000 })
    await ask('second')
    await screen.findByText('B hit')
    poll.resolve(jsonResponse({ job: { ...done, id: 'job-a', question: 'first', hits: [hit(GONE, 'A answered')], ai: null } }))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(screen.queryByText('A answered')).toBeNull()
    expect(screen.getByText('“second”')).toBeTruthy()
  }, 8000)

  it('says what went wrong when the search cannot start, and keeps the form usable', async () => {
    const fleet = fakeFleet()
    fleet.json('POST', '/api/search', { error: 'Ask a question of 1–500 characters.', code: 'VALIDATION' }, 400)
    open(fleet)
    await ask('x')
    expect((await screen.findByText('Ask a question of 1–500 characters.')).className).toContain('is-failed')
    expect((screen.getByRole('button', { name: /^Search/ }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('keeps keyword hits when the answer fails, and says so', async () => {
    const fleet = fakeFleet()
    fleet.json('POST', '/api/search', { job: { ...thinking, hits: [hit(GONE, 'Kept hit')] } }, 201)
    fleet.json('GET', `/api/search/${thinking.id}`, {
      job: { ...thinking, status: 'error', error: 'The model is unavailable.', hits: [hit(GONE, 'Kept hit')] },
    })
    open(fleet)
    await ask('anything')
    await screen.findByText('The model is unavailable. Keyword matches are still shown below.', {}, { timeout: 3000 })
    expect(screen.getByText('Kept hit')).toBeTruthy()
    // Polling has stopped.
    const polls = fleet.to('GET', /^\/api\/search\//).length
    await new Promise(resolve => setTimeout(resolve, 900))
    expect(fleet.to('GET', /^\/api\/search\//).length).toBe(polls)
  }, 8000)

  it('explains an empty search and a replaced one', async () => {
    const fleet = fakeFleet()
    fleet.json('POST', '/api/search', { job: { ...done, hits: [], ai: null, status: 'done' } }, 201)
    open(fleet)
    await ask('nothing')
    expect(await screen.findByText(/No matching threads yet/)).toBeTruthy()

    fleet.json('POST', '/api/search', { job: { ...done, id: 'old', hits: [], ai: null, status: 'stopped', error: null } }, 201)
    await ask('again')
    expect(await screen.findByText('Replaced by a newer search.')).toBeTruthy()
  })

  it('Open in Fleet goes through the app actions: Sessions view, the session selected, dialog closed', async () => {
    const fleet = fakeFleet()
    fleet.json('POST', '/api/search', { job: { ...done, hits: [hit(LIVE, 'Live thread')], ai: null } }, 201)
    const { harness } = open(fleet)
    harness.store.dispatch({ type: 'navigate', view: 'projects' })
    harness.store.dispatch({ type: 'open-modal', modal: { kind: 'search' } })
    await ask('checkout')
    const card = (await screen.findByText('Live thread')).closest('.ask-hit') as HTMLElement
    expect(within(card).getByText('open now')).toBeTruthy()
    await userEvent.click(within(card).getByRole('button', { name: /Open in Fleet/ }))

    const state = harness.store.getState()
    expect(state.view).toBe('sessions')
    expect(state.modal).toBeNull()
    expect(state.selection.sessions).toMatchObject({ kind: 'external', transcriptId: LIVE })
  })

  it('offers the resume command for a session that is not open, never a broken link', async () => {
    const written: string[] = []
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => void written.push(text) } })
    const fleet = fakeFleet()
    fleet.json('POST', '/api/search', { job: { ...done, hits: [hit(GONE, 'Closed thread')], ai: null } }, 201)
    open(fleet)
    await ask('closed')
    const card = (await screen.findByText('Closed thread')).closest('.ask-hit') as HTMLElement
    expect(within(card).queryByRole('button', { name: /Open in Fleet/ })).toBeNull()
    fireEvent.click(within(card).getByRole('button', { name: 'Copy resume command' }))
    await waitFor(() => expect(written).toEqual([`claude --resume ${GONE}`]))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('stops polling when the dialog closes', async () => {
    const fleet = fakeFleet()
    fleet.json('POST', '/api/search', { job: { ...thinking, hits: [hit(GONE, 'Hit')] } }, 201)
    fleet.json('GET', `/api/search/${thinking.id}`, { job: { ...thinking, hits: [hit(GONE, 'Hit')] } })
    const { unmount } = open(fleet)
    await ask('x')
    await waitFor(() => expect(fleet.to('GET', /^\/api\/search\//).length).toBeGreaterThan(0), { timeout: 3000 })
    unmount()
    const seen = fleet.to('GET', /^\/api\/search\//).length
    await new Promise(resolve => setTimeout(resolve, 1600))
    expect(fleet.to('GET', /^\/api\/search\//).length).toBe(seen)
  }, 8000)
})
