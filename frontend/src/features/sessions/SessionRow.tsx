// One session row (F03), ported from public/app.js sessionRowHtml. Four lines: what
// the agent is called and what it last said, how it is doing (with the qualifiers
// that say it is not an ordinary foreground session), where it works, and the story
// of its latest turn. Memoized on the row object, so a snapshot that leaves a row
// unchanged leaves its DOM alone; the ages tick through the shared clock.
import { memo } from 'react'
import { Avatar } from '../../components/Avatar'
import { Elapsed, RelativeTime } from '../../components/clock'
import { Icon } from '../../components/Icon'
import { legacySessionKey } from '../../domain/ids'
import {
  STEP_ICON,
  avatarStatus,
  contextPercent,
  heat,
  isWorking,
  statusBadge,
  stepCategory,
  turnAriaLabel,
} from '../../domain/sessions'
import type { SessionRow as Row } from '../../transport/contracts'

export function StatusBadgeView({ row }: { row: Row }) {
  const badge = statusBadge(row)
  return (
    <span className={`badge ${badge.className}`} title={badge.title}>
      <span className="dot" />
      {badge.label}
    </span>
  )
}

/** Line one's qualifiers: spawned sessions, background owner, archived, engine. */
function RowTags({ row, spawned }: { row: Row; spawned: number }) {
  const owner = row.spawnedByName || 'a program'
  return (
    <>
      {spawned ? (
        <span className="spawn-badge" title={`Running ${spawned} background session(s)`}>
          <Icon name="pr" /> {spawned}
        </span>
      ) : null}
      {row.background ? (
        <span className="spawn-owner" title={`Started by ${owner}, not from a terminal`}>
          via {owner}
        </span>
      ) : null}
      {row.archived ? (
        <span className="archived-tag" title="Archived. Hidden from your fleet, still on disk and still resumable.">
          archived
        </span>
      ) : null}
      {row.engine === 'codex' ? (
        <span className="engine-tag" title="A Codex session">
          Codex
        </span>
      ) : null}
    </>
  )
}

/** A team session says which team runs it and how far it is; a Day says how its board stands. */
function InitiativeTag({ row }: { row: Row }) {
  if (row.kind === 'day') {
    const p = row.dayProgress
    return (
      <span className="initiative-tag day-tag">
        Day
        {p
          ? ` · ${p.done}/${p.total} done${p.waiting ? ` · ${p.waiting} waiting on you` : ''}${p.proposed ? ` · ${p.proposed} to triage` : ''}`
          : ''}
      </span>
    )
  }
  if (row.kind !== 'initiative') return null
  const p = row.taskProgress
  const progress = p ? ` · ${p.verified}/${p.total} verified${p.blocked ? ` · ${p.blocked} need attention` : ''}` : ''
  return <span className="initiative-tag">{`Initiative · ${row.teamName || row.teamId || 'Team'}${progress}`}</span>
}

/** Where the work is happening, and how much linked work it mentions. */
function RowMeta({ row }: { row: Row }) {
  const project = row.cwd?.split('/').filter(Boolean).pop() || 'No project'
  return (
    <span className="session-meta">
      <span>{project}</span>
      <span className="branch">
        <Icon name="pr" /> {row.branch || 'No branch'}
      </span>
      {row.links?.length ? (
        <span>
          <Icon name="arrow" /> {row.links.length}
        </span>
      ) : null}
    </span>
  )
}

/** The latest turn like a CI job: one segment per tool call, the step now (or last), and how long. */
export function TurnSummaryView({ row }: { row: Row }) {
  const turn = row.turn
  const aria = turnAriaLabel(row)
  if (!turn || aria === null) return null
  const working = isWorking(row)
  const failed = turn.steps.some(step => !step.ok)
  const step = turn.current || turn.last
  return (
    <span className="turn" aria-label={aria}>
      <span className={`steps ${failed ? 'has-failed' : ''}`} aria-hidden="true">
        {turn.steps.map((s, i) => (
          // Steps have no ids of their own; they only ever append within a turn.
          <i key={i} className={s.ok ? `k-${s.k ?? 'other'}` : 'k-failed'} title={`${s.t}${s.target ? ` · ${s.target}` : ''}${s.ok ? '' : ' · failed'}`} />
        ))}
      </span>
      {step ? (
        <span className={`step-now ${working ? 'is-live' : ''}`}>
          <span className="step-icon" aria-hidden="true">
            {STEP_ICON[stepCategory(step.t)] ?? '▸'}
          </span>
          {step.t}
          {step.target ? (
            <>
              {' '}
              <span className="step-target">{step.target}</span>
            </>
          ) : null}
        </span>
      ) : null}
      {working && turn.turnStartedAt ? (
        <span className="step-when">
          <Elapsed since={turn.turnStartedAt} />
        </span>
      ) : step?.at ? (
        <span className="step-when">
          <RelativeTime at={step.at} suffix=" ago" />
        </span>
      ) : null}
    </span>
  )
}

/** The right-hand column: context pressure and the last activity. */
function ContextCell({ row }: { row: Row }) {
  const percent = contextPercent(row)
  const tone = heat(percent)
  return (
    <span className={`session-context ${tone}`}>
      {percent === null ? '\u2014' : `${Math.round(percent)}%`}
      <span className="mini-bar">
        <i className={tone} style={{ width: `${percent ?? 0}%` }} />
      </span>
      <small>
        <RelativeTime at={row.lastActivity} suffix=" ago" />
      </small>
    </span>
  )
}

export interface SessionRowProps {
  readonly row: Row
  /** This row is the selection. */
  readonly selected: boolean
  /** One of its delegations is the selection: the row is an ancestor, not pressed. */
  readonly ancestor: boolean
  readonly unseen: boolean
  /** Background sessions this row's process runs. */
  readonly spawned: number
  readonly onSelect: (row: Row) => void
}

export const SessionRow = memo(function SessionRow({ row, selected, ancestor, unseen, spawned, onSelect }: SessionRowProps) {
  const key = legacySessionKey(row)
  const name = row.name || row.shortId || 'Unnamed session'
  const working = isWorking(row)
  return (
    <button
      type="button"
      className={`session${ancestor ? ' session-ancestor' : ''}`}
      data-session={key}
      aria-pressed={selected && !ancestor}
      aria-controls="detail"
      title={unseen ? 'New output since you last opened this' : ''}
      onClick={() => onSelect(row)}
    >
      <Avatar seed={key} title={row.title || row.name} working={working} status={avatarStatus(row)} />
      <span className="session-summary">
        <span className="session-title-row">
          <span className="session-title">{row.title || row.lastPrompt || 'Untitled session'}</span>
        </span>
        <span className="session-preview">{row.latestResponse || row.lastPrompt || 'Ready for your next idea'}</span>
        <span className="session-top">
          {unseen ? <span className="unseen" aria-label="New output" /> : null}
          <StatusBadgeView row={row} />
          {name !== row.title ? <span className="session-name">{name}</span> : null}
          <RowTags row={row} spawned={spawned} />
        </span>
        <InitiativeTag row={row} />
        <RowMeta row={row} />
        <TurnSummaryView row={row} />
      </span>
      <ContextCell row={row} />
    </button>
  )
})
