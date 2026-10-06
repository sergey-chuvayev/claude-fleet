// The one modal layer (plan section 4): a dialog is an overlay, never a panel that
// pushes the workspace down. While one is mounted:
//   - everything else on the page is inert (body children that are not layers);
//   - Tab and Shift+Tab cycle inside it, and focus that escapes is pulled back;
//   - Escape, a click on the backdrop (press and release both on it) or any
//     [data-close-modal] element inside closes it through `onClose`;
//   - unmounting returns focus to whatever had it when the dialog opened.
// Mounting is opening: the app's modal registry mounts at most one at a time.
//
// Same markup as the legacy dialogs: .modal-backdrop > section.modal[role=dialog].
import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'
import { LAYER_ATTRIBUTE, PortalContainerContext, focusables } from './layers'

export interface DialogProps {
  /** Called for Escape, a backdrop click and [data-close-modal]. The owner unmounts the dialog. */
  readonly onClose: () => void
  /** Id of the element that names the dialog (its h2). */
  readonly labelledBy: string
  readonly describedBy?: string | undefined
  /** Classes of the section, e.g. "modal modal-ask". Defaults to "modal". */
  readonly className?: string | undefined
  /** Id of the backdrop, which the opener's aria-controls names (e.g. "ask-backdrop"). */
  readonly id?: string | undefined
  /** CSS selector of the element to focus on open; else the first focusable, else the dialog. */
  readonly initialFocus?: string | undefined
  /** False for a dialog that must not close on a stray backdrop click. */
  readonly closeOnBackdrop?: boolean | undefined
  readonly children: ReactNode
}

// Exactly one modal layer: a second dialog mounting while one is open is a bug in
// the caller (the registry never does it), reported rather than stacked silently.
let openLayers = 0

export function Dialog({
  onClose,
  labelledBy,
  describedBy,
  className = 'modal',
  id,
  initialFocus,
  closeOnBackdrop = true,
  children,
}: DialogProps) {
  const [backdrop, setBackdrop] = useState<HTMLDivElement | null>(null)
  const sectionRef = useRef<HTMLElement>(null)
  const pressedOnBackdrop = useRef(false)
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  })

  // Open: remember the opener, make the rest inert, move focus in. Close: undo all of
  // it. A layout effect, so focus has moved before the first paint.
  useLayoutEffect(() => {
    if (!backdrop) return
    openLayers++
    if (openLayers > 1 && import.meta.env.DEV) console.warn('Fleet: a second dialog opened over another one.')
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const madeInert: HTMLElement[] = []
    for (const el of [...document.body.children]) {
      if (!(el instanceof HTMLElement) || el === backdrop || el.hasAttribute(LAYER_ATTRIBUTE) || el.inert) continue
      el.inert = true
      madeInert.push(el)
    }
    document.body.setAttribute('data-modal', '')

    const section = sectionRef.current
    const target =
      (initialFocus ? backdrop.querySelector<HTMLElement>(initialFocus) : null) ??
      (section ? focusables(section)[0] : null) ??
      section
    target?.focus()
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) target.select()

    // Focus that lands outside (a click on a layer, a script) comes back in.
    const onFocusIn = (event: FocusEvent) => {
      const to = event.target
      if (!(to instanceof Node) || backdrop.contains(to)) return
      ;(section ? (focusables(section)[0] ?? section) : backdrop).focus()
    }
    document.addEventListener('focusin', onFocusIn)

    return () => {
      document.removeEventListener('focusin', onFocusIn)
      openLayers--
      for (const el of madeInert) el.inert = false
      if (openLayers === 0) document.body.removeAttribute('data-modal')
      if (opener?.isConnected) opener.focus()
    }
    // initialFocus is read once, at open, on purpose.
  }, [backdrop])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close.current()
      return
    }
    if (event.key !== 'Tab' || !sectionRef.current) return
    const items = focusables(sectionRef.current)
    if (!items.length) {
      event.preventDefault()
      return
    }
    const first = items[0]!
    const last = items[items.length - 1]!
    const active = document.activeElement
    const inside = active instanceof Node && sectionRef.current.contains(active)
    if (event.shiftKey && (active === first || !inside)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (active === last || !inside)) {
      event.preventDefault()
      first.focus()
    }
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    pressedOnBackdrop.current = event.target === event.currentTarget
  }
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as Element
    if (target.closest?.('[data-close-modal]') && backdrop?.contains(target)) {
      close.current()
      return
    }
    // A drag that began inside the dialog and ended on the backdrop is not a dismissal.
    if (closeOnBackdrop && target === event.currentTarget && pressedOnBackdrop.current) close.current()
    pressedOnBackdrop.current = false
  }

  return createPortal(
    <div
      ref={setBackdrop}
      className="modal-backdrop"
      id={id}
      {...{ [LAYER_ATTRIBUTE]: 'dialog' }}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onClick={onClick}
    >
      <PortalContainerContext.Provider value={backdrop}>
        <section
          ref={sectionRef}
          className={className}
          role="dialog"
          aria-modal="true"
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
          tabIndex={-1}
        >
          {children}
        </section>
      </PortalContainerContext.Provider>
    </div>,
    document.body,
  )
}

export interface DialogHeadProps {
  /** Id for the h2; pass the same value as the Dialog's labelledBy. */
  readonly titleId: string
  readonly title: ReactNode
  /** The small uppercase line above the title. */
  readonly eyebrow?: ReactNode | undefined
  /** The glyph in the round tile on the left (✳, ⌘, ⚙). */
  readonly spark?: ReactNode | undefined
  readonly lead?: ReactNode | undefined
  /** Accessible name of the close button, e.g. "Close search". */
  readonly closeLabel: string
}

/** The legacy dialog head: spark, eyebrow, title, lead, close button. */
export function DialogHead({ titleId, title, eyebrow, spark, lead, closeLabel }: DialogHeadProps) {
  return (
    <header className="modal-head">
      <div className="modal-heading">
        {spark ? (
          <span className="modal-spark" aria-hidden="true">
            {spark}
          </span>
        ) : null}
        <div>
          {eyebrow ? <span className="modal-eyebrow">{eyebrow}</span> : null}
          <h2 id={titleId}>{title}</h2>
          {lead ? <p>{lead}</p> : null}
        </div>
      </div>
      <button type="button" className="modal-close" data-close-modal aria-label={closeLabel}>
        <Icon name="close" />
      </button>
    </header>
  )
}

/** The quiet strip at the bottom of a dialog: a sentence on the left, keys on the right. */
export function DialogFoot({ children }: { children: ReactNode }) {
  return <footer className="modal-foot">{children}</footer>
}
