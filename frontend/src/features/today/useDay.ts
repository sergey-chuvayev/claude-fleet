// Server state for the Today view: which Day is today's, its detail and board, the
// list rows the board reads (launched sessions, threads), the team and project lists,
// and the one way the board writes (POST /api/managed/:id/day).
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { useNow } from '../../components/clock'
import {
  type DayAction,
  type DayDetail,
  type DayItem,
  type ManagedDetail,
  type SessionSummary,
  parseDayActionResponse,
  parseDayDetail,
} from '../../transport/contracts'
import { HttpError } from '../../transport/errors'
import { useFleetClient, useResource } from '../../transport/hooks'
import { mutationInvalidates } from '../../transport/resources'
import { teamsResource } from '../teams/catalog'
import { isWorking, localDate, type RowInfo, rowInfo } from './day'

// ── Today's Day, from the session list ─────────────────────────────────────

export interface TodayRows {
  /** Today's Day row (local date), or null before it starts. */
  readonly day: SessionSummary | null
  /** Whether any Day exists, so the empty state can promise carry-over. */
  readonly anyDay: boolean
  /** Every managed row, by managed id, as the board reads them. */
  readonly rows: ReadonlyMap<string, RowInfo>
  readonly usage: unknown
  readonly loaded: boolean
  readonly error: Error | null
}

export function useTodayRows(): TodayRows {
  const client = useFleetClient()
  const sessions = useResource(client.resources.sessions)
  const today = localDate(useNow(60_000))
  const data = sessions.data
  return useMemo(() => {
    const rows = new Map<string, RowInfo>()
    let day: SessionSummary | null = null
    let anyDay = false
    for (const row of data?.sessions ?? []) {
      const info = rowInfo(row)
      if (info.managedId) rows.set(info.managedId, info)
      if (info.kind !== 'day') continue
      anyDay = true
      if (info.dayDate === today && !info.archived && !day) day = row
    }
    return { day, anyDay, rows, usage: data?.usage, loaded: !!data, error: sessions.error }
  }, [data, today, sessions.error])
}

// ── A Day's detail ─────────────────────────────────────────────────────────

/** Safety refresh while the board is on screen, on top of the event stream. */
const ACTIVE_REFRESH_MS = 2500
const IDLE_REFRESH_MS = 30_000

export interface DayState {
  readonly session: ManagedDetail['session'] | undefined
  readonly detail: DayDetail | null
  /** Board items, unchanged items keeping their object across refreshes. */
  readonly items: readonly DayItem[]
  readonly error: Error | null
}

const NO_ITEMS: readonly DayItem[] = []

export function useDayDetail(dayId: string, { poll = false }: { poll?: boolean } = {}): DayState {
  const client = useFleetClient()
  const resource = client.resources.managed(dayId)
  const state = useResource(resource)
  const session = state.data?.session
  const status = session?.status

  useEffect(() => {
    if (!poll) return
    const timer = setInterval(
      () => {
        if (typeof document === 'undefined' || document.visibilityState !== 'hidden') client.store.invalidate(resource.key)
      },
      isWorking(status) || status === 'queued' ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS,
    )
    return () => clearInterval(timer)
  }, [client, resource, status, poll])

  const parsed = useMemo(() => {
    if (!session) return { detail: null, error: null }
    try {
      return { detail: parseDayDetail(session), error: null }
    } catch (error) {
      return { detail: null, error: error as Error }
    }
  }, [session])

  // An item whose JSON did not change keeps its object, so its row skips rendering.
  const previous = useRef(new Map<string, { json: string; item: DayItem }>())
  const items = useMemo(() => {
    const list = parsed.detail?.dayBoard?.items
    if (!list) return NO_ITEMS
    const next = new Map<string, { json: string; item: DayItem }>()
    const out = list.map(item => {
      const json = JSON.stringify(item)
      const held = previous.current.get(item.id)
      const kept = held && held.json === json ? held.item : item
      next.set(item.id, { json, item: kept })
      return kept
    })
    previous.current = next
    return out
  }, [parsed.detail])

  return { session, detail: parsed.detail, items, error: parsed.error ?? (session ? null : state.error) }
}

// ── Teams and projects ─────────────────────────────────────────────────────

export interface Named {
  readonly id: string
  readonly name: string
}
const NONE: readonly Named[] = []

/** The team catalog for launch cards; empty (Single agent only) until it arrives or when it fails. */
export function useTeams(): readonly Named[] {
  const state = useResource(teamsResource(useFleetClient()))
  return state.data?.teams ?? NONE
}

