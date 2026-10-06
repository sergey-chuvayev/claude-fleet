// A28: mount, switch and unmount the whole app 100 times in StrictMode while the
// fixture server streams events, then count what is left: one EventSource for the
// page, no listener, interval, long timer, observer or animation-frame loop left
// running, and caches that stay bounded however many sessions come and go.
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShell } from '../app/AppShell'
import type { View } from '../app/state'
import { FakeEventSource } from '../test/fakes'
import { Providers } from '../test/shell'
import { keys } from '../transport/resources'
import { appFleet, makeAppHarness } from './appFleet'

const VIEWS: View[] = ['sessions', 'today', 'projects', 'progress', 'worktrees']
const MANAGED = ['m-claude-approval', 'm-claude-idle', 'm-claude-running', 'm-codex-idle', 'm-codex-running', 'm-claude-error', 'm-claude-queued', 'm-held', 'm-tagged', 'm-fork-pending', 'm-claude-stopped']

/** Everything that can outlive a component: listeners, timers, observers, frames. */
function instrument() {
  const listeners = new Map<string, number>()
  for (const [target, label] of [
    [document, 'document'],
    [window, 'window'],
  ] as const) {
    const add = target.addEventListener.bind(target)
    const remove = target.removeEventListener.bind(target)
    vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
      listeners.set(`${label}:${type}`, (listeners.get(`${label}:${type}`) ?? 0) + 1)
      add(type, listener, options)
    })
    vi.spyOn(target, 'removeEventListener').mockImplementation((type, listener, options) => {
      listeners.set(`${label}:${type}`, (listeners.get(`${label}:${type}`) ?? 0) - 1)
      remove(type, listener, options)
    })
  }

  // Intervals, and timeouts of a second or more (polling, retries): React's own
  // scheduling uses zero-delay timeouts and is not the app's to clean up.
  const intervals = new Set<unknown>()
  const longTimers = new Map<unknown, number>()
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  vi.stubGlobal('setInterval', ((fn: () => void, ms?: number, ...rest: unknown[]) => {
    const id = realSetInterval(fn, ms, ...rest)
    intervals.add(id)
    return id
  }) as typeof setInterval)
  vi.stubGlobal('clearInterval', ((id: Parameters<typeof clearInterval>[0]) => {
    intervals.delete(id)
    realClearInterval(id)
  }) as typeof clearInterval)
  vi.stubGlobal('setTimeout', ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    let id: unknown
    const wrapped = (...a: unknown[]) => {
      longTimers.delete(id)
      fn(...a)
    }
    id = realSetTimeout(wrapped, ms, ...rest)
    if ((ms ?? 0) >= 1000) longTimers.set(id, ms ?? 0)
    return id
  }) as typeof setTimeout)
  vi.stubGlobal('clearTimeout', ((id: Parameters<typeof clearTimeout>[0]) => {
    longTimers.delete(id)
    realClearTimeout(id)
  }) as typeof clearTimeout)

  // Observers jsdom lacks, so the code paths that use them run here, and counted.
  const observers = { live: 0, made: 0 }
  class CountingObserver {
    private active = true
    constructor(_callback: unknown) {
      observers.live++
      observers.made++
    }
    observe() {}
    unobserve() {}
    takeRecords() {
      return []
    }
    disconnect() {
      if (this.active) observers.live--
      this.active = false
    }
  }
  vi.stubGlobal('ResizeObserver', CountingObserver)
  vi.stubGlobal('IntersectionObserver', CountingObserver)

  const urls = { live: 0 }
  vi.stubGlobal('URL', Object.assign(URL, {
    createObjectURL: () => {
      urls.live++
      return `blob:fixture/${urls.live}`
    },
    revokeObjectURL: () => {
      urls.live--
    },
  }))

  let frames = 0
  const realFrame = globalThis.requestAnimationFrame?.bind(globalThis)
  if (realFrame) {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames++
      return realFrame(cb)
    })
  }
  return {
    listeners,
    leaked: () => [...listeners].filter(([, n]) => n !== 0),
    intervals,
    longTimers,
    observers,
    urls,
    frames: () => frames,
  }
}

const entries = (store: unknown): Map<string, unknown> => (store as { entries: Map<string, unknown> }).entries

