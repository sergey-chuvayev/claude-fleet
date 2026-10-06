// The shell's background controllers run on every view: a Day report-back is
// announced while Sessions is open, not only on Today.
import { act, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Clock } from '../components/clock'
import { T0, copy, fakeDayFleet, type Json } from '../features/today/testing'
import { type Harness, makeHarness, renderWith } from '../test/shell'
import { keys } from '../transport/resources'
import { AppShell } from './AppShell'

let harness: Harness | null = null
afterEach(() => {
  harness?.client.stop()
  harness = null
})

describe('background controllers', () => {
  it('announces a report-back while the Sessions view is open', async () => {
    const fleet = fakeDayFleet()
    harness = { ...makeHarness(fleet.fetch), clock: new Clock({ now: () => T0, visibility: null }) }
    harness.store.dispatch({ type: 'navigate', view: 'sessions' })
    renderWith(harness, <AppShell />)
    const client = harness.client
    await waitFor(() => expect(client.store.get(client.resources.sessions).data).toBeTruthy())
    expect(document.getElementById('today-pane')).toBeNull()
    // Let the lazy controller load, mount and take the first snapshot as its baseline.
    await act(async () => {
      await import('../features/today/ReportBack')
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    const snapshot: Json = copy(fleet.snapshot)
    const day = snapshot.sessions.find((s: Json) => s.managedId === 'day-today')
    day.dayProgress.report = { ...day.dayProgress.report, at: T0 + 60_000, title: 'Totals cache', question: 'Cached totals, tests green.' }
    fleet.setSessions(snapshot)
    await act(async () => client.store.invalidate(keys.sessions))

    await waitFor(() => expect(screen.getByText('Totals cache: Cached totals, tests green.')).toBeTruthy())
  })
})
