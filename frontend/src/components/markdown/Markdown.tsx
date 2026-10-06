// Agent prose as sanitized HTML. This and the code blocks fed by cachedHighlight are
// the only places a component injects HTML; the string always comes from render.ts.
import { memo } from 'react'
import { cachedMarkdown } from './cache'

export interface MarkdownProps {
  readonly source: string
  /** Highlight fenced code. Off while a reply is still streaming in. */
  readonly highlight?: boolean
  readonly className?: string
}

export const Markdown = memo(function Markdown({ source, highlight = true, className = 'block-prose' }: MarkdownProps) {
  // Sanitized by renderMarkdown; nothing else reaches the HTML boundary.
  return <div className={className} dangerouslySetInnerHTML={{ __html: cachedMarkdown(source, highlight) }} />
})
