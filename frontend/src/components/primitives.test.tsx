// Avatar parity with the legacy algorithm, the clock, Disclosure, CopyButton and
// the toast/announcer.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Avatar, avatarCells, avatarTone } from './Avatar'
import { Clock, ClockProvider, RelativeTime } from './clock'
import { CopyButton } from './CopyButton'
import { Disclosure } from './Disclosure'
import { Notifier, NotificationsProvider, useAnnounce } from './Toast'

// The legacy functions, evaluated from public/app.js itself.
function legacyAvatar(): (seed: string, initial: string, tone: number, working: boolean) => string {
  const source = readFileSync(createRequire(import.meta.url).resolve('../../../public/app.js'), 'utf8')
  const start = source.indexOf('const GLYPHS')
  const end = source.indexOf('// Draft contents survive')
  // biome-ignore lint: evaluating the legacy source on purpose
  return new Function(`${source.slice(start, end)}; return pixelAvatar`)()
}

afterEach(() => vi.useRealTimers())

describe('Avatar', () => {
  it('draws exactly the legacy cells, resting and working', () => {
    const pixelAvatar = legacyAvatar()
    vi.spyOn(Date, 'now').mockReturnValue(1791280800000)
    for (const [seed, title, working] of [
      ['m-claude-approval', 'Clean up stale branches', false],
      ['0000005e-0000-4000-8000-000000000003', 'codex: retry', true],
      ['session:4242', '9 lives', true],
      ['m-x', '', false],
    ] as const) {
      const initial = (title || 'F').trim().slice(0, 1).toUpperCase()
      const tone = avatarTone(seed)
      const legacy = new DOMParser().parseFromString(pixelAvatar(seed, initial, tone, working), 'image/svg+xml')
      const rects = [...legacy.querySelectorAll('rect:not(.avatar-sweep)')]
      const cells = avatarCells(seed, initial, working, Date.now() / 1000)
      expect(cells).toHaveLength(rects.length)
      cells.forEach((cell, i) => {
        const rect = rects[i]!
        expect([cell.x, cell.y, cell.width, cell.height].map(String)).toEqual(['x', 'y', 'width', 'height'].map(a => rect.getAttribute(a)))
        expect(cell.opacity).toBe(rect.getAttribute('opacity'))
        const style = rect.getAttribute('style')
        expect(cell.motion ? `--o:${cell.motion.o};--hi:${cell.motion.hi};animation-duration:${cell.motion.duration};animation-delay:${cell.motion.delay}` : null).toBe(style)
      })
    }
  })

  it('renders the tile with its tone, working state and status dot', () => {
    const { container } = render(<Avatar seed="m-claude-approval" title="Clean up" working status="stale" />)
    const tile = container.querySelector('.agent-avatar')!
    expect(tile.className).toBe(`agent-avatar avatar-${avatarTone('m-claude-approval')} is-working`)
    expect(tile.querySelectorAll('rect')).toHaveLength(82)
    expect(tile.querySelector('.avatar-status')?.className).toBe('avatar-status stale')
  })
})

describe('Clock and RelativeTime', () => {
  it('ticks only while watched, and re-renders a label only when its rounded time changes', () => {
    vi.useFakeTimers()
    let now = 1_800_000_000_000
    const clock = new Clock({ now: () => now, visibility: null })
    let renders = 0
    function Probe() {
      renders++
      return <RelativeTime at={now - 5 * 60_000} suffix=" ago" />
    }
    const view = render(
      <ClockProvider value={clock}>
        <Probe />
        <RelativeTime at={1_800_000_000_000 - 3 * 3_600_000} />
      </ClockProvider>,
    )
    expect(screen.getByText('5m ago')).toBeTruthy()
    expect(screen.getByText('3h')).toBeTruthy()
    expect(clock.size).toBe(2)
    const before = renders
    act(() => {
      now += 4000
      vi.advanceTimersByTime(4000)
    })
    // The parent never re-rendered; the label stays 5m.
    expect(renders).toBe(before)
    expect(screen.getByText('5m ago')).toBeTruthy()
    view.unmount()
    expect(clock.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('Disclosure', () => {
  it('keeps the operator’s open state across re-renders and renders a lazy body only while open', () => {
    const onOpenChange = vi.fn()
    const ui = (text: string) => (
      <Disclosure summary="Report" lazy data-delegation="report" onOpenChange={onOpenChange}>
        <p>{text}</p>
      </Disclosure>
    )
    const { container, rerender } = render(ui('one'))
    const details = container.querySelector('details[data-delegation="report"]') as HTMLDetailsElement
    expect(screen.queryByText('one')).toBeNull()
    details.open = true
    fireEvent(details, new Event('toggle'))
    expect(onOpenChange).toHaveBeenCalledWith(true)
    rerender(ui('two'))
    expect(details.open).toBe(true)
    expect(screen.getByText('two')).toBeTruthy()
  })
})

describe('CopyButton', () => {
  it('copies through the Clipboard API and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const notices: string[] = []
    render(
      <CopyButton text={() => 'claude --resume abc'} copiedMessage="Resume command copied" onNotice={m => notices.push(m)}>
        Copy resume command
      </CopyButton>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Copy resume command' }))
    await vi.waitFor(() => expect(notices).toEqual(['Resume command copied']))
    expect(writeText).toHaveBeenCalledWith('claude --resume abc')
    expect(document.querySelector('.copy-fallback')).toBeNull()
  })

  it('shows the text when neither the API nor the selection copy works', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) }, configurable: true })
    document.execCommand = vi.fn().mockReturnValue(false)
    const notices: string[] = []
    render(
      <CopyButton text="claude --resume abc" onNotice={m => notices.push(m)} title="Copy" aria-label="Copy">
        Copy
      </CopyButton>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await vi.waitFor(() => expect(document.querySelector('.copy-fallback')?.textContent).toBe('claude --resume abc'))
    expect(notices).toEqual(['Clipboard unavailable. The text is shown below.'])
    // The button says it too, for a moment.
    expect(screen.getByRole('button', { name: 'Clipboard unavailable. The text is shown below.' })).toBeTruthy()
  })
})

describe('Toast and announcer', () => {
  it('shows a toast for three seconds and coalesces announcements', () => {
    vi.useFakeTimers()
    const notifier = new Notifier()
    let announce: (m: string) => void = () => {}
    function Grab() {
      announce = useAnnounce()
      return null
    }
    render(
      <StrictMode>
        <NotificationsProvider notifier={notifier}>
          <Grab />
        </NotificationsProvider>
      </StrictMode>,
    )
    const toast = document.getElementById('toast')!
    act(() => notifier.toast('Session archived'))
    expect(toast.hidden).toBe(false)
    expect(toast.textContent).toBe('Session archived')
    act(() => vi.advanceTimersByTime(3000))
    expect(toast.hidden).toBe(true)

    const region = document.querySelector('[data-announcer]')!
    act(() => {
      announce('Filtering')
      announce('3 sessions shown')
    })
    expect(region.textContent).toBe('')
    act(() => vi.advanceTimersByTime(300))
    expect(region.textContent).toBe('3 sessions shown')
    expect(region.getAttribute('aria-live')).toBe('polite')
  })
})
