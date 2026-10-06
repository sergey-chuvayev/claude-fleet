// Keep a resource fresh while its page is open: refetch on mount when what is held is
// older than the window, then again every window while the tab is visible. Used by
// pages whose server state has no event of its own (hand-edited project files, the
// weekly report, git checkouts).
import { useEffect, useRef } from 'react'
import { useFleetClient } from '../../transport/hooks'

export function useRefreshWhileVisible(key: string, windowMs: number, fetchedAt?: number): void {
  const client = useFleetClient()
  const held = useRef(fetchedAt)
  held.current = fetchedAt
  useEffect(() => {
    if (held.current !== undefined && Date.now() - held.current >= windowMs) client.store.invalidate(key)
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') client.store.invalidate(key)
    }, windowMs)
    return () => clearInterval(timer)
  }, [client, key, windowMs])
}