/** Active projects, for item tags and the project picker. */
export function useProjects(): readonly Named[] {
  const projects = useResource(useFleetClient().resources.projects).data
  return useMemo(() => (projects ? projects.filter(p => !p.archived) : NONE), [projects])
}

// ── Writing to the board ───────────────────────────────────────────────────

/**
 * What the operator reads when a Day action fails, chosen by the server's error code.
 * A conflict or a missing item means the board moved under the operator, so the
 * caller refreshes it; the server's own words say what happened.
 */
export function dayErrorMessage(error: unknown): string {
  if (error instanceof HttpError) {
    switch (error.code) {
      case 'NOT_FOUND':
        return `${error.message.replace(/\s*Read the Day board\.?$/, '')} The board has been refreshed.`
      case 'CONFLICT':
        return `${error.message} The board has been refreshed.`
      case 'CAPACITY':
        return error.retryable ? `${error.message} Finish or drop something, then try again.` : error.message
      case 'VALIDATION':
        return error.message
      default:
        return error.message
    }
  }
  return error instanceof Error ? error.message : String(error)
}

const REFRESH_CODES = new Set(['NOT_FOUND', 'CONFLICT'])

/**
 * POST a Day action. The answer carries the whole Day, which goes straight into the
 * store (a newer write than any refresh in flight); the list, projects and Progress
 * are refreshed behind it. Rejects with the server's error; `dayErrorMessage` words it.
 */
export function useDayAction(dayId: string): (action: DayAction) => Promise<unknown> {
  const client = useFleetClient()
  return useCallback(
    async (action: DayAction) => {
      const resource = client.resources.managed(dayId)
      try {
        const raw = await client.post(`/api/managed/${encodeURIComponent(dayId)}/day`, action)
        const { result, detail } = parseDayActionResponse(raw)
        client.store.set(resource, detail)
        client.store.invalidate(...mutationInvalidates.day(dayId).filter(key => key !== resource.key))
        return result
      } catch (error) {
        if (error instanceof HttpError && error.code && REFRESH_CODES.has(error.code)) client.store.invalidate(resource.key)
        throw error
      }
    },
    [client, dayId],
  )
}

// ── Reveal an item on the board ────────────────────────────────────────────
// Another part of Fleet (a Waiting card's Details, a project's task, a report-back
// notification) asks the board to open one item and bring it into view.

type Listener = () => void
let pendingReveal: string | null = null
const revealListeners = new Set<Listener>()

export function requestReveal(itemId: string): void {
  pendingReveal = itemId
  for (const listener of [...revealListeners]) listener()
}

export function takeReveal(itemId: string): void {
  if (pendingReveal === itemId) pendingReveal = null
}

const subscribeReveal = (listener: Listener) => {
  revealListeners.add(listener)
  return () => revealListeners.delete(listener)
}
const readReveal = () => pendingReveal

export function usePendingReveal(): string | null {
  return useSyncExternalStore(subscribeReveal, readReveal, readReveal)
}

// ── Typed text that outlives a redraw ──────────────────────────────────────
// An answer is typed into the board while the board keeps refreshing under it, and a
// card can move (an item answered moves from Waiting to Today). Every field holding
// the operator's words lives here, keyed, so nothing a refresh does eats a reply.

const drafts = new Map<string, string>()
const draftListeners = new Set<Listener>()
const subscribeDrafts = (listener: Listener) => {
  draftListeners.add(listener)
  return () => draftListeners.delete(listener)
}

/** Keep `value` under `key`; null forgets it (the field shows its initial text again). */
export function setDraft(key: string, value: string | null): void {
  if (drafts.get(key) === (value ?? undefined)) return
  if (value === null) drafts.delete(key)
  else drafts.set(key, value)
  for (const listener of [...draftListeners]) listener()
}

export function readDraft(key: string): string {
  return drafts.get(key) ?? ''
}

/** A kept field: its text and a setter. `initial` is shown until the operator types. */
export function useDraft(key: string, initial = ''): readonly [string, (value: string) => void, boolean] {
  const read = useCallback(() => drafts.get(key), [key])
  const held = useSyncExternalStore(subscribeDrafts, read, read)
  const set = useCallback((value: string) => setDraft(key, value === initial ? null : value), [key, initial])
  return [held ?? initial, set, held !== undefined]
}

/** For tests: forget every kept field. */
export function clearDrafts(): void {
  drafts.clear()
  pendingReveal = null
}
