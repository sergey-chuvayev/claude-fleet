// A17: the weekly report as the server computes it (progress.js): totals match the
// server's counts, rows are bounded, linked PRs count once, and "shipped" is never
// presented as a verified merge.
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import shippedFixture from '../../test/fixtures/day-full/get-progress-after.json'
import ranFixture from '../../test/fixtures/fleet-mixed/get-progress.json'
import { fakeFleet, mount, unmount } from '../projects/testing'
import { ProgressPage } from './ProgressPage'

const shipped = shippedFixture.response.body
const ran = ranFixture.response.body

const mountPage = (body: unknown) => {
  const fleet = fakeFleet()
  fleet.set('/api/progress', body)
  const view = mount(
    <section id="progress-pane">
      <ProgressPage />
    </section>,
    fleet,
  )
  return { fleet, view }
}
const strip = () => document.querySelector('.page-strip')!
const section = (title: string) => screen.getByText(title, { selector: 'h4' }).closest('section')!

afterEach(unmount)

describe('Progress page', () => {
  it('reads the server totals and rows, and says shipped is not a merge check', async () => {
    mountPage(shipped)
    expect(await screen.findByRole('heading', { level: 2, name: 'Progress' })).toBeTruthy()
    expect(strip().textContent).toContain(`Shipped${shipped.shipped.count}`)
    expect(strip().textContent).toContain(`PRs${shipped.shipped.prs}`)
    expect(strip().textContent).toContain('Stalled0')
    expect(strip().textContent).toContain(`Ran${shipped.ran.count}`)

    const shippedSection = section('Shipped')
    expect(shippedSection.querySelector('.ui-count')?.textContent).toBe(String(shipped.shipped.count))
    expect(shippedSection.textContent).toContain('Done on your Day; Fleet does not check GitHub for merges')
    // The rows are what the server returned (it bounds them), each a done item.
    expect(shippedSection.querySelectorAll('li.ui-row')).toHaveLength(shipped.shipped.items.length)
    expect(shippedSection.querySelector('li.ui-row')?.getAttribute('data-tone')).toBe('done')
    // Linked PRs are labelled owner/repo#number and open in the browser.
    const link = shippedSection.querySelector<HTMLAnchorElement>('a[href^="https://github.com/"]')!
    expect(link.textContent).toMatch(/^[\w.-]+\/[\w.-]+#\d+/)
    expect(link.rel).toBe('noopener noreferrer')

    expect(within(section('Stalled')).getByText('Nothing stalled.')).toBeTruthy()
    expect(section('Stalled').textContent).toContain('No open item or running session has gone 3 days without moving.')
    expect(within(section('Ran')).getAllByText('finished').length).toBeGreaterThan(0)
  })

  it('shows the outcomes of what ran, and the counts beyond the returned rows', async () => {
    mountPage({
      ...ran,
      shipped: { items: [], count: 0, prs: 0 },
      stalled: {
        items: [
          { id: 'i1', kind: 'item', title: 'Old plan', status: 'waiting_on_you', projectId: null, lastMoved: Date.now() - 5 * 86_400_000 },
          { id: 's1', kind: 'session', title: 'Stuck agent', status: 'running', projectId: null, lastMoved: Date.now() - 9 * 86_400_000 },
        ],
        // More than the rows shown: the count is the truth, the rows are bounded.
        count: 61,
      },
    })
    await screen.findByRole('heading', { level: 2, name: 'Progress' })
    expect(within(section('Shipped')).getByText('Nothing shipped yet.')).toBeTruthy()
    expect(strip().textContent).toContain('Stalled61')
    const stalled = section('Stalled')
    expect(stalled.querySelector('.ui-count')?.textContent).toBe('61')
    expect(stalled.querySelectorAll('li.ui-row')).toHaveLength(2)
    expect(stalled.textContent).toContain('Item · waiting on you · no movement 5 days ago')
    expect(stalled.textContent).toContain('Session · running · no movement 9 days ago')
    const ranSection = section('Ran')
    expect(ranSection.textContent).toContain('3 running · 1 needs you · 1 queued · 4 finished · 1 failed · 1 stopped')
    expect(ranSection.querySelectorAll('li.ui-row')).toHaveLength(ran.ran.sessions.length)
  })

  it('refreshes on demand, keeps the last report when a refresh fails, and says so', async () => {
    const { fleet, view } = mountPage(shipped)
    await screen.findByRole('heading', { level: 2, name: 'Progress' })
    const reads = () => fleet.requests.filter(url => url === '/api/progress').length
    expect(reads()).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }))
    await waitFor(() => expect(reads()).toBe(2))

    // Hide the route: the report stays, with a note, not a blank page.
    fleet.set('/api/progress', undefined)
    const original = fleet.fetch
    const failing: typeof fleet.fetch = async (url, init) =>
      url === '/api/progress' ? new Response(JSON.stringify({ error: 'Down.' }), { status: 500, headers: { 'content-type': 'application/json' } }) : original(url, init)
    ;(globalThis as { fetch: unknown }).fetch = failing
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }))
    expect(await screen.findByText('Showing the last report; refreshing failed.')).toBeTruthy()
    expect(strip().textContent).toContain(`Shipped${shipped.shipped.count}`)
    void view
  })

  it('says loading, then explains a failed first load', async () => {
    const fleet = fakeFleet()
    mount(<ProgressPage />, fleet)
    expect(screen.getByText('Reading your week…')).toBeTruthy()
    expect(await screen.findByText('Could not load progress')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Refresh/ })).toBeTruthy()
  })
})
