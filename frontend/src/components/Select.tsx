// One dropdown for every choice in Fleet, ported from public/select.js without the
// DOM patching: a controlled React component. It renders the native <select> (kept
// for touch widths, where CSS shows it and hides the trigger, so phones get their own
// picker) and a button trigger with a listbox menu for everything else.
//
// Keyboard, as legacy: on the closed trigger Arrow/Enter/Space open the menu and a
// printable key changes the value straight away (typeahead); in the menu Arrow,
// PageUp/PageDown, Home/End move, Enter/Space choose, Escape closes and returns focus,
// Tab closes. Disabled options are skipped and cannot be chosen.
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { CheckIcon, ChevronIcon } from './Icon'
import { LAYER_ATTRIBUTE, TOUCH_QUERY, useMediaQuery, usePortalContainer } from './layers'

export interface SelectOption<V extends string = string> {
  readonly value: V
  readonly label: string
  /** A second line under the label in the menu (legacy data-description). */
  readonly description?: string | undefined
  readonly disabled?: boolean | undefined
  /** Options sharing a group name are drawn under one heading (an optgroup). */
  readonly group?: string | undefined
}

export interface SelectProps<V extends string = string> {
  readonly value: V
  readonly options: readonly SelectOption<V>[]
  readonly onChange: (value: V) => void
  /** What the control is for ("Model", "Approvals"). Names both the trigger and the menu. */
  readonly label: string
  /** Id of the native select, so a <label for> reaches it. */
  readonly id?: string | undefined
  readonly name?: string | undefined
  /** Applied to the native select and the trigger alike, as legacy did. */
  readonly className?: string | undefined
  readonly disabled?: boolean | undefined
  readonly title?: string | undefined
  /** Full-width trigger. Undefined measures it the legacy way (90% of the parent or more). */
  readonly block?: boolean | undefined
  /** Always the native select (legacy data-native). */
  readonly native?: boolean | undefined
  readonly 'aria-describedby'?: string
}

// ── Pure helpers, the same as select.js exported to its tests ───────────────

/**
 * The next label starting with what was typed, searching from the one after `from`,
 * so typing the same letter again cycles through the matches.
 */
export function match(labels: readonly string[], typed: string, from = -1): number {
  const query = String(typed || '').toLowerCase()
  if (!query) return -1
  for (let step = 1; step <= labels.length; step++) {
    const i = (from + step) % labels.length
    if (labels[i] != null && String(labels[i]).toLowerCase().startsWith(query)) return i
  }
  return -1
}

/** Below the trigger when the menu fits there, otherwise above when that has more room. */
export function placement(
  trigger: { readonly top: number; readonly bottom: number },
  menuHeight: number,
  viewportHeight: number,
  gap = 6,
): 'below' | 'above' {
  const below = viewportHeight - trigger.bottom - gap
  const above = trigger.top - gap
  return menuHeight <= below || below >= above ? 'below' : 'above'
}

const TYPEAHEAD_MS = 600

