// The page building blocks (public/ui.js, FleetUI): page head, stat, bar, ring,
// section, pill, callout, group, list, row, log and link chips. Every page (Sessions,
// Today, Projects, Progress, Worktrees) draws with these, so a header, a stat, a
// section label or a list row looks and behaves the same wherever it appears. Same
// classes and markup as legacy; the styles are in styles/components.css. An empty
// tone draws no data-tone, as legacy `attr()` did.
import type { ReactNode } from 'react'
import { linkLabel, isWebLink } from '../domain/links'
import { Disclosure } from './Disclosure'
import { Icon } from './Icon'

const toneOf = (tone: string | null | undefined): string | undefined => tone || undefined

/** The head of a page: its title in the shared top band, actions on the right, an optional strip of stats underneath. */
export function PageHead({
  title,
  actions,
  strip,
  className,
}: {
  title: ReactNode
  actions?: ReactNode
  strip?: ReactNode
  className?: string | undefined
}) {
  return (
    <header className={`page-head${className ? ` ${className}` : ''}`}>
      <div className="page-title">
        <h2>{title}</h2>
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
      {strip ? <div className="page-strip">{strip}</div> : null}
    </header>
  )
}

/** One figure in a stats strip: a small label over its value. */
export function Stat({
  label,
  tone,
  title,
  children,
}: {
  label: string
  tone?: string | undefined
  title?: string | undefined
  children: ReactNode
}) {
  return (
    <span className="ui-stat" data-tone={toneOf(tone)} title={title}>
      <b>{label}</b>
      <span className="ui-stat-value">{children}</span>
    </span>
  )
}

/** A small meter, 0 to 100. */
export function Bar({ percent, tone }: { percent: number | null | undefined; tone?: string | undefined }) {
  return (
    <span className="mini-bar" data-tone={toneOf(tone)}>
      <i style={{ width: `${Math.max(0, Math.min(100, Math.round(percent || 0)))}%` }} />
    </span>
  )
}

/** Progress as a ring: done out of total. */
export function Ring({ done, total }: { done: number; total: number }) {
  const circumference = 2 * Math.PI * 7
  const share = total ? Math.min(1, done / total) : 0
  return (
    <svg className="ui-ring" viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="9" cy="9" r="7" />
      <circle cx="9" cy="9" r="7" className="is-done" strokeDasharray={`${(share * circumference).toFixed(2)} ${circumference.toFixed(2)}`} />
    </svg>
  )
}

/** A section: an uppercase label with an optional count and something on its right, then its body. */
export function Section({
  label,
  count,
  aside,
  className,
  children,
}: {
  label: string
  count?: number | string | null | undefined
  aside?: ReactNode
  className?: string | undefined
  children: ReactNode
}) {
  return (
    <section className={`ui-section${className ? ` ${className}` : ''}`}>
      <h4 className="ui-label">
        {label}
        {count != null ? <span className="ui-count">{count}</span> : null}
        {aside ? <span className="ui-label-aside">{aside}</span> : null}
      </h4>
      {children}
    </section>
  )
}

/** A small status word. */
export function Pill({ tone, title, children }: { tone?: string | undefined; title?: string | undefined; children: ReactNode }) {
  return (
    <span className="ui-pill" data-tone={toneOf(tone)} title={title}>
      {children}
    </span>
  )
}

/** A boxed note inside a page, for something the reader should know first. */
export function Callout({ title, tone, children }: { title: ReactNode; tone?: string | undefined; children?: ReactNode }) {
  return (
    <div className="ui-callout" data-tone={toneOf(tone)}>
      <strong>{title}</strong>
      {children ? <p>{children}</p> : null}
    </div>
  )
}

/** A group inside a section (Must, Should, Could...): a coloured mark, its name, a count, and what sits at the end. */
export function Group({ label, count, end, tone }: { label: string; count?: number | null | undefined; end?: ReactNode; tone?: string | undefined }) {
  return (
    <h5 className="ui-group" data-tone={toneOf(tone)}>
      <i aria-hidden="true" />
      {label}
      {count != null ? <span>{count}</span> : null}
      {end ? <small>{end}</small> : null}
    </h5>
  )
}

export function List({ children, compact = false }: { children: ReactNode; compact?: boolean }) {
  return <ol className={`ui-list${compact ? ' is-compact' : ''}`}>{children}</ol>
}

export interface RowProps {
  readonly tone?: string | undefined
  readonly orbTitle?: string | undefined
  readonly title: ReactNode
  readonly meta?: ReactNode
  readonly side?: ReactNode
  /** With a detail the row opens in place. */
  readonly detail?: ReactNode
  /** Controlled open state; leave undefined to let the row keep its own. */
  readonly open?: boolean | undefined
  readonly onOpenChange?: ((open: boolean) => void) | undefined
  /** Render the detail only while open. */
  readonly lazy?: boolean | undefined
  /** data-evidence on the <details>, as legacy keyed rows so a redraw could keep them open. */
  readonly evidence?: string | undefined
  /** data-card on the row, for rows other parts of the page scroll to. */
  readonly card?: string | undefined
  /** Briefly highlight the row (.is-flash). */
  readonly flash?: boolean | undefined
}

/** A list row: a status orb, a title, one quiet line of meta, and what sits on the right. */
export function Row({ tone, orbTitle, title, meta, side, detail, open, onOpenChange, lazy, evidence, card, flash }: RowProps) {
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
  return (
    <li className={`ui-row${flash ? ' is-flash' : ''}`} data-tone={tone || 'todo'} data-card={card}>
      {detail ? (
        <Disclosure
          summary={head}
          summaryClassName="ui-row-head"
          open={open}
          onOpenChange={onOpenChange}
          lazy={lazy}
          {...(evidence ? { 'data-evidence': evidence } : {})}
        >
          <div className="ui-row-detail">{detail}</div>
        </Disclosure>
      ) : (
        <div className="ui-row-head">{head}</div>
      )}
    </li>
  )
}

/** A log: time, then what happened. */
export function Log({ entries }: { entries: ReadonlyArray<readonly [string, ReactNode]> }) {
  if (!entries.length) return null
  return (
    <ol className="ui-log">
      {entries.map(([time, text], index) => (
        <li key={`${index}:${time}`}>
          <time>{time}</time>
          {text}
        </li>
      ))}
    </ol>
  )
}

/** Links as small chips that open in the browser. `limit` shows the first few and counts the rest. Non-web links are dropped. */
export function LinkChips({ urls, limit = Number.POSITIVE_INFINITY, quiet = false }: { urls: readonly string[] | undefined; limit?: number; quiet?: boolean }) {
  const web = (urls ?? []).filter(isWebLink)
  if (!web.length) return null
  const shown = web.slice(0, limit)
  const more = web.length - shown.length
  return (
    <span className={`ui-links${quiet ? ' is-quiet' : ''}`}>
      {shown.map(url => (
        <a key={url} href={url} target="_blank" rel="noopener noreferrer" title={url}>
          {linkLabel(url)}
          <Icon name="arrow" />
        </a>
      ))}
      {more > 0 ? <span className="ui-links-more">+{more}</span> : null}
    </span>
  )
}
