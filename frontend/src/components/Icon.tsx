// The legacy icon set. The stroke icons are CSS masks (`.ico-*` in components.css,
// the same SVGs as public/styles.css), filled with the text colour, so they follow
// their button's colour and state. The few icons the legacy markup drew inline (the
// dropdown chevron, the select check, the inspector toggle) are inline here too.

export const ICONS = ['arrow', 'plus', 'refresh', 'search', 'close', 'stop', 'pr', 'ticket'] as const
export type IconName = (typeof ICONS)[number]

/** A decorative icon. Give the control around it the accessible name. */
export function Icon({ name, className }: { name: IconName; className?: string }) {
  return <i className={`ico ico-${name}${className ? ` ${className}` : ''}`} aria-hidden="true" />
}

/** The one chevron every dropdown-shaped control uses. */
export function ChevronIcon({ className = 'filter-chevron' }: { className?: string }) {
  return (
    <svg className={className} width="10" height="6" viewBox="0 0 10 6" fill="none" aria-hidden="true">
      <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** The tick beside the selected option in a select menu. */
export function CheckIcon({ className = 'fleet-select-check' }: { className?: string }) {
  return (
    <svg className={className} width="12" height="9" viewBox="0 0 12 9" fill="none" aria-hidden="true">
      <path d="M1 4.5L4.2 7.5L11 1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** A window with a side panel: the inspector toggle in the top bar. */
export function PanelIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="3" stroke="currentColor" strokeWidth="1.5" />
      <path d="M15 4v16" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}
