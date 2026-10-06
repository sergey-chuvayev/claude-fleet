// UI.empty: what a page or pane says when there is nothing in it yet.
import type { ReactNode } from 'react'

export function EmptyState({ title, text, children, className }: { title: ReactNode; text?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={`ui-empty${className ? ` ${className}` : ''}`}>
      <h3>{title}</h3>
      {text ? <p>{text}</p> : null}
      {children}
    </div>
  )
}
