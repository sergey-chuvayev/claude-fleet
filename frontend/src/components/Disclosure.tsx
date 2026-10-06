// A native <details> disclosure. The browser keeps it keyboard operable and
// announced; this keeps it open across re-renders (uncontrolled by default, so a
// server update never snaps it shut) and reports toggles for callers that remember
// which ones are open. The legacy shapes: UI.fold (.ui-fold with a chevron and a
// count) and any plain details with a summary.
import { type ReactNode, type SyntheticEvent, useCallback } from 'react'

export interface DisclosureProps {
  readonly summary: ReactNode
  readonly children: ReactNode
  /** Controlled: the caller owns the state and updates it from onOpenChange. */
  readonly open?: boolean
  /** Uncontrolled initial state. */
  readonly defaultOpen?: boolean
  readonly onOpenChange?: (open: boolean) => void
  readonly className?: string
  readonly summaryClassName?: string
  /** Draw the legacy .ui-chevron before the summary content. */
  readonly chevron?: boolean
  /** A count badge after the summary (.ui-count), as UI.fold drew it. */
  readonly count?: number
  readonly id?: string
}

export function Disclosure({
  summary,
  children,
  open,
  defaultOpen,
  onOpenChange,
  className,
  summaryClassName,
  chevron = false,
  count,
  id,
}: DisclosureProps) {
  const onToggle = useCallback(
    (event: SyntheticEvent<HTMLDetailsElement>) => {
      const next = event.currentTarget.open
      if (next !== open) onOpenChange?.(next)
    },
    [open, onOpenChange],
  )
  // React sets `open` only when the prop changes, so an uncontrolled details keeps
  // whatever the operator did to it.
  const openProps = open !== undefined ? { open } : defaultOpen ? { open: true } : {}
  return (
    <details id={id} className={className} onToggle={onToggle} {...openProps}>
      <summary className={summaryClassName}>
        {chevron ? <span className="ui-chevron" aria-hidden="true" /> : null}
        {summary}
        {count !== undefined ? <span className="ui-count">{count}</span> : null}
      </summary>
      {children}
    </details>
  )
}

/** UI.fold: Later, Done and other folded sections of a page. */
export function Fold(props: Omit<DisclosureProps, 'chevron'>) {
  return <Disclosure {...props} chevron className={`ui-fold${props.className ? ` ${props.className}` : ''}`} />
}
