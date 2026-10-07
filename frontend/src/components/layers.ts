// Where floating things (dialogs, select menus, the toast) are put, and the media
// queries the shell and primitives share. A dialog provides its own backdrop as the
// container, so a select menu opened inside it stays inside the modal layer: inside
// the focus trap and outside the inert background.
import { createContext, useContext, useSyncExternalStore } from 'react'

/** Body children carrying this attribute are layers, never made inert by a dialog. */
export const LAYER_ATTRIBUTE = 'data-fleet-layer'

export const PortalContainerContext = createContext<HTMLElement | null>(null)

/** The element floating content should portal into: the open dialog's backdrop, else the body. */
export function usePortalContainer(): HTMLElement | null {
  const container = useContext(PortalContainerContext)
  return container ?? (typeof document === 'undefined' ? null : document.body)
}

/** Touch widths get the native select picker, as the legacy select.js decided. */
export const TOUCH_QUERY = '(max-width:720px), (pointer:coarse)'
/** The phone layout. */
export const MOBILE_QUERY = '(max-width:720px)'
/** Wide enough to show the inspector beside the conversation by default. */
export const WIDE_QUERY = '(min-width:1200px)'

const media = (query: string): MediaQueryList | null =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query) : null

/** Whether a media query matches, live. False where matchMedia does not exist (tests). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    onChange => {
      const list = media(query)
      if (!list) return () => {}
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    () => media(query)?.matches ?? false,
    () => false,
  )
}

export const matchesMedia = (query: string): boolean => media(query)?.matches ?? false

/** Elements a keyboard user can reach, in the order legacy app.js listed them. */
export const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

/** Focusable and actually shown: not inside a hidden or inert subtree. */
export function focusables(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el => {
    if (el.closest('[hidden],[inert]')) return false
    if (el.getAttribute('aria-hidden') === 'true' && el.tabIndex < 0) return false
    const visible = (el as HTMLElement & { checkVisibility?: () => boolean }).checkVisibility
    return typeof visible === 'function' ? visible.call(el) : true
  })
}
