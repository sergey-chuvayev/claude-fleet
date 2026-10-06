// The Progress tab (F20): a weekly look at what shipped, what stalled and what ran,
// read from the Day boards and sessions Fleet already keeps. A page to read, full
// width, no console. "Shipped" means marked done on the Day; Fleet never asks GitHub
// whether a pull request merged, and this page says so.
import { Icon } from '../../components/Icon'
import { EmptyState } from '../../components/EmptyState'
import { useAnnounce } from '../../components/Toast'
import type { ProgressReport } from '../../transport/contracts'
import { useFleetClient, useResource } from '../../transport/hooks'
import { Callout, List, PageHead, Pill, Row, Section, Stat } from '../../components/ui'
import { isWebLink } from '../../domain/links'
import { useRefreshWhileVisible } from '../projects/useRefreshWhileVisible'
import './progress.css'

/** The report is read again when older than this, as the legacy page did. */
const FRESH_MS = 15_000

const TONE: Readonly<Record<string, string>> = { failed: 'hot', 'needs you': 'needs', running: 'working', queued: 'queued', stopped: 'idle', finished: 'done' }
const STATUS: Readonly<Record<string, string>> = {
  proposed: 'proposed',
  today: 'planned',
  in_progress: 'in progress',
  waiting_on_you: 'waiting on you',
  starting: 'starting',
  running: 'running',
  approval: 'needs you',
  stopping: 'stopping',
  queued: 'queued',
}

const when = (at: number | string): string => new Date(at).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })
const ago = (at: number, now: number): string => {
  const days = Math.floor((now - at) / 86_400_000)
  return days < 1 ? 'today' : `${days} day${days === 1 ? '' : 's'} ago`
}
const prLabel = (url: string): string => {
  const match = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i.exec(url)
  return match ? `${match[1]}#${match[2]}` : url
}

export function ProgressPage() {
  const client = useFleetClient()
  const announce = useAnnounce()
  const state = useResource(client.resources.progress)
  const report = state.data?.value
  useRefreshWhileVisible(client.resources.progress.key, FRESH_MS, state.data?.fetchedAt)

  const refresh = () => {
    void client.store.refresh(client.resources.progress).then(() => announce('Progress refreshed'))
  }
  const refreshButton = (
    <button type="button" className="button ghost" data-refresh-progress title="Read this week again" onClick={refresh}>
      <Icon name="refresh" /> Refresh
    </button>
  )

  if (!report) {
    return (
      <>
        <PageHead title="Progress" actions={refreshButton} />
        <div className="page-body">
          {state.error ? <Callout title="Could not load progress" tone="hot">Try again in a moment.</Callout> : <p className="note">Reading your week…</p>}
        </div>
      </>
    )
  }

  const outcomes = Object.entries(report.ran.outcomes)
    .map(([name, count]) => `${count} ${name}`)
    .join(' · ')
  const now = Date.now()
  return (
    <>
      <PageHead
        title="Progress"
        actions={
          <>
            <span className="note">
              Last {report.days} days, since {when(report.since)}
            </span>
            {state.error ? <span className="note">Showing the last report; refreshing failed.</span> : null}
            {refreshButton}
          </>
        }
        strip={
          <>
            <Stat label="Shipped" tone={report.shipped.count ? 'done' : undefined}>
              {report.shipped.count}
            </Stat>
            <Stat label="PRs">{report.shipped.prs}</Stat>
            <Stat label="Stalled" tone={report.stalled.count ? 'warn' : undefined}>
              {report.stalled.count}
            </Stat>
            <Stat label="Ran">{report.ran.count}</Stat>
          </>
        }
      />
      <div className="page-body">
        <Section label="Shipped" count={report.shipped.count} aside={<span className="note">Done on your Day; Fleet does not check GitHub for merges</span>}>
          <Shipped shipped={report.shipped} />
        </Section>
        <Section label="Stalled" count={report.stalled.count} aside={<span className="note">Open with no update in {report.staleDays} days</span>}>
          <Stalled stalled={report.stalled} days={report.staleDays} now={now} />
        </Section>
        <Section label="Ran" count={report.ran.count} aside={outcomes ? <span className="note">{outcomes}</span> : undefined}>
          <Ran ran={report.ran} />
        </Section>
      </div>
    </>
  )
}

function Shipped({ shipped }: { shipped: ProgressReport['shipped'] }) {
  if (!shipped.items.length) {
    return <EmptyState title="Nothing shipped yet." text="Items marked done on your Day show up here, with the pull requests linked on them." />
  }
  return (
    <List>
      {shipped.items.map(item => (
        <Row
          key={item.id}
          tone="done"
          orbTitle="Done"
          title={item.title}
          meta={
            <>
              {when(`${item.date}T12:00:00`)}
              {item.prs.length ? (
                <>
                  {' · '}
                  {item.prs.map(url =>
                    isWebLink(url) ? (
                      <a key={url} href={url} target="_blank" rel="noopener noreferrer">
                        {prLabel(url)} <Icon name="arrow" />
                      </a>
                    ) : (
                      <span key={url}>{prLabel(url)}</span>
                    ),
                  )}
                </>
              ) : null}
            </>
          }
        />
      ))}
    </List>
  )
}

function Stalled({ stalled, days, now }: { stalled: ProgressReport['stalled']; days: number; now: number }) {
  if (!stalled.items.length) {
    return <EmptyState title="Nothing stalled." text={`No open item or running session has gone ${days} days without moving.`} />
  }
  return (
    <List>
      {stalled.items.map(item => (
        <Row
          key={`${item.kind}:${item.id}`}
          tone="needs"
          orbTitle="Stalled"
          title={item.title}
          meta={`${item.kind === 'session' ? 'Session' : 'Item'} · ${STATUS[item.status] ?? item.status} · no movement ${ago(item.lastMoved, now)}`}
        />
      ))}
    </List>
  )
}

function Ran({ ran }: { ran: ProgressReport['ran'] }) {
  if (!ran.sessions.length) {
    return <EmptyState title="No sessions ran." text="Agents you launch from Fleet show up here with how they ended." />
  }
  return (
    <List compact>
      {ran.sessions.map(session => (
        <Row
          key={session.id}
          tone={TONE[session.outcome] ?? 'idle'}
          orbTitle={session.outcome}
          title={session.name.slice(0, 80)}
          meta={
            <>
              <Pill tone={TONE[session.outcome]}>{session.outcome}</Pill> {when(session.at)}
              {session.teamName ? ` · ${session.teamName}` : null}
            </>
          }
        />
      ))}
    </List>
  )
}
