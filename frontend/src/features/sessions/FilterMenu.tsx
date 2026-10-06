// The list's filter dropdown (#filters): status and creation date in one popover.
// The trigger names the active combination; each choice shows its count. A click
// outside or Escape closes it, Escape returning focus to the trigger.
import { useEffect, useRef, useState } from 'react'
import { ChevronIcon } from '../../components/Icon'
import {
  DATE_FILTERS,
  DATE_LABELS,
  type DateFilter,
  type RowState,
  STATES,
  STATE_LABELS,
  type StatusFilter,
  filterLabel,
} from '../../domain/sessions'
import { setSessionFilter } from './filter'

export interface FilterMenuProps {
  readonly status: StatusFilter
  readonly date: DateFilter
  readonly counts: Readonly<Record<RowState, number>>
  readonly foreground: number
  readonly background: number
  readonly archived: number
  readonly dateCounts: Readonly<Record<DateFilter, number>>
}

export function FilterMenu({ status, date, counts, foreground, background, archived, dateCounts }: FilterMenuProps) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('click', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const statuses: Array<[StatusFilter, string, number]> = [
    ['all', 'All sessions', foreground],
    ...STATES.map((state): [StatusFilter, string, number] => [state, STATE_LABELS[state], counts[state]]),
    ...(background ? [['background', 'Background', background] as [StatusFilter, string, number]] : []),
    ...(archived ? [['archived', 'Archived', archived] as [StatusFilter, string, number]] : []),
  ]
  const choose = (next: Partial<{ status: StatusFilter; date: DateFilter }>) => {
    setSessionFilter(next)
    setOpen(false)
  }

  return (
    <div className="filter-menu" id="filters" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="filter-trigger"
        id="filter-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="filter-panel"
        onClick={() => setOpen(value => !value)}
      >
        {filterLabel(status, date)}
        <ChevronIcon />
      </button>
      <div className="filter-panel" id="filter-panel" role="menu" aria-label="Filter sessions" hidden={!open}>
        <div className="filter-group" role="group" aria-label="Status">
          {statuses.map(([value, label, count]) => (
            <button key={value} type="button" className="filter" data-filter={value} aria-pressed={status === value} onClick={() => choose({ status: value })}>
              {label}
              <span>{count}</span>
            </button>
          ))}
        </div>
        <div className="filter-group">
          <span className="filter-group-heading">Created</span>
          {DATE_FILTERS.map(value => (
            <button key={value} type="button" className="filter" data-date-filter={value} aria-pressed={date === value} onClick={() => choose({ date: value })}>
              {DATE_LABELS[value]}
              <span>{dateCounts[value]}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