export function Select<V extends string = string>(props: SelectProps<V>) {
  const { value, options, onChange, label, id, name, className, disabled = false, title, native = false } = props
  const touch = useMediaQuery(TOUCH_QUERY)
  const container = usePortalContainer()
  const menuId = useId()
  const nativeRef = useRef<HTMLSelectElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [style, setStyle] = useState<CSSProperties>({})
  const [where, setWhere] = useState<'below' | 'above'>('below')
  const [measured, setMeasured] = useState<{ width: number; block: boolean } | null>(null)
  const typed = useRef({ text: '', at: 0 })

  const selectedIndex = options.findIndex(option => option.value === value)
  const selected = options[selectedIndex]
  const text = selected?.label ?? ''
  const enabled = options.flatMap((option, index) => (option.disabled ? [] : [index]))

  // The legacy trigger was as wide as the native select it replaced (the longest
  // option), and full width when that select filled its parent. Measured once per
  // option set, with the hiding class lifted for the reading, before paint.
  const optionKey = options.map(option => option.label).join('\u0000')
  useLayoutEffect(() => {
    const select = nativeRef.current
    if (!select || native || props.block !== undefined) return
    select.classList.remove('fleet-select-native')
    const width = select.offsetWidth
    const parent = select.parentElement?.clientWidth ?? 0
    select.classList.add('fleet-select-native')
    setMeasured(width > 0 ? { width, block: parent > 0 && width >= parent * 0.9 } : null)
  }, [optionKey, native, props.block])
  const block = props.block ?? measured?.block ?? false

  const close = useCallback((focusTrigger: boolean) => {
    setOpen(false)
    if (focusTrigger) triggerRef.current?.focus()
  }, [])

  const show = () => {
    if (disabled) return
    setActive(selectedIndex >= 0 && !options[selectedIndex]?.disabled ? selectedIndex : (enabled[0] ?? -1))
    setOpen(true)
  }

  const choose = (index: number) => {
    const option = options[index]
    if (!option || option.disabled) return
    close(true)
    if (option.value !== value) onChange(option.value)
  }

  const move = (step: number) => {
    if (!enabled.length) return
    const at = enabled.indexOf(active)
    const next =
      step === Infinity
        ? enabled[enabled.length - 1]!
        : step === -Infinity
          ? enabled[0]!
          : enabled[Math.min(enabled.length - 1, Math.max(0, (at < 0 ? 0 : at) + step))]!
    setActive(next)
  }

  // Type to jump. Closed, it changes the value at once, as a native select does; in
  // the open menu it moves the highlight.
  const typeahead = (key: string, closed: boolean) => {
    const now = Date.now()
    typed.current = { text: now - typed.current.at > TYPEAHEAD_MS ? key : typed.current.text + key, at: now }
    const query = typed.current.text
    const from = enabled.indexOf(closed ? selectedIndex : active)
    const hit = match(
      enabled.map(index => options[index]!.label.trim()),
      query,
      query.length > 1 ? from - 1 : from,
    )
    if (hit < 0) return
    const index = enabled[hit]!
    if (!closed) return setActive(index)
    if (index !== selectedIndex) onChange(options[index]!.value)
  }

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault()
      show()
    } else if (event.key.length === 1 && /\S/.test(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault()
      typeahead(event.key, true)
    }
  }

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const steps: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: 5, PageUp: -5, Home: -Infinity, End: Infinity }
    const step = steps[event.key]
    if (step !== undefined) {
      event.preventDefault()
      move(step)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      choose(active)
    } else if (event.key === 'Escape') {
      // Only the menu closes, not the dialog it may sit in.
      event.preventDefault()
      event.stopPropagation()
      close(true)
    } else if (event.key === 'Tab') {
      // Focus goes back to the trigger first, so Tab moves on from there.
      close(true)
    } else if (event.key.length === 1 && /\S/.test(event.key) && !event.metaKey && !event.ctrlKey) {
      event.preventDefault()
      typeahead(event.key, false)
    }
  }

  // Position the open menu against its trigger, then hand it focus.
  useLayoutEffect(() => {
    if (!open) return
    const trigger = triggerRef.current
    const menu = menuRef.current
    if (!trigger || !menu) return
    const rect = trigger.getBoundingClientRect()
    const width = window.innerWidth
    const height = window.innerHeight
    const next: CSSProperties = {
      minWidth: `${Math.max(rect.width, 160)}px`,
      maxWidth: `${Math.min(Math.max(rect.width, 320), width - 16)}px`,
    }
    Object.assign(menu.style, next)
    const side = placement(rect, menu.offsetHeight, height)
    next.left = `${Math.max(8, Math.min(rect.left, width - menu.offsetWidth - 8))}px`
    next.top = side === 'below' ? `${rect.bottom + 6}px` : `${Math.max(8, rect.top - 6 - menu.offsetHeight)}px`
    setStyle(next)
    setWhere(side)
    menu.focus({ preventScroll: true })
  }, [open])

  useEffect(() => {
    if (!open || active < 0) return
    const el = menuRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [open, active])

  // Outside presses close it; so does anything that moves the trigger from under it.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: Event) => {
      const target = event.target as Node
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      close(false)
    }
    const onResize = () => close(false)
    const onScroll = (event: Event) => {
      const scrolled = event.target
      if (menuRef.current?.contains(scrolled as Node)) return
      if (scrolled instanceof Node && triggerRef.current && (scrolled === document || scrolled.contains(triggerRef.current))) {
        close(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('resize', onResize)
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('resize', onResize)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [open, close])

  // A disabled control cannot stay open.
  useEffect(() => {
    if (disabled && open) close(false)
  }, [disabled, open, close])

  const optionId = (index: number) => `${menuId}-option-${index}`
  const nativeOptions = groupOptions(options).map(({ group, items }) => {
    const rendered = items.map(({ option, index }) => (
      <option key={index} value={option.value} disabled={option.disabled}>
        {option.label}
      </option>
    ))
    return group ? (
      <optgroup key={`g-${group}`} label={group}>
        {rendered}
      </optgroup>
    ) : (
      rendered
    )
  })

  const nativeSelect = (
    <select
      ref={nativeRef}
      className={native ? className : `${className ? `${className} ` : ''}fleet-select-native`}
      id={id}
      name={name}
      value={value}
      disabled={disabled}
      title={title}
      aria-label={label}
      aria-describedby={props['aria-describedby']}
      onChange={event => onChange(event.target.value as V)}
      // On desktop the trigger is the control: a <label> click that focuses this
      // hidden select is handed on to it, and it stays out of the tab order.
      tabIndex={native || touch ? undefined : -1}
      aria-hidden={native || touch ? undefined : true}
      onFocus={() => {
        if (!native && !touch) triggerRef.current?.focus()
      }}
    >
      {nativeOptions}
    </select>
  )
  if (native) return nativeSelect

  const menu = open ? (
    <div
      ref={menuRef}
      id={menuId}
      className="fleet-select-menu"
      role="listbox"
      tabIndex={-1}
      aria-label={label || 'Options'}
      aria-activedescendant={active >= 0 ? optionId(active) : undefined}
      data-placement={where}
      style={style}
      {...{ [LAYER_ATTRIBUTE]: 'menu' }}
      onKeyDown={onMenuKeyDown}
    >
      {groupOptions(options).map(({ group, items }) => (
        <MenuGroup key={group ?? `ungrouped-${items[0]?.index ?? 0}`} group={group}>
          {items.map(({ option, index }) => (
            <div
              key={index}
              className={`fleet-select-option${index === active ? ' is-active' : ''}`}
              role="option"
              id={optionId(index)}
              data-index={index}
              aria-selected={index === selectedIndex}
              aria-disabled={option.disabled ? true : undefined}
              onPointerMove={() => {
                if (!option.disabled && active !== index) setActive(index)
              }}
              onClick={() => choose(index)}
            >
              <CheckIcon />
              <span className="fleet-select-text">
                <span>{option.label}</span>
                {option.description ? <small>{option.description}</small> : null}
              </span>
            </div>
          ))}
        </MenuGroup>
      ))}
    </div>
  ) : null

  return (
    <>
      {nativeSelect}
      <button
        ref={triggerRef}
        type="button"
        className={`fleet-select${block ? ' is-block' : ''}${className ? ` ${className}` : ''}`}
        style={!block && measured ? { minWidth: `${measured.width}px` } : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label ? `${label}: ${text}` : text}
        aria-describedby={props['aria-describedby']}
        disabled={disabled}
        title={title}
        onClick={() => (open ? close(true) : show())}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="fleet-select-value">{text}</span>
        <ChevronIcon className="fleet-select-chevron" />
      </button>
      {menu && container ? createPortal(menu, container) : null}
    </>
  )
}

function MenuGroup({ group, children }: { group: string | undefined; children: ReactNode }) {
  if (!group) return <>{children}</>
  return (
    <>
      <div className="fleet-select-group" role="presentation">
        {group}
      </div>
      {children}
    </>
  )
}

interface Grouped<V extends string> {
  readonly group: string | undefined
  readonly items: { readonly option: SelectOption<V>; readonly index: number }[]
}

/** Consecutive options with the same group form one group, as optgroups do. */
function groupOptions<V extends string>(options: readonly SelectOption<V>[]): Grouped<V>[] {
  const out: Grouped<V>[] = []
  options.forEach((option, index) => {
    const last = out[out.length - 1]
    if (last && last.group === option.group) last.items.push({ option, index })
    else out.push({ group: option.group, items: [{ option, index }] })
  })
  return out
}
