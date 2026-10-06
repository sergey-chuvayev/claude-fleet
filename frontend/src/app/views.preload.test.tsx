// Performance gate (cold startup), found by frontend/e2e/journeys/perf.mjs: the first
// view suspended on its lazy chunk, and React 19 holds a Suspense reveal back for up
// to 300 ms after a fallback, so the conversation appeared ~300 ms after its data.
// A preloaded view renders on the first commit; one not yet loaded still suspends.
import { act, render, screen } from '@testing-library/react'
import { Suspense } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '../test/fakes'
import { Providers, makeHarness } from '../test/shell'
import { VIEW_DEFINITIONS, preloadView } from './views'

afterEach(() => vi.unstubAllGlobals())

function mount(Part: (typeof VIEW_DEFINITIONS)['progress']['Pane']) {
  const fetch = async () => jsonResponse({ error: 'Not found.', code: 'NOT_FOUND' }, 404)
  vi.stubGlobal('fetch', fetch)
  const harness = makeHarness(fetch)
  return render(
    <Providers harness={harness}>
      <Suspense fallback={<p>still loading</p>}>
        <Part />
      </Suspense>
    </Providers>,
  )
}

describe('view preloading', () => {
  it('a preloaded view draws on the first commit, without a fallback', async () => {
    await preloadView('progress')
    act(() => {
      mount(VIEW_DEFINITIONS.progress.Pane)
    })
    expect(screen.queryByText('still loading')).toBeNull()
  })

  it('a view whose code is not in yet still suspends, then draws', async () => {
    act(() => {
      mount(VIEW_DEFINITIONS.worktrees.Pane)
    })
    expect(screen.getByText('still loading')).toBeTruthy()
    await vi.waitFor(() => expect(screen.queryByText('still loading')).toBeNull())
  })

  it('preloading twice loads once', async () => {
    const first = VIEW_DEFINITIONS.today.Pane.preload()
    expect(VIEW_DEFINITIONS.today.Pane.preload()).toBe(first)
    await first
  })
})
