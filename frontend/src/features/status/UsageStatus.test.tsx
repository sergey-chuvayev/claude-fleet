// F27 and the legacy "status bar reports absence honestly" test: unknown draws nothing,
// an API key hides the cluster, a stale reading is dimmed and dated, a nearly spent
// window swaps its reset clock for a countdown, and a block says why.
import { render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Clock, ClockProvider } from '../../components/clock'
import { clockAt } from '../../domain/format'
import { UsageStatus } from './UsageStatus'

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0)
const MIN = 60_000
const HOUR = 3_600_000

const five = (utilization: number, resetsAt: number | null = NOW + HOUR) => ({ name: 'five_hour', label: '5h', utilization, resetsAt })
const reading = (over: Record<string, unknown> = {}) => ({
  available: true,
  known: true,
  binding: 'five_hour',
  windows: [five(62)],
  stale: false,
  observedAt: NOW,
  ...over,
})

let view: ReturnType<typeof render> | null = null
const draw = (usage: unknown) => {
  view?.unmount()
  view = render(
    <ClockProvider value={new Clock({ now: () => NOW, visibility: null })}>
      <UsageStatus usage={usage} />
    </ClockProvider>,
  )
  return view.container
}
afterEach(() => {
  view?.unmount()
  view = null
})

describe('UsageStatus absence', () => {
  it('draws nothing for no reading rather than a zero', () => {
    expect(draw(null).innerHTML).toBe('')
    expect(draw(undefined).innerHTML).toBe('')
    expect(draw({ not: 'a usage reading' }).innerHTML).toBe('')
  })

  it('draws nothing when the reading is not known', () => {
    expect(draw({ available: true, known: false, windows: [] }).innerHTML).toBe('')
  })

  it('draws nothing on an API key, which has no plan window to report', () => {
    expect(draw({ available: false, known: true, windows: [five(0, NOW)] }).innerHTML).toBe('')
  })
})

describe('UsageStatus windows', () => {
  it('gauges the binding window and leaves the others as bare numbers', () => {
    const c = draw(reading({ windows: [five(62, NOW + 2 * HOUR), { name: 'seven_day', label: 'week', utilization: 31, resetsAt: null }] }))
    const meter = c.querySelector('[role="meter"]') as HTMLElement
    expect(meter.getAttribute('aria-valuenow')).toBe('62')
    expect(meter.getAttribute('aria-label')).toBe('five-hour usage')
    expect((meter.querySelector('i') as HTMLElement).style.width).toBe('62%')
    expect(c.querySelectorAll('[role="meter"]')).toHaveLength(1)
    expect(c.querySelector('.usage-other')?.textContent).toBe('week 31%')
    expect(c.querySelector('.usage-reset')?.textContent).toBe(`resets ${clockAt(NOW + 2 * HOUR)}`)
    expect(c.querySelector('.is-stale')).toBeNull()
    expect(c.querySelector('.usage-stale')).toBeNull()
  })

  it('swaps the reset clock for a countdown past 90%, and keeps the gauge in the hot colour', () => {
    const c = draw(reading({ windows: [five(94, NOW + 38 * MIN)] }))
    expect(c.querySelector('.usage-reset')?.textContent).toBe('38m left')
    expect(c.querySelector('.usage-reset')?.classList.contains('is-critical')).toBe(true)
    expect(c.querySelector('.usage-gauge')?.classList.contains('hot')).toBe(true)
    expect((c.querySelector('.usage-gauge i') as HTMLElement).style.width).toBe('94%')
  })

  it('warns from 75% and runs hot from 90%, and shows the countdown only at 90%', () => {
    expect(draw(reading({ windows: [five(74)] })).querySelector('.usage-gauge')?.className).toBe('usage-gauge')
    const warn = draw(reading({ windows: [five(80)] }))
    expect(warn.querySelector('.usage-gauge')?.classList.contains('warn')).toBe(true)
    expect(warn.querySelector('.usage-reset')?.textContent).toContain('resets')
    expect(draw(reading({ windows: [five(89)] })).querySelector('.usage-gauge')?.classList.contains('warn')).toBe(true)
    const hot = draw(reading({ windows: [five(90, NOW + 5 * MIN)] }))
    expect(hot.querySelector('.usage-gauge')?.classList.contains('hot')).toBe(true)
    expect(hot.querySelector('.usage-reset')?.textContent).toBe('5m left')
  })

  it('still draws a zero reading', () => {
    const c = draw(reading({ windows: [five(0)] }))
    expect((c.querySelector('.usage-gauge i') as HTMLElement).style.width).toBe('0%')
    expect(c.querySelector('.usage-pct')?.textContent).toBe('0%')
  })

  it('dims a stale reading and says when it is from', () => {
    const c = draw(reading({ stale: true, observedAt: NOW - HOUR }))
    expect(c.querySelector('.usage-window')?.classList.contains('is-stale')).toBe(true)
    expect(c.querySelector('.usage-gauge')).not.toBeNull()
    expect(c.querySelector('.usage-stale')?.textContent).toBe(`as of ${clockAt(NOW - HOUR)}`)
  })
})

describe('UsageStatus blocked', () => {
  it('names the window, the reset and the reason, and draws no gauge without a window reading', () => {
    const c = draw(reading({ windows: [], stale: true, observedAt: null, blocked: { rateLimitType: 'five_hour', resetsAt: NOW + 38 * MIN, reason: 'org_spend_cap_reached' } }))
    const text = c.querySelector('.usage-blocked')?.textContent ?? ''
    expect(text).toContain('Rate limited')
    expect(text).toContain('five-hour window')
    expect(text).toContain(`resets ${clockAt(NOW + 38 * MIN)} (38m)`)
    expect(text).toContain('organisation spend cap reached')
    expect(c.querySelector('[role="meter"]')).toBeNull()
  })

  it('does not hide the reading behind a block', () => {
    const c = draw(reading({ windows: [five(100, NOW + 38 * MIN)], blocked: { rateLimitType: 'five_hour', resetsAt: NOW + 38 * MIN, reason: null } }))
    expect(c.querySelector('.usage-gauge')?.classList.contains('hot')).toBe(true)
    expect(c.querySelector('.usage-blocked')?.textContent).toContain('Rate limited')
  })
})
