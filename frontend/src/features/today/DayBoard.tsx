// The Day board (F16, F17, F18): what waits on you, what to triage, today's work by
// priority, a way to add your own, and what is later or done. Ported from
// public/day.js renderBoard; same markup and classes, so the legacy styles apply.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useActions, useSelection } from '../../app/AppStore'
import { Fold } from '../../components/Disclosure'
import { Icon } from '../../components/Icon'
import { Markdown } from '../../components/markdown/Markdown'
import { Select } from '../../components/Select'
import { useNow } from '../../components/clock'
import { useToast } from '../../components/Toast'
import type { DayItemId, ManagedId, ProjectId } from '../../domain/ids'
import { clockAt, tokens as compactTokens } from '../../domain/format'
import type { DayAction, DayItem, DayMode, DayPriority, DaySubagent } from '../../transport/contracts'
import {
  type LiveContext,
  type LiveStatus,
  type RowInfo,
  LAUNCH_STATE,
  MODE,
  MODE_SHORT,
  ON_TODAY,
  PRIORITY,
  PRIORITY_ORDER,
  SOURCE,
  checkedLine,
  clip,
  contextFolds,
  dayHeading,
  duration,
  isWorking,
  linksIn,
  liveStatus,
  minutesOf,
  openNeeds,
  rowOrbTitle,
  rowTone,
  weekdayOf,
  workingLine,
} from './day'
import { DayNeed } from './DayNeed'
import { Bar, Group, List, Log, PageHead, Pill, Ring, Row, Section, Stat } from '../../components/ui'
import { DayLinks } from './ui'
import {
  type Named,
  type TodayRows,
  dayErrorMessage,
  requestReveal,
  setDraft,
  takeReveal,
  useDayAction,
  useDayDetail,
  useDraft,
  usePendingReveal,
  useProjects,
  useTeams,
} from './useDay'

type Act = (action: DayAction) => Promise<unknown>
const PRIORITY_OPTIONS = PRIORITY_ORDER.map(value => ({ value, label: PRIORITY[value] }))
const MODE_OPTIONS = (Object.keys(MODE) as DayMode[]).map(value => ({ value, label: MODE[value] }))

// ── Small parts of an item ──────────────────────────────────────────────────

function Source({ source }: { source: string }) {
  return (
    <span className="day-source" data-source={source}>
      {SOURCE[source] ?? source}
    </span>
  )
}

function Carried({ from }: { from: string | null | undefined }) {
  if (!from) return null
  return (
    <span className="day-carried" title={`Carried over from ${from}`}>
      from {weekdayOf(from)}
    </span>
  )
}

/** An item's project, as a tag that opens it. Inside a row's summary, so it must not also toggle the row. */
function ProjectTag({ projectId, projects }: { projectId: string | null | undefined; projects: readonly Named[] }) {
  const { select } = useActions()
  const name = projectId ? projects.find(p => p.id === projectId)?.name : undefined
  if (!projectId || !name) return null
  return (
    <button
      type="button"
      className="day-project"
      title={`Open the project: ${name}`}
      onClick={event => {
        event.preventDefault()
        event.stopPropagation()
        select({ kind: 'project-manager', projectId: projectId as ProjectId }, { reveal: true })
      }}
    >
      <span aria-hidden="true">◆</span>
      {clip(name, 24)}
    </button>
  )
}

function ItemHead({ item, projects }: { item: DayItem; projects: readonly Named[] }) {
  return (
    <div className="day-card-head">
      <Source source={item.source} />
      <Carried from={item.carriedFrom} />
      <ProjectTag projectId={item.projectId} projects={projects} />
      <strong>{item.title}</strong>
      {item.estimateMin ? <small>{duration(item.estimateMin)}</small> : null}
    </div>
  )
}

