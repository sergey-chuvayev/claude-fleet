// The archive bar under the list head (#archive-bar, F24). On the Offline filter it
// offers a one-off sweep of offline sessions older than the rule's age, and the
// standing rule itself; on the Archived filter it restores everything. One age serves
// both the sweep and the rule, so the button and the checkbox never disagree.
import { useNow } from '../../components/clock'
import { Select } from '../../components/Select'
import { type SessionPartition, type StatusFilter, sweepDayChoices, sweepTargets } from '../../domain/sessions'
import type { ArchiveRule } from '../../transport/contracts'
import './archive.css'
import { useArchive } from './useArchive'

export interface ArchiveBarProps {
  readonly filter: StatusFilter
  readonly partition: SessionPartition
  readonly rule: ArchiveRule
}

export function ArchiveBar({ filter, partition, rule }: ArchiveBarProps) {
  const now = useNow(60_000)
  const { setArchived, setRule } = useArchive()
  if (filter !== 'dead' && filter !== 'archived') return null

  if (filter === 'archived') {
    const archived = partition.archived
    const count = archived.length
    return (
      <div className="archive-bar" id="archive-bar" role="group" aria-label="Archive">
        <span className="archive-text">
          {count} session{count === 1 ? '' : 's'} put away. Each one still resumes in a terminal and still answers an Ask.
        </span>
        <button
          type="button"
          className="button"
          id="archive-restore-all"
          onClick={() => void setArchived(archived.flatMap(row => (row.sessionId ? [row.sessionId] : [])), false)}
        >
          Restore all
        </button>
      </div>
    )
  }

  // Counted and archived from the same list, so the button never promises a number it
  // will not put away (legacy counted managed offline rows it then skipped).
  const targets = sweepTargets(partition.rows, rule.days, now)
  const days = sweepDayChoices(rule.days)
  return (
    <div className="archive-bar" id="archive-bar" role="group" aria-label="Archive">
      <span className="archive-text">Archive offline sessions untouched for over</span>
      <Select
        id="archive-days"
        className="archive-days"
        label="Age after which an offline session counts as old"
        value={String(rule.days)}
        options={days.map(d => ({ value: String(d), label: `${d} days` }))}
        onChange={value => void setRule({ enabled: rule.enabled, days: Number(value) })}
      />
      {targets.length ? (
        <button
          type="button"
          className="button"
          id="archive-sweep"
          onClick={() => void setArchived(targets.flatMap(row => (row.sessionId ? [row.sessionId] : [])), true)}
        >
          Archive {targets.length}
        </button>
      ) : (
        <span className="archive-none">Nothing that old</span>
      )}
      <label className="archive-auto">
        <input type="checkbox" id="archive-rule" checked={rule.enabled} onChange={event => void setRule({ enabled: event.target.checked, days: rule.days })} />{' '}
        Keep tidying automatically
      </label>
    </div>
  )
}
