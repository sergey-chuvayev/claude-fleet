// A latch for deferred work (highlighting, Markdown): true once the element has come
// near the viewport, and from then on. Without an IntersectionObserver (tests, old
// engines) everything counts as seen.
import { type RefObject, useEffect, useState } from 'react'

export function useSeen(ref: RefObject<Element | null>, enabled = true, rootMargin = '400px 0px'): boolean {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver !== 'function')
  useEffect(() => {
    if (seen || !enabled) return
    const element = ref.current
    if (!element) return
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          setSeen(true)
          observer.disconnect()
        }
      },
      { rootMargin },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, seen, enabled, rootMargin])
  return seen
}