/** A short note reads in place; a long one (a project's hand-off) is formatted and folded. */
function Context({ item }: { item: DayItem }) {
  const text = item.context ?? ''
  if (!text) return null
  const prose = (
    <div className="day-context">
      <Markdown source={text} />
    </div>
  )
  if (!contextFolds(text)) return prose
  return (
    <Fold className="day-context-fold" summary={item.deliverableId ? 'Hand-off from the project' : 'Context'} lazy>
      {prose}
    </Fold>
  )
}

/** Sessions an item launched, with their live state from the session list. */
function Launched({ item, rows }: { item: DayItem; rows: ReadonlyMap<string, RowInfo> }) {
  const { select } = useActions()
  if (!item.launched?.length) return null
  return (
    <div className="day-launched">
      {item.launched.map(id => {
        const x = rows.get(id)
        if (!x) {
          return (
            <span key={id} className="day-launch-chip" data-state="closed">
              Session closed
            </span>
          )
        }
        const state = x.status ?? 'idle'
        return (
          <button
            key={id}
            type="button"
            className="day-launch-chip"
            data-state={state}
            title={`Open in Sessions: ${x.name}`}
            onClick={() => select({ kind: 'managed', managedId: id as ManagedId }, { reveal: true })}
          >
            <span className="dot" />
            {clip(x.name, 40)} · {LAUNCH_STATE[state] ?? state}
            {x.progress?.total ? ` · ${x.progress.verified}/${x.progress.total} verified` : ''} <Icon name="arrow" />
          </button>
        )
      })}
    </div>
  )
}

/** The item's conversation, opened in the console beside the board. */
function ThreadChip({ item, label = 'Thread' }: { item: DayItem; label?: string }) {
  const { select } = useActions()
  if (!item.thread || item.thread.closed) return null
  return (
    <button
      type="button"
      className="day-launch-chip"
      data-state="idle"
      data-open-thread={item.thread.sessionId}
      title="Open your conversation about this item"
      onClick={() => select({ kind: 'day-thread', itemId: item.id as DayItemId })}
    >
      <span className="dot" />
      {label} <Icon name="arrow" />
    </button>
  )
}

/** The gist of the item's thread and the way back into it, or of an earlier Day's thread. */
function ThreadGist({ item }: { item: DayItem }) {
  const { select } = useActions()
  const previous = item.previousThread
  if (!item.thread && previous?.summary) {
    return (
      <p className="day-thread-gist">
        <button
          type="button"
          className="day-launch-chip"
          data-state="idle"
          title="Open that conversation in Sessions"
          onClick={() => select({ kind: 'managed', managedId: previous.sessionId as ManagedId }, { reveal: true })}
        >
          <span className="dot" />
          Earlier thread <Icon name="arrow" />
        </button>
        {previous.summary}
      </p>
    )
  }
  if (!item.thread || item.thread.closed) return null
  return (
    <p className="day-thread-gist">
      <ThreadChip item={item} />
      {item.thread.summary || 'Starting…'}
    </p>
  )
}

// ── Waiting on you ─────────────────────────────────────────────────────────

function WaitingSection({ items, rows, projects, teams, act }: BoardParts & { items: readonly DayItem[] }) {
  const waiting = useMemo(
    () =>
      items
        .filter(i => openNeeds(i).length)
        .sort((a, b) => (openNeeds(a)[0]?.at ?? 0) - (openNeeds(b)[0]?.at ?? 0)),
    [items],
  )
  if (!waiting.length) return null
  const count = waiting.reduce((n, i) => n + openNeeds(i).length, 0)
  return (
    <Section label="Waiting on you" count={count} className="day-waiting">
      {waiting.map(item => (
        <article key={item.id} className="ui-card" data-tone="needs" data-waiting={item.id}>
          <ItemHead item={item} projects={projects} />
          {openNeeds(item).map(need => (
            <DayNeed key={need.id} item={item} need={need} teams={teams} act={act} />
          ))}
          {/* A question about work an agent did needs that work at hand: its session, the
              item's conversation, its links, and the item's full story on the board. */}
          <div className="day-card-foot">
            <Launched item={item} rows={rows} />
            <ThreadChip item={item} />
            <DayLinks links={item.links} />
            <button
              type="button"
              className="button ghost day-card-details"
              title="Open this item on the board: its context, log and actions"
              onClick={() => requestReveal(item.id)}
            >
              Details
            </button>
          </div>
        </article>
      ))}
    </Section>
  )
}

