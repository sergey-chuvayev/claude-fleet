// Copy text to the clipboard. The async Clipboard API first; where it is missing or
// refused (an http origin, a dismissed permission prompt) the older selection copy;
// and, optionally, when both fail the text is shown under the button, selected, so it
// can be copied by hand (legacy did this for the resume command).
//
// The outcome is said three ways: the button's own title and name for a moment, the
// app toast (or `onNotice` when given), and the fallback text when enabled.
import { type ButtonHTMLAttributes, type ReactNode, useEffect, useRef, useState } from 'react'
import { useOptionalToast } from './Toast'

export interface CopyButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'children' | 'type'> {
  /** The text, or a function that produces it at click time. */
  readonly text: string | (() => string)
  readonly children: ReactNode
  /** Said after a successful copy. */
  readonly copiedMessage?: string | undefined
  /** Said when nothing could be copied. */
  readonly failedMessage?: string | undefined
  /** The button's title and name for a moment after copying; default the messages. */
  readonly copiedTitle?: string | undefined
  readonly failedTitle?: string | undefined
  /** Where the outcome goes; defaults to the app toast when there is one. */
  readonly onNotice?: ((message: string) => void) | undefined
  /** Show the text under the button when copying failed. */
  readonly fallback?: boolean | undefined
  /** Data attributes for the button. */
  readonly [data: `data-${string}`]: string | undefined
}

const FEEDBACK_MS = 1500

/** Copy through the selection, for browsers without (or refusing) the Clipboard API. */
export function selectionCopy(text: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.append(area)
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
  area.select()
  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  }
  area.remove()
  previous?.focus({ preventScroll: true })
  return copied
}

/** Copy `text`; resolves true when it reached the clipboard. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Refused: fall through to the selection copy.
  }
  return selectionCopy(text)
}

export function CopyButton({
  text,
  children,
  copiedMessage = 'Copied',
  failedMessage = 'Clipboard unavailable. The text is shown below.',
  copiedTitle = copiedMessage,
  failedTitle = failedMessage,
  onNotice,
  fallback = true,
  className = 'button ghost',
  title,
  'aria-label': ariaLabel,
  ...rest
}: CopyButtonProps) {
  const toast = useOptionalToast()
  const [shown, setShown] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<'copied' | 'failed' | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fallbackRef = useRef<HTMLPreElement>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )
  useEffect(() => {
    if (shown === null || !fallbackRef.current) return
    const range = document.createRange()
    range.selectNodeContents(fallbackRef.current)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }, [shown])

  const onClick = async () => {
    const value = typeof text === 'function' ? text() : text
    if (!value) return
    const copied = await copyToClipboard(value)
    const message = copied ? copiedMessage : failedMessage
    ;(onNotice ?? toast)?.(message)
    setShown(!copied && fallback ? value : null)
    setOutcome(copied ? 'copied' : 'failed')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setOutcome(null), FEEDBACK_MS)
  }

  // While the outcome shows, a titled button says it in its title and name.
  const said = outcome === 'copied' ? copiedTitle : outcome === 'failed' ? failedTitle : null
  return (
    <>
      <button
        {...rest}
        type="button"
        className={className}
        title={said && title ? said : title}
        aria-label={said && ariaLabel ? said : ariaLabel}
        onClick={() => void onClick()}
      >
        {children}
      </button>
      {shown !== null ? (
        <pre ref={fallbackRef} className="response copy-fallback" tabIndex={0}>
          {shown}
        </pre>
      ) : null}
    </>
  )
}
