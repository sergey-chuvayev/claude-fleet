import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Select, type SelectOption, match, placement } from './Select'

const MODES: SelectOption[] = [
  { value: 'auto', label: 'Auto · ask for risky commands', description: 'Asks only for destructive or networked shell commands' },
  { value: 'ask', label: 'Ask every time' },
  { value: 'locked', label: 'Admin only', disabled: true },
  { value: 'all', label: 'Approve everything' },
]

function Controlled({ onChange }: { onChange?: (value: string) => void }) {
  const [value, setValue] = useState('ask')
  return (
    <label>
      <span>Approvals</span>
      <Select
        id="mode"
        label="Approvals"
        value={value}
        options={MODES}
        onChange={next => {
          onChange?.(next)
          setValue(next)
        }}
      />
    </label>
  )
}

const trigger = () => screen.getByRole('button', { name: /^Approvals:/ })
const menu = () => screen.getByRole('listbox', { name: 'Approvals' })
const activeLabel = () => document.getElementById(menu().getAttribute('aria-activedescendant')!)?.textContent

afterEach(() => vi.useRealTimers())

describe('Select', () => {
  it('is controlled: the trigger names the value, the native select mirrors it', () => {
    render(<Controlled />)
    expect(trigger().getAttribute('aria-label')).toBe('Approvals: Ask every time')
    expect((document.getElementById('mode') as HTMLSelectElement).value).toBe('ask')
    expect(trigger().getAttribute('aria-haspopup')).toBe('listbox')
  })

  it('opens from the keyboard, moves with arrows, Home and End, skips disabled options and chooses with Enter', () => {
    const onChange = vi.fn()
    render(<Controlled onChange={onChange} />)
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' })
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(menu())
    expect(activeLabel()).toContain('Ask every time')

    fireEvent.keyDown(menu(), { key: 'ArrowDown' })
    // "Admin only" is disabled: skipped.
    expect(activeLabel()).toContain('Approve everything')
    fireEvent.keyDown(menu(), { key: 'Home' })
    expect(activeLabel()).toContain('Auto')
    fireEvent.keyDown(menu(), { key: 'End' })
    expect(activeLabel()).toContain('Approve everything')
    fireEvent.keyDown(menu(), { key: 'ArrowUp' })
    expect(activeLabel()).toContain('Ask every time')
    fireEvent.keyDown(menu(), { key: 'Home' })
    fireEvent.keyDown(menu(), { key: 'Enter' })

    expect(onChange).toHaveBeenCalledWith('auto')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(trigger())
    expect(trigger().getAttribute('aria-label')).toBe('Approvals: Auto · ask for risky commands')
  })

  it('closes with Escape without choosing, and a disabled option cannot be clicked', () => {
    const onChange = vi.fn()
    render(<Controlled onChange={onChange} />)
    fireEvent.click(trigger())
    const disabled = screen.getByRole('option', { name: 'Admin only' })
    expect(disabled.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(disabled)
    expect(onChange).not.toHaveBeenCalled()
    expect(menu()).toBeTruthy()
    fireEvent.keyDown(menu(), { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(trigger())
  })

  it('shows descriptions and marks the selected option', () => {
    render(<Controlled />)
    fireEvent.click(trigger())
    expect(screen.getByText('Asks only for destructive or networked shell commands')).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Ask every time' }).getAttribute('aria-selected')).toBe('true')
  })

  it('typeahead on the closed trigger changes the value, and in the open menu moves the highlight', () => {
    vi.useFakeTimers()
    const onChange = vi.fn()
    render(<Controlled onChange={onChange} />)
    fireEvent.keyDown(trigger(), { key: 'a' })
    // From "Ask every time" the next "a..." is "Approve everything" ("Admin only" is disabled).
    expect(onChange).toHaveBeenLastCalledWith('all')
    vi.advanceTimersByTime(700)
    fireEvent.keyDown(trigger(), { key: 'a' })
    expect(onChange).toHaveBeenLastCalledWith('auto')

    fireEvent.keyDown(trigger(), { key: 'Enter' })
    vi.advanceTimersByTime(700)
    fireEvent.keyDown(menu(), { key: 'a' })
    expect(activeLabel()).toContain('Ask every time')
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('closes on a press outside, without moving focus to the trigger', () => {
    render(
      <>
        <Controlled />
        <button type="button">Elsewhere</button>
      </>,
    )
    fireEvent.click(trigger())
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Elsewhere' }))
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('hands a label click on the hidden native select to the trigger, and keeps it out of the tab order', () => {
    render(<Controlled />)
    const native = document.getElementById('mode') as HTMLSelectElement
    expect(native.tabIndex).toBe(-1)
    expect(native.getAttribute('aria-hidden')).toBe('true')
    native.focus()
    expect(document.activeElement).toBe(trigger())
  })

  it('a disabled select does not open', () => {
    render(<Select label="Model" value="a" disabled options={[{ value: 'a', label: 'Opus' }]} onChange={() => {}} />)
    const button = screen.getByRole('button', { name: 'Model: Opus' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.keyDown(button, { key: 'ArrowDown' })
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})

describe('Select closes on scroll only when the trigger moves', () => {
  const setup = () => {
    render(
      <div>
        <div data-testid="panel">
          <Controlled />
        </div>
        <div data-testid="elsewhere">a console log following a stream</div>
      </div>,
    )
    fireEvent.click(trigger())
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
  }

  it('stays open when something that does not hold the trigger scrolls', () => {
    setup()
    fireEvent.scroll(screen.getByTestId('elsewhere'))
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    // Nor does the menu scrolling itself.
    fireEvent.scroll(menu())
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
  })

  it('closes when a panel holding the trigger scrolls', () => {
    setup()
    fireEvent.scroll(screen.getByTestId('panel'))
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('closes when the page scrolls', () => {
    setup()
    fireEvent.scroll(document)
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })
})

describe('select helpers (as select.js)', () => {
  it('match cycles through labels starting with the typed text', () => {
    const labels = ['Opus', 'Sonnet', 'Haiku', 'Opus 4']
    expect(match(labels, 'o')).toBe(0)
    expect(match(labels, 'o', 0)).toBe(3)
    expect(match(labels, 'o', 3)).toBe(0)
    expect(match(labels, 'son')).toBe(1)
    expect(match(labels, 'x')).toBe(-1)
    expect(match(labels, '')).toBe(-1)
  })

  it('placement prefers below, and goes above only when it has more room', () => {
    expect(placement({ top: 100, bottom: 130 }, 200, 800)).toBe('below')
    expect(placement({ top: 600, bottom: 630 }, 300, 800)).toBe('above')
    expect(placement({ top: 100, bottom: 130 }, 900, 800)).toBe('below')
  })
})