let probe: ReturnType<typeof instrument>
beforeEach(() => {
  probe = instrument()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('A28 lifecycle, 100 cycles in StrictMode', () => {
  it('leaves one stream and nothing running after 100 mount, switch and unmount cycles', { timeout: 120_000 }, async () => {
    const fleet = appFleet()
    const { harness } = makeAppHarness(fleet)
    harness.client.start()
    const stream = FakeEventSource.instances[0]!
    act(() => stream.open())
    // One warm-up mount: React adds its own document listeners (selectionchange) once
    // per document and never removes them; that is React's, not a leak of ours.
    render(
      <Providers harness={harness}>
        <AppShell />
      </Providers>,
    ).unmount()
    const baseline = new Map(probe.listeners)

    for (let cycle = 0; cycle < 100; cycle++) {
      const view = render(
        <Providers harness={harness}>
          <AppShell />
        </Providers>,
      )
      const id = MANAGED[cycle % MANAGED.length]!
      await act(async () => {
        harness.store.dispatch({ type: 'navigate', view: 'sessions' } as never)
        harness.store.dispatch({ type: 'select', selection: { kind: 'managed', managedId: id } as never })
      })
      if (cycle % 10 === 0) await screen.findByRole('log', { name: 'Agent conversation' })
      // The server keeps talking while the person moves around.
      await act(async () => {
        stream.emit('sessions', JSON.stringify([id, 'queue']))
        stream.emit('list', '{}')
      })
      await act(async () => harness.store.dispatch({ type: 'navigate', view: VIEWS[cycle % VIEWS.length] } as never))
      if (cycle % 7 === 0) {
        await act(async () => harness.store.dispatch({ type: 'open-modal', modal: { kind: 'launch' } } as never))
        await act(async () => harness.store.dispatch({ type: 'close-modal', kind: 'launch' } as never))
      }
      view.unmount()
    }
    await act(async () => new Promise(r => setTimeout(r, 50)))

    // While the client lives (it belongs to the page, not to React): one stream, and only
    // its own listener (visibility is a fake here) and interval, the recovery poll.
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(stream.closed).toBe(false)
    expect(probe.leaked().filter(([key]) => (baseline.get(key) ?? 0) !== probe.listeners.get(key))).toEqual([])
    expect(harness.clock.size).toBe(0)
    expect(probe.observers.live).toBe(0)
    expect(probe.urls.live).toBe(0)
    expect(probe.intervals.size).toBeLessThanOrEqual(1)
    // Nothing is watched with no component on screen.
    expect(harness.client.store.watchedKeys()).toEqual([])
    // Distinct keys only: 11 sessions, the list, control and the few side resources.
    expect(entries(harness.client.store).size).toBeLessThanOrEqual(MANAGED.length + 12)

    // No animation-frame loop keeps going on its own.
    const frames = probe.frames()
    await act(async () => new Promise(r => setTimeout(r, 200)))
    expect(probe.frames() - frames).toBe(0)

    harness.client.stop()
    expect(probe.intervals.size).toBe(0)
    expect(probe.longTimers.size).toBe(0)
    expect(stream.closed).toBe(true)
  })

  it('keeps the resource cache bounded when hundreds of sessions come and go', { timeout: 60_000 }, async () => {
    const fleet = appFleet()
    const template = fleet.held('m-claude-idle')!
    const { harness } = makeAppHarness(fleet)
    harness.client.start()
    const view = render(
      <Providers harness={harness}>
        <AppShell />
      </Providers>,
    )
    await screen.findByText('Clean up stale branches', { selector: '.session-title' })
    for (let n = 0; n < 200; n++) {
      const id = `m-churn-${n}`
      fleet.setDetail(id, { ...template, session: { ...template.session, id, name: `Churn ${n}` } })
      await act(async () => harness.store.dispatch({ type: 'select', selection: { kind: 'managed', managedId: id } as never }))
      await waitFor(() => expect(harness.client.store.get(harness.client.resources.managed(id)).status).toBe('success'))
    }
    const managedKeys = [...entries(harness.client.store).keys()].filter(key => key.startsWith('managed:'))
    // The selected one is watched and kept; old, unwatched details are dropped.
    expect(managedKeys).toContain(keys.managed('m-churn-199'))
    expect(managedKeys.length).toBeLessThanOrEqual(64)
    view.unmount()
    harness.client.stop()
  })
})
