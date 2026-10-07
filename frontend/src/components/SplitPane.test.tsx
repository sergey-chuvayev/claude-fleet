import { fireEvent, render, screen } from '@testing-library/react'
import { StrictMode, useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppStore, AppStoreProvider } from '../app/AppStore'
import { PreferenceStore } from '../app/preferences'
import { VIEW_DEFINITIONS } from '../app/views'
import { MemoryStorage } from '../test/shell'
import { PanelSplitter, SplitPane, clampSplit } from './SplitPane'

const LIST = VIEW_DEFINITIONS.sessions.split!

function Workspace({ width }: { width: number }) {
  const ref = useRef<HTMLElement>(null)
  return (
    <section
      ref={el => {
        ref.current = el
        if (el) el.getBoundingClientRect = () => ({ left: 0, top: 0, width, height: 800, right: width, bottom: 800, x: 0, y: 0, toJSON: () => ({}) })
      }}
      className="workspace"
    >
      <SplitPane containerRef={ref} preference="split" cssVar="--split" defaultValue={22} bounds={LIST.bounds} label="Resize the session inspector" />
    </section>
  )
}

function renderSplit(storage: MemoryStorage, width = 1440) {
  const store = new AppStore(new PreferenceStore(storage))
  const view = render(
    <StrictMode>
      <AppStoreProvider store={store}>
        <Workspace width={width} />
      </AppStoreProvider>
    </StrictMode>,
  )
  const separator = screen.getByRole('separator', { name: 'Resize the session inspector' })
  const workspace = document.querySelector<HTMLElement>('.workspace')!
  return { ...view, separator, workspace, store }
}

afterEach(() => vi.restoreAllMocks())

describe('SplitPane', () => {
  it('applies the default, exposes separator values and clamps in pixels', () => {
    const { separator, workspace } = renderSplit(new MemoryStorage())
    expect(workspace.style.getPropertyValue('--split')).toBe('22%')
    expect(separator.getAttribute('aria-orientation')).toBe('vertical')
    expect(separator.getAttribute('aria-valuenow')).toBe('22')
    // 240px of 1440 is 16.7%; 380px is 26.4%.
    expect(separator.getAttribute('aria-valuemin')).toBe('17')
    expect(separator.getAttribute('aria-valuemax')).toBe('26')
    expect(clampSplit(5, 1440, LIST.bounds)).toBeCloseTo(16.67, 1)
    expect(clampSplit(90, 1440, LIST.bounds)).toBeCloseTo(26.39, 1)
    // Phone widths stack the panes: no clamping.
    expect(clampSplit(90, 390, LIST.bounds)).toBe(90)
  })

  it('clamps a remembered value that no longer fits, without rewriting it', () => {
    const storage = new MemoryStorage({ 'fleet:minimal-split': '60' })
    const { workspace, separator } = renderSplit(storage)
    expect(workspace.style.getPropertyValue('--split')).toBe('26.4%')
    expect(separator.getAttribute('aria-valuenow')).toBe('26')
    expect(storage.getItem('fleet:minimal-split')).toBe('60')
  })

  it('moves by 2 with the arrow keys, saves the clamped value, and resets with Enter or a double-click', () => {
    const storage = new MemoryStorage()
    const { separator, workspace } = renderSplit(storage)
    fireEvent.keyDown(separator, { key: 'ArrowRight' })
    expect(storage.getItem('fleet:minimal-split')).toBe('24')
    expect(workspace.style.getPropertyValue('--split')).toBe('24%')
    fireEvent.keyDown(separator, { key: 'ArrowLeft' })
    fireEvent.keyDown(separator, { key: 'ArrowLeft' })
    expect(storage.getItem('fleet:minimal-split')).toBe('20')
    fireEvent.keyDown(separator, { key: 'End' })
    expect(storage.getItem('fleet:minimal-split')).toBe('26.4')
    fireEvent.keyDown(separator, { key: 'Home' })
    expect(storage.getItem('fleet:minimal-split')).toBe('16.7')

    fireEvent.keyDown(separator, { key: 'Enter' })
    expect(storage.getItem('fleet:minimal-split')).toBeNull()
    expect(workspace.style.getPropertyValue('--split')).toBe('22%')

    fireEvent.keyDown(separator, { key: 'ArrowRight' })
    fireEvent.doubleClick(separator)
    expect(storage.getItem('fleet:minimal-split')).toBeNull()
    expect(separator.getAttribute('aria-valuenow')).toBe('22')
  })

  it('drags with the pointer, saves once on release and clears resize mode', () => {
    const storage = new MemoryStorage()
    const set = vi.spyOn(Storage.prototype, 'setItem')
    const { separator, workspace } = renderSplit(storage)
    fireEvent.pointerDown(separator, { button: 0, pointerId: 1, clientX: 316 })
    expect(document.body.hasAttribute('data-resizing')).toBe(true)
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 300 })
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 340 })
    expect(workspace.style.getPropertyValue('--split')).toBe('23.6%')
    // Nothing is written while dragging.
    expect(storage.getItem('fleet:minimal-split')).toBeNull()
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 1000 })
    fireEvent.pointerUp(separator, { pointerId: 1, clientX: 1000 })
    expect(document.body.hasAttribute('data-resizing')).toBe(false)
    expect(storage.getItem('fleet:minimal-split')).toBe('26.4')
    expect(set).not.toHaveBeenCalled()
  })

  it('ignores a secondary button and removes resize mode if unmounted mid-drag', () => {
    const { separator, unmount, workspace } = renderSplit(new MemoryStorage())
    fireEvent.pointerDown(separator, { button: 2, pointerId: 1, clientX: 600 })
    expect(document.body.hasAttribute('data-resizing')).toBe(false)
    fireEvent.pointerDown(separator, { button: 0, pointerId: 1, clientX: 316 })
    unmount()
    expect(document.body.hasAttribute('data-resizing')).toBe(false)
    expect(workspace.style.getPropertyValue('--split')).toBe('')
  })
})

describe('PanelSplitter', () => {
  function Panel({ storage }: { storage: MemoryStorage }) {
    const ref = useRef<HTMLDivElement>(null)
    return (
      <AppStoreProvider store={new AppStore(new PreferenceStore(storage))}>
        <div>
          <PanelSplitter panelRef={ref} preference="composerHeight" label="Resize message composer" min={110} initial={130} max={() => 300} before grow />
          <div id="composer" ref={ref} />
        </div>
      </AppStoreProvider>
    )
  }

  it('sets the panel floor, steps by 10, clamps to min and max and resets', () => {
    const storage = new MemoryStorage({ 'fleet:minimal-composer-height': '500' })
    render(<Panel storage={storage} />)
    const panel = document.getElementById('composer')!
    const divider = screen.getByRole('separator', { name: 'Resize message composer' })
    // A remembered 500 does not fit under the 300 maximum.
    expect(panel.style.minHeight).toBe('300px')
    expect(divider.getAttribute('aria-valuetext')).toBe('300 pixels')
    fireEvent.keyDown(divider, { key: 'Home' })
    expect(storage.getItem('fleet:minimal-composer-height')).toBe('110')
    expect(panel.style.minHeight).toBe('110px')
    fireEvent.keyDown(divider, { key: 'Enter' })
    expect(storage.getItem('fleet:minimal-composer-height')).toBeNull()
    expect(panel.style.minHeight).toBe('130px')
  })
})
