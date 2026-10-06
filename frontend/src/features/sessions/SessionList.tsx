// The session list (F02, F03, F05): the shown rows in server order, each followed by
// its delegation rows. It owns the visible rows, so it reconciles the selection
// against them (a selected row that disappears hands focus to its neighbour, a
// delegation to its parent), marks the selected row's activity as seen, and on a
// phone scrolls the detail column into view after a pick.
import { type ReactNode, useCallback, useEffect, useMemo } from 'react'
import { useActions, usePreference, usePreferences, useReconcileSelection, useSelection } from '../../app/AppStore'
import { type Selection, type SelectionCandidate, selectionKey, selectionOf } from '../../app/state'
import { MOBILE_QUERY, matchesMedia } from '../../components/layers'
import { type ManagedId, legacySessionKey, sessionKey } from '../../domain/ids'
import type { SessionRow as Row } from '../../transport/contracts'
import { DelegationRows } from '../agents/DelegationRows'
import { SessionRow } from './SessionRow'

/** On a phone the detail sits under the list: bring it up after a pick. */
function revealDetail(): void {
  if (!matchesMedia(MOBILE_QUERY)) return
  const detail = document.getElementById('detail')
  // jsdom and older engines have no scrollIntoView.
  detail?.scrollIntoView?.({ behavior: 'instant', block: 'start' })
}

/** Which row a selection points at, and which of its delegations, if any. */
function selectionTarget(selection: Selection | null): { key: string | null; delegationId: string | null } {
  if (!selection) return { key: null, delegationId: null }
  if (selection.kind === 'delegation') return { key: `managed:${selection.parent}`, delegationId: selection.delegationId }
  return { key: selectionKey(selection), delegationId: null }
}

export interface SessionListProps {
  readonly rows: readonly Row[]
  readonly spawnCounts: ReadonlyMap<number, number>
  /** Drawn when no row is shown; the selection is still reconciled (to nothing). */
  readonly empty: ReactNode
  /** False while the pane widens the filter for a selection made elsewhere. */
  readonly reconcile?: boolean
  /** A session key to scroll into view once its row is drawn. */
  readonly reveal?: string | null
}

export function SessionList({ rows, spawnCounts, empty, reconcile = true, reveal = null }: SessionListProps) {
  const selection = useSelection('sessions')
  const { select } = useActions()
  const preferences = usePreferences()
  const seen = usePreference('seen')
  const collapsed = usePreference('childrenCollapsed')

  // Every delegation of a managed row is a valid target, the old ones beyond the tail included.
  const candidates = useMemo<SelectionCandidate[]>(
    () =>
      rows.map(row => ({
        selection: selectionOf(row),
        ...(row.managedId && row.delegations?.length ? { delegations: row.delegations.map(d => d.id) } : {}),
      })),
    [rows],
  )
  useReconcileSelection('sessions', reconcile ? candidates : null)

  // Scroll a row revealed for an outside selection into view, the moment it is drawn
  // (and only then: later list updates must not pull the scroll back).
  const revealed = reveal ? rows.find(row => sessionKey(row) === reveal) : undefined
  const revealedKey = revealed ? legacySessionKey(revealed) : null
  useEffect(() => {
    if (!revealedKey) return
    const element = [...document.querySelectorAll<HTMLElement>('#session-list .session:not(.session-child)')].find(
      candidate => candidate.dataset.session === revealedKey,
    )
    element?.scrollIntoView?.({ block: 'nearest' })
  }, [revealedKey])

  const target = selectionTarget(selection)
  const current = target.key ? rows.find(row => sessionKey(row) === target.key) : undefined

  // Opening a row marks what it has said as read.
  const currentKey = current ? legacySessionKey(current) : null
  const currentActivity = current?.lastActivity ?? null
  useEffect(() => {
    if (currentKey && currentActivity) preferences.markSeen(currentKey, currentActivity)
  }, [preferences, currentKey, currentActivity])

  const onSelect = useCallback(
    (row: Row) => {
      select(selectionOf(row))
      revealDetail()
    },
    [select],
  )

  return (
    <div id="session-list" className="session-list">
      {rows.length ? null : empty}
      {rows.map(row => {
        const key = sessionKey(row)
        const legacy = legacySessionKey(row)
        const isCurrent = key === target.key
        const delegationId = isCurrent ? target.delegationId : null
        const ancestor = !!delegationId && !!row.delegations?.some(d => d.id === delegationId)
        const unseen = !isCurrent && !!row.lastActivity && (seen[legacy] ?? 0) < row.lastActivity
        return (
          <SessionGroup
            key={key}
            row={row}
            legacyKey={legacy}
            selected={isCurrent}
            ancestor={ancestor}
            delegationId={ancestor ? delegationId : null}
            unseen={unseen}
            spawned={row.pid ? (spawnCounts.get(row.pid) ?? 0) : 0}
            collapsed={collapsed.includes(legacy)}
            onSelect={onSelect}
          />
        )
      })}
    </div>
  )
}

interface SessionGroupProps {
  readonly row: Row
  readonly legacyKey: string
  readonly selected: boolean
  readonly ancestor: boolean
  readonly delegationId: string | null
  readonly unseen: boolean
  readonly spawned: number
  readonly collapsed: boolean
  readonly onSelect: (row: Row) => void
}

function SessionGroup({ row, legacyKey, selected, ancestor, delegationId, unseen, spawned, collapsed, onSelect }: SessionGroupProps) {
  const { select } = useActions()
  const preferences = usePreferences()
  const managedId = row.managedId as ManagedId | undefined
  const onSelectDelegation = useCallback(
    (id: string) => {
      if (!managedId) return
      select({ kind: 'delegation', parent: managedId, delegationId: id })
      revealDetail()
    },
    [select, managedId],
  )
  const onToggle = useCallback(
    (collapse: boolean) => {
      preferences.setChildrenCollapsed(legacyKey, collapse)
      // Folding the group away takes the selection back up to the session that owns it,
      // so the list never hides the one row reading as selected.
      if (collapse && delegationId && managedId) select({ kind: 'managed', managedId })
    },
    [preferences, legacyKey, delegationId, managedId, select],
  )
  return (
    <>
      <SessionRow row={row} selected={selected} ancestor={ancestor} unseen={unseen} spawned={spawned} onSelect={onSelect} />
      {managedId && row.delegations?.length ? (
        <DelegationRows
          parentKey={legacyKey}
          delegations={row.delegations}
          selectedId={delegationId}
          collapsed={collapsed}
          onToggle={onToggle}
          onSelect={onSelectDelegation}
        />
      ) : null}
    </>
  )
}
