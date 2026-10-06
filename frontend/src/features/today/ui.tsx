// The Day board's own link chips (.day-links, public/day.js). The shared page blocks
// (page head, stat, row, section...) live in components/ui.
import { Icon } from '../../components/Icon'
import { linkLabel } from '../../domain/links'

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
