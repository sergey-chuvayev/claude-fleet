// The building blocks of a page (public/ui.js, FleetUI): a head with stats, a section,
// a pill, an orb, a list row that opens in place, link chips. Projects, Progress and
// Worktrees draw with these. The styles are shared (components.css).
// TODO: promote to components/ when a second feature area needs them (Today has its own).
import { type ReactNode } from 'react'
import { Disclosure } from '../../components/Disclosure'
import { Icon } from '../../components/Icon'

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

/** One figure in a stats strip: a small label over its value. */
export function Stat({ label, tone, title, children }: { label: string; tone?: string | undefined; title?: string | undefined; children: ReactNode }) {
  return (
    <span className="ui-stat" data-tone={tone} title={title}>
      <b>{label}</b>
      <span className="ui-stat-value">{children}</span>
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

/** A section: an uppercase label with an optional count and something on its right. */
export function Section({
  title,
  count,
  aside,
  children,
}: {
  title: string
  count?: number | string | undefined
  aside?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="ui-section">
      <h4 className="ui-label">
        {title}
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

export function Callout({ title, tone, children }: { title: ReactNode; tone?: string | undefined; children?: ReactNode }) {
  return (
    <div className="ui-callout" data-tone={tone}>
      <strong>{title}</strong>
      {children ? <p>{children}</p> : null}
    </div>
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
  /** With a detail the row opens in place; its open state belongs to the caller. */
  readonly detail?: ReactNode
  readonly open?: boolean | undefined
  readonly onOpenChange?: ((open: boolean) => void) | undefined
  /** data-evidence, as legacy keyed rows so a redraw could keep them open. */
  readonly evidence?: string | undefined
}

/** A list row: a status orb, a title, one quiet line of meta, and what sits on the right. */
export function Row({ tone, orbTitle, title, meta, side, detail, open, onOpenChange, evidence }: RowProps) {
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
    <li className="ui-row" data-tone={tone || 'todo'}>
      {detail ? (
        <Disclosure
          summary={head}
          summaryClassName="ui-row-head"
          open={open}
          onOpenChange={onOpenChange}
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

/** A link as the thing it points at: TECH-5163, api-allo#4638, Slack, Notion. */
export function linkLabel(url: string): string {
  const linear = url.match(/linear\.app\/[^/]+\/issue\/([A-Za-z]+-\d+)/)
  if (linear) return linear[1]!.toUpperCase()
  const pr = url.match(/github\.com\/[^/]+\/([^/]+)\/(?:pull|issues)\/(\d+)/)
  if (pr) return `${pr[1]}#${pr[2]}`
  const known: ReadonlyArray<readonly [RegExp, string]> = [
    [/slack\.com/, 'Slack'],
    [/notion\.(so|site)/, 'Notion'],
    [/granola\.ai/, 'Granola'],
    [/figma\.com/, 'Figma'],
    [/docs\.google\.com/, 'Google Doc'],
    [/usepylon\.com|pylon/, 'Pylon'],
  ]
  for (const [pattern, name] of known) if (pattern.test(url)) return name
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return 'Link'
  }
}

/** Only web links become anchors; anything else (a javascript: url in a hand-edited file) is dropped. */
export const isWebLink = (url: string): boolean => /^https?:\/\//i.test(url)

/** Links as small chips that open in the browser. `limit` shows the first few and counts the rest. */
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

/** A log: time, then what happened. */
export function Log({ entries }: { entries: ReadonlyArray<readonly [string, string]> }) {
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
