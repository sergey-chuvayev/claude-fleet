// A native <details> disclosure. The browser keeps it keyboard operable and
// announced. Its open state belongs to the component (or to the caller, when
// controlled), so a re-render with new content (a report that grew, a server update)
// never folds what the operator opened. `lazy` renders the body only while open, for
// heavy content (long tool output, Markdown). The legacy shapes: UI.fold (.ui-fold
// with a chevron and a count) and any plain details with a summary.
import { type ReactNode, type SyntheticEvent, useState } from 'react'

export interface DisclosureProps {
  readonly summary: ReactNode
  readonly children: ReactNode
  /** Controlled: the caller owns the state and updates it from onOpenChange. */
  readonly open?: boolean | undefined
  /** Uncontrolled initial state. */
  readonly defaultOpen?: boolean | undefined
  readonly onOpenChange?: ((open: boolean) => void) | undefined
  /** Render the body only while open. */
  readonly lazy?: boolean | undefined
  readonly className?: string | undefined
  readonly summaryClassName?: string | undefined
  /** Draw the legacy .ui-chevron before the summary content. */
  readonly chevron?: boolean | undefined
  /** A count badge after the summary (.ui-count), as UI.fold drew it. */
  readonly count?: number | undefined
  readonly id?: string | undefined
  /** data-* attributes for the <details> (stable markers for styles and tests). */
  readonly [data: `data-${string}`]: string | undefined
}

export function Disclosure({
  summary,
  children,
  open,
  defaultOpen = false,
  onOpenChange,
  lazy = false,
  className,
  summaryClassName,
  chevron = false,
  count,
  id,
  ...data
}: DisclosureProps) {
  const [inner, setInner] = useState(defaultOpen)
  const isOpen = open ?? inner
  const onToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    const next = event.currentTarget.open
    if (next === isOpen) return
    if (open === undefined) setInner(next)
    onOpenChange?.(next)
  }
  return (
    <details id={id} className={className} open={isOpen} onToggle={onToggle} {...data}>
      <summary className={summaryClassName}>
        {chevron ? <span className="ui-chevron" aria-hidden="true" /> : null}
        {summary}
        {count !== undefined ? <span className="ui-count">{count}</span> : null}
      </summary>
      {lazy && !isOpen ? null : children}
    </details>
  )
}

/** UI.fold: Later, Done and other folded sections of a page. */
export function Fold({ className, ...props }: Omit<DisclosureProps, 'chevron'>) {
  return <Disclosure {...props} chevron className={`ui-fold${className ? ` ${className}` : ''}`} />
}
