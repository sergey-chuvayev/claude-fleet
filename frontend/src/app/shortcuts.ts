// The app-wide keyboard shortcuts: Cmd/Ctrl+N opens New agent, Cmd/Ctrl+K opens
// Search, from any view and over any other modal (which the new one replaces), as
// in legacy control.js and ask.js. One document listener for the app's lifetime;
// StrictMode's double mount adds and removes it, never leaving two.
import { useEffect } from 'react'
import { useDispatch } from './AppStore'
import type { ModalState } from './state'

export type Shortcut = 'launch' | 'search'

/** The shortcut a key press means, if any. Shift or Alt variants are left to the browser. */
export function shortcutFor(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>): Shortcut | null {
  if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return null
  const key = event.key.toLowerCase()
  return key === 'n' ? 'launch' : key === 'k' ? 'search' : null
}

const MODAL: Record<Shortcut, ModalState> = { launch: { kind: 'launch' }, search: { kind: 'search' } }

export function useGlobalShortcuts(target: Pick<Document, 'addEventListener' | 'removeEventListener'> = document): void {
  const dispatch = useDispatch()
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return
      const shortcut = shortcutFor(event)
      if (!shortcut) return
      event.preventDefault()
      dispatch({ type: 'open-modal', modal: MODAL[shortcut] })
    }
    target.addEventListener('keydown', onKeyDown)
    return () => target.removeEventListener('keydown', onKeyDown)
  }, [dispatch, target])
}

/** How the platform writes a shortcut: ⌘K on Apple devices, Ctrl K elsewhere. */
export function shortcutLabel(letter: string): string {
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform
  return /Mac|iPhone|iPad/.test(platform) ? `⌘${letter}` : `Ctrl ${letter}`
}
