// Copy text to the clipboard. The async Clipboard API first; where it is missing or
// refused (an http origin, a permission prompt dismissed) the older selection copy;
// and when both fail, the text is shown under the button, selected, so it can be
// copied by hand. Legacy did the last step for the resume command.
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useToast } from './Toast'

export interface CopyButtonProps {
  /** The text, or a function that produces it at click time. */
  readonly text: string | (() => string)
  readonly children: ReactNode
  /** Toast after a successful copy. */
  readonly copiedMessage?: string
  readonly failedMessage?: string
  readonly className?: string
  readonly id?: string
  readonly title?: string
  readonly 'aria-label'?: string
  readonly disabled?: boolean
}

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

/** Copy `text`; true when it reached the clipboard. */
export async function copyText(text: string): Promise<boolean> {
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
  className = 'button ghost',
  id,
  title,
  disabled,
  ...rest
}: CopyButtonProps) {
  const toast = useToast()
  const [shown, setShown] = useState<string | null>(null)
  const fallback = useRef<HTMLPreElement>(null)

  useEffect(() => {
    if (shown === null || !fallback.current) return
    const range = document.createRange()
    range.selectNodeContents(fallback.current)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }, [shown])

  const onClick = async () => {
    const value = typeof text === 'function' ? text() : text
    if (!value) return
    if (await copyText(value)) {
      setShown(null)
      toast(copiedMessage)
    } else {
      setShown(value)
      toast(failedMessage)
    }
  }

  return (
    <>
      <button type="button" className={className} id={id} title={title} disabled={disabled} aria-label={rest['aria-label']} onClick={onClick}>
        {children}
      </button>
      {shown !== null ? (
        <pre ref={fallback} className="response copy-fallback" tabIndex={0}>
          {shown}
        </pre>
      ) : null}
    </>
  )
}
