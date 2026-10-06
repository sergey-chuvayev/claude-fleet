// The UI.* page pieces the inspector and the delegation detail use (public/ui.js
// pageHead, stat, bar, section, callout, pill). Same markup and classes; the styles
// are already in styles/components.css.
// TODO(components): these are shared building blocks with no React primitive yet.
// Move them to components/ once that package owns them; until then they live here so
// this feature does not edit components/.
import type { ReactNode } from 'react'

export function PageHead({ title, actions, strip, className }: { title: ReactNode; actions?: ReactNode; strip?: ReactNode; className?: string }) {
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
export function Stat({ label, children, tone, title }: { label: string; children: ReactNode; tone?: string | undefined; title?: string }) {
  return (
    <span className="ui-stat" data-tone={tone || undefined} title={title}>
      <b>{label}</b>
      <span className="ui-stat-value">{children}</span>
    </span>
  )
}

export function MiniBar({ percent, tone }: { percent: number | null; tone?: string }) {
  return (
    <span className="mini-bar" data-tone={tone || undefined}>
      <i style={{ width: `${Math.max(0, Math.min(100, Math.round(percent || 0)))}%` }} />
    </span>
  )
}

/** A section: an uppercase label with something on its right, then its body. */
export function Section({ label, aside, children, className }: { label: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`ui-section${className ? ` ${className}` : ''}`}>
      <h4 className="ui-label">
        {label}
        {aside ? <span className="ui-label-aside">{aside}</span> : null}
      </h4>
      {children}
    </section>
  )
}

export function Callout({ title, children, tone }: { title: ReactNode; children?: ReactNode; tone?: string }) {
  return (
    <div className="ui-callout" data-tone={tone || undefined}>
      <strong>{title}</strong>
      {children ? <p>{children}</p> : null}
    </div>
  )
}

export function Pill({ children, tone, title }: { children: ReactNode; tone?: string | undefined; title?: string | undefined }) {
  return (
    <span className="ui-pill" data-tone={tone || undefined} title={title}>
      {children}
    </span>
  )
}
