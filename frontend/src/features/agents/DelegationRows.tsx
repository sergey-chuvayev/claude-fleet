// A team session's sub-agents, nested under its row (F05): a fold header, then the
// recent delegation rows. Folding is per session and remembered in
// fleet:children-collapsed. A fold never hides the selected row: a group holding the
// selected delegation draws open, and folding it hands the selection to the parent.
// The header is a sibling of the session row, not inside it, because that row is a
// button and a button cannot hold another one.
import { memo } from 'react'
import { Icon } from '../../components/Icon'
import type { DelegationSummary } from '../../transport/contracts'
import './agents.css'
import {
  DELEGATION_BADGE,
  DELEGATION_LABEL,
  delegationCounts,
  delegationGroupId,
  formatModel,
  visibleDelegations,
} from './visibleDelegations'

const DelegationRow = memo(function DelegationRow({
  parentKey,
  delegation,
  selected,
  onSelect,
}: {
  parentKey: string
  delegation: DelegationSummary
  selected: boolean
  onSelect: (delegationId: string) => void
}) {
  return (
    <button
      type="button"
      className="session session-child"
      data-session={parentKey}
      data-delegation={delegation.id}
      aria-pressed={selected}
      aria-controls="detail"
      onClick={() => onSelect(delegation.id)}
    >
      <span>
        <span className="session-top">
          <span className={`badge ${DELEGATION_BADGE[delegation.status] ?? ''}`}>
            <span className="dot" />
            {DELEGATION_LABEL[delegation.status] ?? delegation.status}
          </span>
          <span className="session-name">
            <Icon name="pr" /> {delegation.role}
          </span>
        </span>
        <span className="session-title">{formatModel(delegation.model)}</span>
      </span>
      <span className="session-context" />
    </button>
  )
})

export interface DelegationRowsProps {
  /** The parent's legacy key: the fold's preference key and the rows' data-session. */
  readonly parentKey: string
  readonly delegations: readonly DelegationSummary[]
  /** The selected delegation id when it belongs to this parent. */
  readonly selectedId: string | null
  /** The stored fold state for this parent. */
  readonly collapsed: boolean
  readonly onToggle: (collapse: boolean) => void
  readonly onSelect: (delegationId: string) => void
}

export const DelegationRows = memo(function DelegationRows({ parentKey, delegations, selectedId, collapsed, onToggle, onSelect }: DelegationRowsProps) {
  if (!delegations.length) return null
  const holdsSelection = !!selectedId && delegations.some(d => d.id === selectedId)
  const folded = collapsed && !holdsSelection
  const group = delegationGroupId(parentKey)
  const { shown, earlier } = folded ? { shown: [], earlier: 0 } : visibleDelegations(delegations, selectedId)
  return (
    <>
      <button
        type="button"
        className={`session-children-toggle${folded ? ' is-collapsed' : ''}`}
        data-fold-session={parentKey}
        aria-expanded={!folded}
        aria-controls={group}
        // What the header shows is what it toggles: folding a group drawn open around
        // its selection folds it (and the list hands the selection to the parent).
        onClick={() => onToggle(!folded)}
      >
        <span className="children-chevron" aria-hidden="true">
          ›
        </span>
        <span className="children-count">
          <Icon name="pr" /> {delegationCounts(delegations)}
        </span>
      </button>
      <div className="session-children" id={group} hidden={folded}>
        {/* Oldest first, so what got cut is the oldest end: the marker sits ahead of the rows. */}
        {earlier ? <div className="session-child-more">+{earlier} earlier</div> : null}
        {shown.map(delegation => (
          <DelegationRow key={delegation.id} parentKey={parentKey} delegation={delegation} selected={delegation.id === selectedId} onSelect={onSelect} />
        ))}
      </div>
    </>
  )
})
