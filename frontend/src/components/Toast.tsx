// Short confirmations and announcements.
//
// toast(message): the legacy #toast, a box at the bottom of the window for three
// seconds (role=status, so it is also read out politely). A new message replaces it.
// announce(message): words for screen readers only, in one polite live region, for a
// status the eye already sees (a list filtered, a refresh done). Bursts are coalesced
// (the last one wins), and a conversation never streams into it: announce outcomes,
// not tokens.
//
// Both live outside the app root as layers, so an open dialog's inert background
// does not silence them.
import { type ReactNode, createContext, useContext, useEffect, useMemo, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { LAYER_ATTRIBUTE } from './layers'

const TOAST_MS = 3000
const ANNOUNCE_COALESCE_MS = 250

type Listener = () => void

export class Notifier {
  private toastText = ''
  private announcement = ''
  private toastTimer: ReturnType<typeof setTimeout> | null = null
  private announceTimer: ReturnType<typeof setTimeout> | null = null
  private pending: string | null = null
  private readonly listeners = new Set<Listener>()

  toast = (message: string): void => {
    this.toastText = message
    if (this.toastTimer) clearTimeout(this.toastTimer)
    this.toastTimer = setTimeout(() => {
      this.toastTimer = null
      this.toastText = ''
      this.emit()
    }, TOAST_MS)
    this.emit()
  }

  announce = (message: string): void => {
    this.pending = message
    if (this.announceTimer) return
    this.announceTimer = setTimeout(() => {
      this.announceTimer = null
      const text = this.pending ?? ''
      this.pending = null
      // The same words twice in a row are still a new announcement: clear first.
      if (text === this.announcement) {
        this.announcement = ''
        this.emit()
      }
      this.announcement = text
      this.emit()
    }, ANNOUNCE_COALESCE_MS)
  }

  getToast = (): string => this.toastText
  getAnnouncement = (): string => this.announcement
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    if (this.toastTimer) clearTimeout(this.toastTimer)
    if (this.announceTimer) clearTimeout(this.announceTimer)
    this.toastTimer = null
    this.announceTimer = null
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

const NotifierContext = createContext<Notifier | null>(null)

export function NotificationsProvider({ notifier, children }: { notifier: Notifier; children: ReactNode }) {
  useEffect(() => () => notifier.dispose(), [notifier])
  return (
    <NotifierContext.Provider value={notifier}>
      {children}
      <NotificationLayer notifier={notifier} />
    </NotifierContext.Provider>
  )
}

function NotificationLayer({ notifier }: { notifier: Notifier }) {
  const toast = useSyncExternalStore(notifier.subscribe, notifier.getToast, notifier.getToast)
  const announcement = useSyncExternalStore(notifier.subscribe, notifier.getAnnouncement, notifier.getAnnouncement)
  const layer = useMemo(() => ({ [LAYER_ATTRIBUTE]: 'notifications' }), [])
  if (typeof document === 'undefined') return null
  return createPortal(
    <div {...layer}>
      <div id="toast" className="toast" role="status" hidden={!toast}>
        {toast}
      </div>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-announcer="">
        {announcement}
      </div>
    </div>,
    document.body,
  )
}

function useNotifier(): Notifier {
  const notifier = useContext(NotifierContext)
  if (!notifier) throw new Error('Toasts need a NotificationsProvider above them.')
  return notifier
}

/** The toast where a NotificationsProvider exists, else null (isolated component tests). */
export const useOptionalToast = (): ((message: string) => void) | null => useContext(NotifierContext)?.toast ?? null

/** Show a short message in the toast box. */
export const useToast = (): ((message: string) => void) => useNotifier().toast
/** Say something to screen readers only. */
export const useAnnounce = (): ((message: string) => void) => useNotifier().announce
