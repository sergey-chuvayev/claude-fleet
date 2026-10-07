import { fireEvent, render, screen } from '@testing-library/react'
import { StrictMode, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Dialog, DialogHead } from './Dialog'
import { Select } from './Select'

function Harness({ onClose = () => {}, initialFocus }: { onClose?: () => void; initialFocus?: string }) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('a')
  return (
    <StrictMode>
      <main>
        <button type="button" onClick={() => setOpen(true)}>
          Open
        </button>
        <button type="button">Behind</button>
      </main>
      {open ? (
        <Dialog
          id="test-backdrop"
          labelledBy="t"
          initialFocus={initialFocus}
          onClose={() => {
            onClose()
            setOpen(false)
          }}
        >
          <DialogHead titleId="t" title="A dialog" closeLabel="Close the dialog" />
          <input aria-label="Name" defaultValue="Ada" />
          <Select
            label="Pick"
            value={value}
            onChange={setValue}
            block
            options={[
              { value: 'a', label: 'Alpha' },
              { value: 'b', label: 'Beta' },
            ]}
          />
          <button type="button">Last</button>
        </Dialog>
      ) : null}
    </StrictMode>
  )
}

const open = () => {
  const opener = screen.getByRole('button', { name: 'Open' })
  opener.focus()
  fireEvent.click(opener)
  return opener
}

describe('Dialog', () => {
  it('moves focus in, keeps Tab inside, makes the background inert and returns focus to the opener', () => {
    render(<Harness />)
    const opener = open()
    const dialog = screen.getByRole('dialog', { name: 'A dialog' })
    const close = screen.getByRole('button', { name: 'Close the dialog' })
    const last = screen.getByRole('button', { name: 'Last' })
    expect(document.activeElement).toBe(close)
    expect(document.body.hasAttribute('data-modal')).toBe(true)
    expect((document.querySelector('main')!.closest('body > *') as HTMLElement).inert).toBe(true)

    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)

    // Focus that escapes (a script, a layer) is pulled back in.
    screen.getByRole('button', { name: 'Behind', hidden: true }).focus()
    expect(dialog.contains(document.activeElement)).toBe(true)

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.body.hasAttribute('data-modal')).toBe(false)
    expect((document.querySelector('main')!.closest('body > *') as HTMLElement).inert).toBe(false)
    expect(document.activeElement).toBe(opener)
  })

  it('focuses and selects the requested field', () => {
    render(<Harness initialFocus="input" />)
    open()
    const input = screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement
    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(3)
  })

  it('closes on a backdrop click and on [data-close-modal], never on a click inside or a drag out', () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    open()
    const backdrop = document.getElementById('test-backdrop')!
    fireEvent.pointerDown(screen.getByRole('dialog'))
    fireEvent.click(backdrop)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.pointerDown(backdrop)
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalledTimes(1)

    open()
    fireEvent.click(screen.getByRole('button', { name: 'Close the dialog' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('lets Escape close a select menu inside it without closing the dialog', () => {
    render(<Harness />)
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Pick: Alpha' }))
    const menu = screen.getByRole('listbox', { name: 'Pick' })
    // The menu lives inside the modal layer, not behind the inert background.
    expect(document.getElementById('test-backdrop')!.contains(menu)).toBe(true)
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Pick: Alpha' }))
  })
})