// ── To triage ──────────────────────────────────────────────────────────────

function TriageCard({ item, projects, act }: { item: DayItem; projects: readonly Named[]; act: Act }) {
  const toast = useToast()
  const [priority, setPriority] = useState<DayPriority>(item.priority)
  const [mode, setMode] = useState<DayMode>(item.mode)
  const [busy, setBusy] = useState(false)
  // On a proposal the choices travel with Today, Later or Drop.
  const triage = async (status: 'today' | 'later' | 'dropped') => {
    setBusy(true)
    try {
      await act({ op: 'triage', itemId: item.id, status, priority, mode })
    } catch (error) {
      toast(dayErrorMessage(error))
      setBusy(false)
    }
  }
  return (
    <article className="ui-card" data-card={item.id} data-proposed="">
      <ItemHead item={item} projects={projects} />
      <Context item={item} />
      <DayLinks links={item.links} />
      <div className="ui-actions">
        <Select value={priority} options={PRIORITY_OPTIONS} onChange={setPriority} label="Priority" />
        <Select value={mode} options={MODE_OPTIONS} onChange={setMode} label="How" />
        <button type="button" className="button resume" disabled={busy} onClick={() => void triage('today')}>
          Today
        </button>
        <button type="button" className="button" disabled={busy} onClick={() => void triage('later')}>
          Later
        </button>
        <button type="button" className="button" disabled={busy} onClick={() => void triage('dropped')}>
          Drop
        </button>
      </div>
    </article>
  )
}

const PRIORITY_RANK: Readonly<Record<DayPriority, number>> = { must: 0, should: 1, could: 2 }

function TriageSection({ items, projects, act }: Pick<BoardParts, 'projects' | 'act'> & { items: readonly DayItem[] }) {
  const toast = useToast()
  const [bulk, setBulk] = useState(false)
  const proposed = useMemo(
    () => items.filter(i => i.status === 'proposed').sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]),
    [items],
  )
  if (!proposed.length) return null
  // Each item is its own request; a partial failure says so instead of claiming all.
  const takeAllMust = async () => {
    const must = proposed.filter(i => i.priority === 'must')
    if (!must.length) return toast('Nothing to triage is a Must.')
    setBulk(true)
    const results = await Promise.allSettled(must.map(i => act({ op: 'triage', itemId: i.id, status: 'today' })))
    setBulk(false)
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    const moved = results.length - failed.length
    if (!failed.length) return toast(`${moved} on today`)
    toast(`${moved} of ${results.length} on today. ${failed.length} could not move: ${dayErrorMessage(failed[0]?.reason)}`)
  }
  return (
    <Section
      label="To triage"
      count={proposed.length}
      aside={
        <button type="button" className="button ghost" disabled={bulk} onClick={() => void takeAllMust()}>
          Take all Must
        </button>
      }
    >
      {proposed.map(item => (
        <TriageCard key={item.id} item={item} projects={projects} act={act} />
      ))}
    </Section>
  )
}

// ── Today ──────────────────────────────────────────────────────────────────

