// F32: a report from an agent launched from Today is announced once (toast, tone,
// optional notification); the first snapshot only sets the mark.
import { act, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Clock } from '../../components/clock'
import { makeHarness, renderWith } from '../../test/shell'
import { keys } from '../../transport/resources'
import { ReportBack } from './ReportBack'
import { type Json, T0, copy, fakeDayFleet } from './testing'
import { usePendingReveal } from './useDay'

afterEach(() => {
  vi.unstubAllGlobals()
})

function Reveal() {
  return <span data-testid="reveal">{usePendingReveal() ?? ''}</span>
}

describe('ReportBack', () => {
  it('stays quiet on the first snapshot, then announces a newer report once', async () => {
    const fleet = fakeDayFleet()
    const notes: Array<{ title: string; body?: string | undefined; onclick: (() => void) | null; close: () => void }> = []
    vi.stubGlobal(
      'Notification',
      class {
        onclick: (() => void) | null = null
        constructor(
          readonly title: string,
          options: { body?: string },
        ) {
          notes.push(Object.assign(this, { body: options.body, close: () => {} }))
        }
      },
    )
    const play = vi.fn()
    let notify = false
    const harness = { ...makeHarness(fleet.fetch), clock: new Clock({ now: () => T0, visibility: null }) }
    renderWith(
      harness,
      <>
        <ReportBack play={play} notify={() => notify} />
        <Reveal />
      </>,
    )
    await waitFor(() => expect(harness.client.store.get(harness.client.resources.sessions).data).toBeTruthy())
    await act(async () => {})
    expect(play).not.toHaveBeenCalled()
    expect(document.getElementById('toast')?.textContent ?? '').toBe('')

    const bump = async (at: number) => {
      const snapshot: Json = copy(fleet.snapshot)
      const day = snapshot.sessions.find((s: Json) => s.managedId === 'day-today')
      day.dayProgress.report = { ...day.dayProgress.report, at, title: 'Totals cache', question: 'Cached totals, tests green.' }
      fleet.setSessions(snapshot)
      await act(async () => harness.client.store.invalidate(keys.sessions))
    }
    await bump(T0 + 60_000)
    await waitFor(() => expect(play).toHaveBeenCalledWith('report'))
    expect(document.getElementById('toast')?.textContent).toBe('Totals cache: Cached totals, tests green.')
    expect(notes).toHaveLength(0)

    notify = true
    await bump(T0 + 120_000)
    await waitFor(() => expect(notes).toHaveLength(1))
    expect(play).toHaveBeenCalledTimes(2)
    act(() => notes[0]?.onclick?.())
    expect(harness.store.getState().view).toBe('today')
    expect(document.querySelector('[data-testid="reveal"]')?.textContent).toBe('00000009-f1e1-4000-8000-000000000000')
  })
})
