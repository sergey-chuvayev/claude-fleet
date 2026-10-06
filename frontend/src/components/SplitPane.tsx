// The resizable dividers, ported from the splitter code at the end of public/app.js.
//
// SplitPane is the vertical divider between a view's pane and its detail column. The
// layout itself is CSS (`.workspace` columns read a custom property, --split or
// --today-split); this component owns the property on the container, the separator
// semantics, pointer dragging, the keyboard (Arrow ±2, Home/End, Enter/Space reset),
// double-click reset, pixel clamping and the remembered percent (fleet:minimal-split,
// fleet:today-split). At phone widths (720px and under) the CSS stacks the panes and
// the value is not clamped.
//
// PanelSplitter is the horizontal divider above or below a panel whose height is
// remembered in pixels (the composer, the team overview).
import { type KeyboardEvent, type PointerEvent, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { usePreference, usePreferences } from '../app/AppStore'

/** The remembered percent: fleet:minimal-split or fleet:today-split. */
export type SplitPreference = 'split' | 'todaySplit'
/** The remembered height: fleet:minimal-composer-height or fleet:overview-height. */
export type PanelPreference = 'composerHeight' | 'overviewHeight'

const MOBILE_MAX = 720
const KEY_STEPS: Record<string, number> = { ArrowLeft: -2, ArrowRight: 2, Home: -100, End: 100 }

/** Clamp a percent of `width` to the [min, max] percent bounds; phone widths are not clamped. */
export function clampSplit(percent: number, width: number, bounds: (width: number) => readonly [number, number]): number {
  if (width <= MOBILE_MAX) return percent
  const [min, max] = bounds(width)
  return Math.min(Math.max(percent, min), max)
}

export interface SplitPaneProps {
  /** The element whose width the percent is of, and which receives the custom property. */
  readonly containerRef: RefObject<HTMLElement | null>
  readonly preference: SplitPreference
  /** The custom property the container's grid reads, e.g. "--split". */
  readonly cssVar: string
  /** Percent used with no remembered value, and after a reset. */
  readonly defaultValue: number
  /** Allowed range in percent for a container width in pixels. */
  readonly bounds: (width: number) => readonly [number, number]
  readonly label: string
  readonly id?: string
}

export function SplitPane({ containerRef, preference, cssVar, defaultValue, bounds, label, id }: SplitPaneProps) {
  const preferences = usePreferences()
  const saved = usePreference(preference)
  // A value being dragged, not yet saved.
  const [live, setLive] = useState<number | null>(null)
  const [width, setWidth] = useState(0)
  const dragging = useRef<{ pointerId: number; value: number } | null>(null)
  const separator = useRef<HTMLDivElement>(null)

  const measure = useCallback(() => containerRef.current?.getBoundingClientRect().width ?? 0, [containerRef])

  // A window resize can leave a remembered split too narrow for one pane: re-clamp
  // without saving.
  useEffect(() => {
    const update = () => setWidth(measure())
    update()
    window.addEventListener('resize', update)
    const element = containerRef.current
    const observer = typeof ResizeObserver === 'function' && element ? new ResizeObserver(update) : null
    if (observer && element) observer.observe(element)
    return () => {
      window.removeEventListener('resize', update)
      observer?.disconnect()
    }
  }, [measure, containerRef])

  const value = Math.round(clampSplit(live ?? saved ?? defaultValue, width, bounds) * 10) / 10

  useLayoutEffect(() => {
    const element = containerRef.current
    element?.style.setProperty(cssVar, `${value}%`)
    return () => {
      element?.style.removeProperty(cssVar)
    }
    // width: the container's ref is attached after this component's first layout
    // effect, so the first measurement (in an effect) applies it again.
  }, [containerRef, cssVar, value, width])

  const save = (next: number) => {
    const w = measure()
    preferences.set(preference, Math.round(clampSplit(next, w, bounds) * 10) / 10)
  }
  const reset = () => {
    setLive(null)
    preferences.set(preference, null)
  }

  const fromPointer = (clientX: number): number | null => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect || !rect.width) return null
    return clampSplit(((clientX - rect.left) / rect.width) * 100, rect.width, bounds)
  }

  const stop = useCallback(() => {
    const drag = dragging.current
    if (!drag) return
    dragging.current = null
    separator.current?.removeAttribute('data-dragging')
    document.body.removeAttribute('data-resizing')
    if (separator.current?.hasPointerCapture?.(drag.pointerId)) separator.current.releasePointerCapture(drag.pointerId)
  }, [])
  // Unmounting mid-drag (a view switch) must not leave the page in resize mode.
  useEffect(() => stop, [stop])

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button) return
    event.preventDefault()
    dragging.current = { pointerId: event.pointerId, value: value }
    event.currentTarget.setAttribute('data-dragging', '')
    document.body.setAttribute('data-resizing', '')
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragging.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const next = fromPointer(event.clientX)
    if (next === null) return
    drag.value = next
    setLive(next)
  }
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragging.current
    if (!drag || drag.pointerId !== event.pointerId) return
    stop()
    save(drag.value)
    setLive(null)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = KEY_STEPS[event.key]
    if (step === undefined) {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      reset()
      return
    }
    event.preventDefault()
    save(Math.round(value) + step)
  }

  const [min, max] = width > MOBILE_MAX ? bounds(width) : [15, 40]

  return (
    <div
      ref={separator}
      id={id}
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onLostPointerCapture={stop}
      onDoubleClick={reset}
      onKeyDown={onKeyDown}
    />
  )
}