function AskBox({ item, act }: { item: DayItem; act: Act }) {
  const toast = useToast()
  const { select } = useActions()
  const key = `ask:${item.id}`
  const [text, setText] = useDraft(key)
  const [busy, setBusy] = useState(false)
  // One request id per question, kept across a failed attempt so a retry is the same ask.
  const requestId = useRef<string | null>(null)
  const ask = async () => {
    const message = text.trim()
    if (!message) return toast('Type your question first.')
    setBusy(true)
    requestId.current ??= crypto.randomUUID()
    try {
      await act({ op: 'thread', itemId: item.id, message, requestId: requestId.current })
      requestId.current = null
      setDraft(key, null)
      select({ kind: 'day-thread', itemId: item.id as DayItemId })
    } catch (error) {
      toast(dayErrorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  const threaded = !!item.thread && !item.thread.closed
  return (
    <div className="ui-ask">
      <input
        value={text}
        maxLength={2000}
        placeholder="Ask about this item: why, what if, change the plan…"
        aria-label={`Ask about ${item.title}`}
        onChange={event => {
          setText(event.target.value)
          requestId.current = null
        }}
        onKeyDown={event => {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
          event.preventDefault()
          void ask()
        }}
      />
      <button type="button" className="button" disabled={busy} onClick={() => void ask()}>
        {threaded ? 'Ask' : 'Ask about this'} <Icon name="arrow" />
      </button>
    </div>
  )
}

interface TodayRowProps {
  readonly item: DayItem
  readonly live: LiveStatus | null
  readonly open: boolean
  readonly flash: boolean
  readonly onOpenChange: (id: string, open: boolean) => void
  readonly parts: BoardParts
}

function TodayRow({ item, live, open, flash, onOpenChange, parts }: TodayRowProps) {
  const { rows, projects, act } = parts
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const asks = openNeeds(item).length
  const latest = item.log.at(-1)?.text
  // On a triaged item a new mode or project is the instruction, so it goes at once.
  const change = async (changes: Omit<Extract<DayAction, { op: 'triage' }>, 'op' | 'itemId'>, done?: string) => {
    setBusy(true)
    try {
      await act({ op: 'triage', itemId: item.id, ...changes })
      if (done) toast(done)
    } catch (error) {
      toast(dayErrorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  const meta = (
    <>
      <Source source={item.source} />
      <Carried from={item.carriedFrom} />
      <ProjectTag projectId={item.projectId} projects={projects} />
      {live ? <Pill tone={live[0]}>{live[1]}</Pill> : null}
      {latest ? (
        <span className="ui-row-latest" title={latest}>
          {latest}
        </span>
      ) : null}
    </>
  )
  const side = (
    <>
      {item.estimateMin ? <small className="ui-row-figure">{duration(item.estimateMin)}</small> : null}
      <Pill tone={item.mode === 'agent' ? 'agent' : item.mode === 'me' ? 'me' : 'outline'}>{MODE_SHORT[item.mode]}</Pill>
    </>
  )
  const projectOptions = [{ value: '', label: 'No project' }, ...projects.map(p => ({ value: p.id, label: p.name }))]
  const detail = (
    <>
      <Launched item={item} rows={rows} />
      <ThreadGist item={item} />
      <Context item={item} />
      <DayLinks links={item.links} />
      <Log entries={item.log.slice(-6).map(entry => [clockAt(entry.at), entry.text] as const)} />
      <AskBox item={item} act={act} />
      <div className="ui-actions">
        <Select value={item.mode} options={MODE_OPTIONS} onChange={mode => void change({ mode }, 'Updated')} label="How" disabled={busy} />
        {projects.length ? (
          <Select
            value={item.projectId ?? ''}
            options={projectOptions}
            onChange={id => void change({ projectId: id || null }, id ? 'Added to the project' : 'Removed from the project')}
            label="Project"
            disabled={busy}
          />
        ) : null}
        <button
          type="button"
          className="button"
          disabled={busy || asks > 0}
          title={asks ? 'Answer its questions first' : undefined}
          onClick={() => void change({ status: 'done' })}
        >
          Done
        </button>
        <button type="button" className="button" disabled={busy} onClick={() => void change({ status: 'later' })}>
          Later
        </button>
      </div>
    </>
  )
  return (
    <Row
      card={item.id}
      evidence={item.id}
      lazy
      tone={rowTone(item, live)}
      orbTitle={rowOrbTitle(item, live)}
      title={item.title}
      meta={meta}
      side={side}
      detail={detail}
      open={open}
      flash={flash}
      onOpenChange={next => onOpenChange(item.id, next)}
    />
  )
}

function Capacity({ planned, free }: { planned: number; free: number | null | undefined }) {
  if (free == null) return planned ? <span className="day-capacity">{duration(planned)} planned</span> : null
  const over = planned > free
  const share = free ? Math.min(100, Math.round((planned / free) * 100)) : 100
  return (
    <span
      className={`day-capacity${over ? ' is-over' : ''}`}
      title="Estimated time of today's open items against focus time left on your calendar"
    >
      <span className="mini-bar">
        <i style={{ width: `${share}%` }} />
      </span>
      {duration(planned)} planned · {duration(free)} free{over ? ` · over by ${duration(planned - free)}` : ''}
    </span>
  )
}

function TodaySection({
  items,
  live,
  opened,
  flash,
  onOpenChange,
  freeMinutes,
  parts,
}: {
  items: readonly DayItem[]
  live: (item: DayItem) => LiveStatus | null
  opened: ReadonlySet<string>
  flash: string | null
  onOpenChange: (id: string, open: boolean) => void
  freeMinutes: number | null | undefined
  parts: BoardParts
}) {
  const today = useMemo(() => items.filter(i => ON_TODAY.has(i.status)).sort((a, b) => a.createdAt - b.createdAt), [items])
  const groups = PRIORITY_ORDER.map(p => [p, today.filter(i => i.priority === p)] as const).filter(([, list]) => list.length)
  return (
    <Section label="Today" count={today.length} aside={<Capacity planned={minutesOf(today)} free={freeMinutes} />}>
      {today.length ? (
        groups.map(([p, list]) => (
          <div key={p} className="ui-subgroup">
            <Group label={PRIORITY[p]} count={list.length} end={minutesOf(list) ? duration(minutesOf(list)) : ''} tone={p} />
            <List>
              {list.map(item => (
                <TodayRow
                  key={item.id}
                  item={item}
                  live={live(item)}
                  open={opened.has(item.id)}
                  flash={flash === item.id}
                  onOpenChange={onOpenChange}
                  parts={parts}
                />
              ))}
            </List>
          </div>
        ))
      ) : (
        <p className="note">Nothing on today yet. Triage the proposals, or add your own.</p>
      )}
    </Section>
  )
}

// ── Add something ──────────────────────────────────────────────────────────

function AddForm({ act }: { act: Act }) {
  const toast = useToast()
  const [title, setTitle] = useDraft('add:title')
  const [context, setContext] = useDraft('add:context')
  const [priority, setPriority] = useState<DayPriority>('should')
  const [mode, setMode] = useState<DayMode>('me')
  const [busy, setBusy] = useState(false)
  const add = async () => {
    const name = title.trim()
    if (!name) return toast('Give it a title.')
    const note = context.trim()
    setBusy(true)
    try {
      await act({
        op: 'add',
        item: { title: name.slice(0, 200), source: 'me', ...(note ? { context: note } : {}), links: linksIn(note), priority, mode },
      })
      setDraft('add:title', null)
      setDraft('add:context', null)
      toast('Added to today')
    } catch (error) {
      toast(dayErrorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <details className="ui-add" data-evidence="add">
      <summary>
        <span className="ui-add-plus" aria-hidden="true">
          +
        </span>
        Add something<span className="note">a task, a follow-up, a reminder</span>
      </summary>
      <div className="ui-add-fields">
        <input value={title} maxLength={2000} placeholder="What needs doing?" aria-label="What needs doing?" onChange={event => setTitle(event.target.value)} />
        <textarea
          value={context}
          rows={3}
          maxLength={8000}
          aria-label="Context"
          placeholder="Context, links, who is waiting. The agent fills in the rest."
          onChange={event => setContext(event.target.value)}
        />
        <div className="ui-actions">
          <Select value={priority} options={PRIORITY_OPTIONS} onChange={setPriority} label="Priority" />
          <Select value={mode} options={MODE_OPTIONS} onChange={setMode} label="How" />
          <button type="button" className="button resume" disabled={busy} onClick={() => void add()}>
            Add to today
          </button>
        </div>
      </div>
    </details>
  )
}

// ── Later and Done ─────────────────────────────────────────────────────────

function RestRow({ item, done, parts }: { item: DayItem; done: boolean; parts: BoardParts }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const back = async () => {
    setBusy(true)
    try {
      await parts.act({ op: 'triage', itemId: item.id, status: 'today' })
    } catch (error) {
      toast(dayErrorMessage(error))
      setBusy(false)
    }
  }
  return (
    <Row
      card={item.id}
      tone={done ? 'done' : 'todo'}
      orbTitle={done ? 'Done' : 'Later'}
      title={item.title}
      meta={
        <>
          <Source source={item.source} />
          <Carried from={item.carriedFrom} />
          <ProjectTag projectId={item.projectId} projects={parts.projects} />
        </>
      }
      side={
        <>
          {item.estimateMin ? <small className="ui-row-figure">{duration(item.estimateMin)}</small> : null}
          {done ? null : (
            <button type="button" className="button ghost" disabled={busy} onClick={() => void back()}>
              Today
            </button>
          )}
        </>
      }
    />
  )
}

function RestFolds({ items, parts, reveal }: { items: readonly DayItem[]; parts: BoardParts; reveal: string | null }) {
  const later = items.filter(i => i.status === 'later')
  const done = items.filter(i => i.status === 'done')
  const [open, setOpen] = useState<{ later: boolean; done: boolean }>({ later: false, done: false })
  // An item revealed from elsewhere opens the fold it sits in.
  useEffect(() => {
    if (!reveal) return
    if (later.some(i => i.id === reveal)) setOpen(o => ({ ...o, later: true }))
    if (done.some(i => i.id === reveal)) setOpen(o => ({ ...o, done: true }))
  }, [reveal, later, done])
  if (!later.length && !done.length) return null
  const fold = (title: string, list: DayItem[], isDone: boolean, which: 'later' | 'done') =>
    list.length ? (
      <Fold summary={title} count={list.length} data-evidence={`rest-${title}`} open={open[which]} onOpenChange={next => setOpen(o => ({ ...o, [which]: next }))}>
        <List compact>
          {list.map(item => (
            <RestRow key={item.id} item={item} done={isDone} parts={parts} />
          ))}
        </List>
      </Fold>
    ) : null
  return (
    <div className="ui-folds">
      {fold('Later', later, false, 'later')}
      {fold('Done', done, true, 'done')}
    </div>
  )
}

// ── The page head ──────────────────────────────────────────────────────────

const WINDOW: Readonly<Record<string, string>> = {
  five_hour: 'Current session',
  seven_day: 'Weekly',
  seven_day_opus: 'Weekly Opus',
  seven_day_sonnet: 'Weekly Sonnet',
}
const heat = (n: number) => (n >= 90 ? 'hot' : n >= 75 ? 'warn' : undefined)

interface UsageWindow {
  readonly name: string
  readonly utilization: number
  readonly resetsAt?: number | null
}

function usageWindows(usage: unknown): UsageWindow[] | null {
  if (!usage || typeof usage !== 'object') return null
  const u = usage as { available?: unknown; known?: unknown; windows?: unknown }
  if (!u.available || !u.known || !Array.isArray(u.windows)) return null
  return u.windows.filter(
    (w): w is UsageWindow => !!w && typeof w === 'object' && typeof (w as UsageWindow).name === 'string' && typeof (w as UsageWindow).utilization === 'number' && !!WINDOW[(w as UsageWindow).name],
  )
}

/** What today has used: this Day's tokens and context, then the account's plan windows. */
function UsageStrip({ tokenUsage, contextTokens, contextLimit, usage }: { tokenUsage: { input: number; output: number; cacheRead: number; cacheCreation: number } | null | undefined; contextTokens: number | null | undefined; contextLimit: number | null | undefined; usage: unknown }) {
  const windows = usageWindows(usage)
  const share = contextTokens ? Math.round((contextTokens / (contextLimit || 200000)) * 100) : null
  return (
    <div className="page-strip-group" id="today-usage">
      {tokenUsage ? (
        <Stat
          label="This Day"
          title={`Input ${tokenUsage.input.toLocaleString()} · output ${tokenUsage.output.toLocaleString()} · cache read ${tokenUsage.cacheRead.toLocaleString()} · cache write ${tokenUsage.cacheCreation.toLocaleString()}. All models, scouts included.`}
        >
          {compactTokens(tokenUsage.input + tokenUsage.output + tokenUsage.cacheRead + tokenUsage.cacheCreation)} <small>tokens</small>
        </Stat>
      ) : null}
      {share !== null && contextTokens ? (
        <Stat label="Context" tone={heat(share)} title={`${contextTokens.toLocaleString()} tokens in the Day's conversation`}>
          <Bar percent={share} />
          {share}%
        </Stat>
      ) : null}
      {windows ? (
        windows.map(w => (
          <Stat key={w.name} label={WINDOW[w.name] ?? w.name} tone={heat(w.utilization)}>
            <Bar percent={w.utilization} />
            {w.utilization}%
            <small>
              {w.resetsAt
                ? ` · resets ${new Date(w.resetsAt).toLocaleString([], w.name === 'five_hour' ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
                : ''}
            </small>
          </Stat>
        ))
      ) : (
        <Stat label="Plan limits" tone="quiet">
          After the next run
        </Stat>
      )}
    </div>
  )
}

/** When the Day last looked at your sources and when it will next, and a way to ask now. */
function CheckState({ working, line, titles, checked, act }: { working: boolean; line: string; titles: string[]; checked: string; act: Act }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  if (working) {
    return (
      <span className="day-check-state is-running" title={titles.join('\n')}>
        <span className="day-spinner" aria-hidden="true" />
        {line}
      </span>
    )
  }
  const sweep = async () => {
    setBusy(true)
    try {
      await act({ op: 'sweep' })
      toast('Checking your sources')
    } catch (error) {
      toast(dayErrorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <span className="day-check-state">{checked}</span>
      <button type="button" className="button ghost" data-sweep="" disabled={busy} onClick={() => void sweep()}>
        <Icon name="refresh" /> Check now
      </button>
    </>
  )
}

// ── The board ──────────────────────────────────────────────────────────────

interface BoardParts {
  readonly rows: ReadonlyMap<string, RowInfo>
  readonly projects: readonly Named[]
  readonly teams: readonly Named[]
  readonly act: Act
}

const NO_SUBAGENTS: readonly DaySubagent[] = []

export function DayBoard({ dayId, today }: { dayId: string; today: TodayRows }) {
  const { session, detail, items: all, error } = useDayDetail(dayId, { poll: true })
  const act = useDayAction(dayId)
  const teams = useTeams()
  const projects = useProjects()
  const now = useNow(60_000)
  const scroller = useRef<HTMLDivElement>(null)
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set())
  const [flash, setFlash] = useState<string | null>(null)
  const reveal = usePendingReveal()
  const selection = useSelection('today')

  const items = useMemo(() => all.filter(i => i.status !== 'dropped'), [all])
  const subagents = detail?.subagents ?? NO_SUBAGENTS
  const status = session?.status ?? null
  const working = isWorking(status)
  const focus = detail?.dayBoard?.focus

  const liveContext: LiveContext = useMemo(
    () => ({ dayStatus: status, focus, subagents, rows: today.rows, now }),
    [status, focus, subagents, today.rows, now],
  )
  const live = (item: DayItem) => liveStatus(item, liveContext)
  const parts = useMemo<BoardParts>(() => ({ rows: today.rows, projects, teams, act }), [today.rows, projects, teams, act])

  const onOpenChange = (id: string, open: boolean) =>
    setOpened(previous => {
      if (previous.has(id) === open) return previous
      const next = new Set(previous)
      if (open) next.add(id)
      else next.delete(id)
      return next
    })

  // Another view sent the operator to an item (Projects' "On Today"): with no open
  // thread to show in the console, the board shows the item itself.
  const selectedItem = selection?.kind === 'day-thread' ? selection.itemId : null
  useEffect(() => {
    if (!selectedItem) return
    const item = items.find(i => i.id === selectedItem)
    if (item && (!item.thread || item.thread.closed)) requestReveal(selectedItem)
  }, [selectedItem, items])

  // Show one item, opened, in the middle of the board's own scroller (scrollIntoView
  // would move the whole window too), with a short flash.
  useEffect(() => {
    if (!reveal || !items.some(i => i.id === reveal)) return
    onOpenChange(reveal, true)
    const frame = requestAnimationFrame(() => {
      const box = scroller.current
      const row = box?.querySelector<HTMLElement>(`[data-card="${CSS.escape(reveal)}"]`)
      if (box && row) {
        const r = row.getBoundingClientRect()
        const b = box.getBoundingClientRect()
        box.scrollBy?.({ top: r.top - b.top - (b.height - r.height) / 2, behavior: 'smooth' })
      }
    })
    setFlash(reveal)
    takeReveal(reveal)
    const timer = setTimeout(() => setFlash(current => (current === reveal ? null : current)), 1600)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
    }
  }, [reveal, items])

  if (!session || !detail) {
    return (
      <section id="day-board" aria-label="Day board">
        <p className="note today-gathering">{error ? error.message : 'Loading your day…'}</p>
      </section>
    )
  }

  const board = detail.dayBoard
  const done = items.filter(i => i.status === 'done').length
  const triaged = items.filter(i => i.status !== 'proposed').length
  const waiting = items.reduce((n, i) => n + openNeeds(i).length, 0)
  const lastUser = [...session.messages].reverse().find(m => m.role === 'user')
  const busy = workingLine(items, focus?.itemId, subagents, lastUser)

  return (
    <section id="day-board" aria-label="Day board" data-session={dayId}>
      <PageHead
        title={board?.date ? dayHeading(board.date) : 'Today'}
        actions={
          <>
            {waiting ? <Pill tone="needs">{waiting} waiting on you</Pill> : null}
            <CheckState working={working} line={busy.text} titles={busy.titles} checked={checkedLine(detail.dayChecks, now)} act={act} />
          </>
        }
        strip={
          <>
            <Stat label="Done" title={`${done} of ${triaged} triaged items done`}>
              <Ring done={done} total={triaged} />
              {done} <small>of {triaged}</small>
            </Stat>
            <UsageStrip tokenUsage={detail.tokenUsage} contextTokens={detail.contextTokens} contextLimit={detail.contextLimit} usage={today.usage} />
          </>
        }
      />
      <div className="page-body today-body" ref={scroller}>
        {!items.length && working ? (
          <p className="note today-gathering">Gathering your day from Slack, Linear, Granola, GitHub and your calendar…</p>
        ) : null}
        <WaitingSection items={items} {...parts} />
        <TriageSection items={items} projects={projects} act={act} />
        <TodaySection items={items} live={live} opened={opened} flash={flash} onOpenChange={onOpenChange} freeMinutes={board?.capacity?.freeMinutes} parts={parts} />
        <AddForm act={act} />
        <RestFolds items={items} parts={parts} reveal={flash} />
      </div>
    </section>
  )
}
