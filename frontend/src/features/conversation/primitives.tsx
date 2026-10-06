// Small private primitives for the conversation. Each has a shared counterpart being
// built in components/ (Disclosure, CopyButton, Icon); they are kept tiny here so the
// switch is a swap of imports.
import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react'

/**
 * Copy to the clipboard, with the textarea fallback for a page without clipboard
 * permission. Resolves true when something was copied.
 * TODO(shared-primitives): use the shared clipboard helper from components/CopyButton.
 */
export async function copyToClipboard(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    // fall through to the selection fallback
  }
  try {
    const area = document.createElement('textarea')
    area.value = value
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.append(area)
    area.select()
    const ok = document.execCommand?.('copy') ?? false
    area.remove()
    return ok
  } catch {
    return false
  }
}

/**
 * The block's copy action. Says what happened in its own title for a moment, and
 * through `onNotice` (the app's toast) when one is given.
 * TODO(shared-primitives): replace with components/CopyButton.
 */
export function CopyButton({ value, onNotice }: { value: () => string; onNotice?: ((text: string) => void) | undefined }) {
  const [done, setDone] = useState<'' | 'copied' | 'failed'>('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])
  const copy = async () => {
    const ok = await copyToClipboard(value())
    onNotice?.(ok ? 'Block copied' : 'Copying needs clipboard permission')
    setDone(ok ? 'copied' : 'failed')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setDone(''), 1500)
  }
  const title = done === 'copied' ? 'Copied' : done === 'failed' ? 'Copying needs clipboard permission' : 'Copy block'
  return (
    <button type="button" className="block-button" data-copy="" title={title} aria-label={title} onClick={() => void copy()}>
      ⧉
    </button>
  )
}

/**
 * A native <details> whose open state belongs to the component, so a re-render with
 * new content (a report that grew) never folds what the operator opened.
 * TODO(shared-primitives): replace with components/Disclosure.
 */
export function Disclosure({
  summary,
  defaultOpen = false,
  className,
  name,
  children,
}: {
  summary: ReactNode
  defaultOpen?: boolean
  className?: string
  /** A stable marker for tests and styles (legacy `data-delegation`). */
  name?: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <details className={className} data-delegation={name} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>{summary}</summary>
      {open ? children : null}
    </details>
  )
}

/**
 * The 3x3 pixel mark for something running now (public/ui.js `running`).
 * TODO(shared-primitives): replace with the shared Icon/PixelRun once it exists.
 */
export function PixelRun({ label = 'Running' }: { label?: string }) {
  return (
    <span className="pixel-run" role="img" aria-label={label}>
      {Array.from({ length: 9 }, (_, i) => (
        <i key={i} />
      ))}
    </span>
  )
}

/**
 * True once the element has come near the viewport, and from then on. Without an
 * IntersectionObserver (tests, old engines) everything counts as seen.
 */
export function useSeen(ref: RefObject<Element | null>, enabled = true): boolean {
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
      { rootMargin: '400px 0px' },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, seen, enabled])
  return seen
}