export interface PanelSplitterProps {
  /** The panel whose height is set. */
  readonly panelRef: RefObject<HTMLElement | null>
  readonly preference: PanelPreference
  readonly label: string
  /** Smallest height in pixels. */
  readonly min: number
  /** Height with nothing remembered, and after a reset. */
  readonly initial: number
  /** The largest height allowed right now (it depends on the space around the panel). */
  readonly max: () => number
  /** The divider sits above the panel: dragging up grows it. */
  readonly before?: boolean
  /** The height is a floor (min-height), so the panel can still grow to fit its content. */
  readonly grow?: boolean
  /** Collapsed (a closed <details>): no divider, no height. */
  readonly collapsed?: boolean
}

const PANEL_STEPS: Record<string, number> = { ArrowUp: -10, ArrowDown: 10 }

export function PanelSplitter({ panelRef, preference, label, min, initial, max, before = false, grow = false, collapsed = false }: PanelSplitterProps) {
  const preferences = usePreferences()
  const saved = usePreference(preference)
  const [live, setLive] = useState<number | null>(null)
  const [, setTick] = useState(0)
  const drag = useRef<{ y: number; height: number; pointerId: number } | null>(null)
  const mobile = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width:720px)').matches
  const preferred = live ?? (saved !== null && saved >= min ? saved : initial)
  const limit = Math.floor(Math.max(min, max()))
  const height = Math.round(Math.max(min, Math.min(preferred, limit)))
  const property = grow ? 'minHeight' : 'height'

  // Re-apply when the space around the panel changes, and once after mount: the
  // panel may come after the divider, so its ref is attached only by then.
  useEffect(() => {
    setTick(n => n + 1)
    const panel = panelRef.current
    const container = panel?.parentElement
    const update = () => setTick(n => n + 1)
    window.addEventListener('resize', update)
    const observer = typeof ResizeObserver === 'function' && container ? new ResizeObserver(update) : null
    if (observer && container) observer.observe(container)
    return () => {
      window.removeEventListener('resize', update)
      observer?.disconnect()
    }
  }, [panelRef])

  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    if (mobile || collapsed) {
      panel.style.removeProperty('height')
      panel.style.removeProperty('min-height')
      return
    }
    panel.style[property] = `${height}px`
  })

  const set = (value: number, persist = true) => {
    const next = Math.max(min, Math.min(value, Math.max(min, max())))
    if (persist) {
      setLive(null)
      preferences.set(preference, Math.round(next))
    } else setLive(next)
  }
  const reset = () => {
    setLive(null)
    preferences.set(preference, null)
  }
  const current = () => panelRef.current?.getBoundingClientRect().height ?? height

  const stop = () => {
    const d = drag.current
    if (!d) return
    drag.current = null
    document.body.removeAttribute('data-panel-resizing')
    if (live !== null) set(live)
  }
  useEffect(
    () => () => {
      document.body.removeAttribute('data-panel-resizing')
    },
    [],
  )

  if (mobile || collapsed) return null
  return (
    <div
      className="panel-splitter"
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      aria-controls={panelRef.current?.id || undefined}
      aria-valuemin={min}
      aria-valuemax={limit}
      aria-valuenow={height}
      aria-valuetext={`${height} pixels`}
      tabIndex={0}
      title="Drag to resize · arrow keys to adjust · double-click to reset"
      data-dragging={drag.current ? '' : undefined}
      onPointerDown={event => {
        if (event.button) return
        event.preventDefault()
        event.currentTarget.focus({ preventScroll: true })
        drag.current = { y: event.clientY, height: current(), pointerId: event.pointerId }
        event.currentTarget.setPointerCapture?.(event.pointerId)
        document.body.setAttribute('data-panel-resizing', '')
      }}
      onPointerMove={event => {
        const d = drag.current
        if (d && event.pointerId === d.pointerId) set(d.height + (event.clientY - d.y) * (before ? -1 : 1), false)
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onDoubleClick={reset}
      onKeyDown={event => {
        const delta = PANEL_STEPS[event.key]
        if (delta !== undefined) {
          event.preventDefault()
          set(current() + delta * (before ? -1 : 1))
        } else if (['Home', 'End', 'Enter', ' '].includes(event.key)) {
          event.preventDefault()
          if (event.key === 'Home') set(min)
          else if (event.key === 'End') set(max())
          else reset()
        }
      }}
    />
  )
}
