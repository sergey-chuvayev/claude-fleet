// A23 regression, found by the production-build journey "settings queue limit": a
// control that is disabled while it saves drops focus to <body> without a focusin,
// and Escape and Tab then never reached the dialog. They must still close it and
// move focus back inside.
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Dialog, DialogHead } from './Dialog'

function Saving({ onClose }: { onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <Dialog labelledBy="t" onClose={onClose}>
      <DialogHead titleId="t" title="Settings" closeLabel="Close settings" />
      <button type="button" disabled={busy} onClick={() => setBusy(true)}>
        Save
      </button>
      <button type="button">Last</button>
    </Dialog>
  )
}

describe('Dialog when focus falls to the body', () => {
  it('still closes on Escape', () => {
    const onClose = vi.fn()
    render(<Saving onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    // jsdom does not blur a control that becomes disabled; a browser does.
    ;(document.activeElement as HTMLElement | null)?.blur()
    expect(document.activeElement).toBe(document.body)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('brings Tab and Shift+Tab back inside', () => {
    render(<Saving onClose={() => {}} />)
    ;(document.activeElement as HTMLElement | null)?.blur()
    fireEvent.keyDown(document.body, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close settings' }))
    ;(document.activeElement as HTMLElement | null)?.blur()
    fireEvent.keyDown(document.body, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Last' }))
  })

  it('leaves keys alone once it has closed', () => {
    const onClose = vi.fn()
    const view = render(<Saving onClose={onClose} />)
    view.unmount()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })
})
