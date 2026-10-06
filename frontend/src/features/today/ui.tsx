// The page building blocks the Day board draws with (public/ui.js): page head, stat,
// ring, bar, section, pill, orb, row, list, group, log and link chips. Same classes
// and markup as legacy, so components.css styles them.
// TODO(components): Projects and Progress draw the same blocks; move these to
// components/ once a second feature needs them, instead of copying.
import type { ReactNode, SyntheticEvent } from 'react'
import { Icon } from '../../components/Icon'
import { linkLabel } from './day'

export function PageHead({ title, actions, strip }: { title: ReactNode; actions?: ReactNode; strip?: ReactNode }) {
  return (
    <header className="page-head">
      <div className="page-title">
        <h2>{title}</h2>
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
      {strip ? <div className="page-strip">{strip}</div> : null}
    </header>
  )
}

export function Stat({ label, children, tone, title }: { label: string; children: ReactNode; tone?: string | undefined; title?: string | undefined }) {
  return (
    <span className="ui-stat" data-tone={tone} title={title}>
      <b>{label}</b>
      <span className="ui-stat-value">{children}</span>
    </span>
  )
}

export function Bar({ percent, tone }: { percent: number; tone?: string }) {
  const width = Math.max(0, Math.min(100, Math.round(percent || 0)))
  return (
    <span className="mini-bar" data-tone={tone}>
      <i style={{ width: `${width}%` }} />
    </span>
  )
}

/** Progress as a ring: done out of total. */
export function Ring({ done, total }: { done: number; total: number }) {
  const c = 2 * Math.PI * 7
  const share = total ? Math.min(1, done / total) : 0
  return (
    <svg className="ui-ring" viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="9" cy="9" r="7" />
      <circle cx="9" cy="9" r="7" className="is-done" strokeDasharray={`${(share * c).toFixed(2)} ${c.toFixed(2)}`} />
    </svg>
  )
}

export function Section({
  label,
  count,
  aside,
  className,
  children,
}: {
  label: string
  count?: number | undefined
  aside?: ReactNode
  className?: string | undefined
  children: ReactNode
}) {
  return (
    <section className={`ui-section${className ? ` ${className}` : ''}`}>
      <h4 className="ui-label">
        {label}
        {count !== undefined ? <span className="ui-count">{count}</span> : null}
        {aside ? <span className="ui-label-aside">{aside}</span> : null}
      </h4>
      {children}
    </section>
  )
}

export function Pill({ tone, children }: { tone?: string | undefined; children: ReactNode }) {
  return (
    <span className="ui-pill" data-tone={tone}>
      {children}
    </span>
  )
}

export function Group({ label, count, end, tone }: { label: string; count: number; end?: string; tone: string }) {
  return (
    <h5 className="ui-group" data-tone={tone}>
      <i aria-hidden="true" />
      {label}
      <span>{count}</span>
      {end ? <small>{end}</small> : null}
    </h5>
  )
}

export interface RowProps {
  readonly tone: string
  readonly orbTitle: string
  readonly title: ReactNode
  readonly meta?: ReactNode
  readonly side?: ReactNode
  /** With a detail, the row opens in place. */
  readonly detail?: ReactNode
  readonly open?: boolean
  readonly onOpenChange?: (open: boolean) => void
  readonly flash?: boolean
  readonly itemId: string
}

/** A list row: a status orb, a title, one quiet line of meta, what sits on the right. */
export function Row({ tone, orbTitle, title, meta, side, detail, open = false, onOpenChange, flash = false, itemId }: RowProps) {
  const head = (
    <>
      <span className="ui-orb" data-tone={tone || 'todo'} title={orbTitle} />
      <span className="ui-row-body">
        <strong className="ui-row-title">{title}</strong>
        {meta ? <span className="ui-row-meta">{meta}</span> : null}
      </span>
      <span className="ui-row-side">
        {side}
        {detail ? <span className="ui-chevron" aria-hidden="true" /> : null}
      </span>
    </>
  )
  const onToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    const next = event.currentTarget.open
    if (next !== open) onOpenChange?.(next)
  }
  return (
    <li className={`ui-row${flash ? ' is-flash' : ''}`} data-tone={tone || 'todo'} data-card={itemId}>
      {detail ? (
        <details data-evidence={itemId} open={open} onToggle={onToggle}>
          <summary className="ui-row-head">{head}</summary>
          {open ? <div className="ui-row-detail">{detail}</div> : null}
        </details>
      ) : (
        <div className="ui-row-head">{head}</div>
      )}
    </li>
  )
}

export function List({ children, compact = false }: { children: ReactNode; compact?: boolean }) {
  return <ol className={`ui-list${compact ? ' is-compact' : ''}`}>{children}</ol>
}

/** A log: time, then what happened. */
export function Log({ entries }: { entries: ReadonlyArray<{ readonly at: number; readonly text: string }> }) {
  if (!entries.length) return null
  return (
    <ol className="ui-log">
      {entries.map((entry, index) => (
        <li key={`${entry.at}:${index}`}>
          <time>{new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
          {entry.text}
        </li>
      ))}
    </ol>
  )
}

/** An item's links as small chips that open in the browser (the first four). */
export function DayLinks({ links }: { links: readonly string[] }) {
  if (!links.length) return null
  return (
    <span className="day-links">
      {links.slice(0, 4).map(url => (
        <a key={url} href={url} target="_blank" rel="noopener noreferrer" title={url}>
          {linkLabel(url)} <Icon name="arrow" />
        </a>
      ))}
    </span>
  )
}
