// The Worktrees tab (F29): every checkout a session has worked in, with its branch,
// whether that branch is merged, whether a pull request is open, and whether anything
// in it exists only there. Merged and clean ones can be cleared. A page to read, full
// width, no inspector.
//
// The page only decides what to show. Whether a worktree may go is decided again by
// the server, from git, when the operator confirms.
import { useState } from 'react'
import { useActions, usePreference, usePreferences } from '../../app/AppStore'
import { WORKTREE_FILTERS, type WorktreeFilter } from '../../app/preferences'
import { EmptyState } from '../../components/EmptyState'
import { Icon } from '../../components/Icon'
import { Select } from '../../components/Select'
import { useAnnounce } from '../../components/Toast'
import type { Checkout } from '../../transport/contracts'
import { useFleetClient, useResource } from '../../transport/hooks'
import { Callout, List, PageHead, Pill, Row, Section, Stat } from '../projects/pageKit'
import { useRefreshWhileVisible } from '../projects/useRefreshWhileVisible'
import './worktrees.css'

/** The list is read again when older than this: git and gh answer on each request. */
const FRESH_MS = 15_000

export const FILTER_LABELS: Readonly<Record<WorktreeFilter, string>> = {
  all: 'All checkouts',
  clearable: 'Safe to clear',
  merged: 'Merged',
  pr: 'Open pull request',
  care: 'Uncommitted or unpushed',
}
const MATCH: Readonly<Record<WorktreeFilter, (c: Checkout) => boolean>> = {
  all: () => true,
  clearable: c => c.clearable,
  merged: c => c.merged,
  pr: c => c.pr?.state === 'OPEN',
  care: c => c.dirty > 0 || c.unpushed > 0,
}
const FILTER_OPTIONS = WORKTREE_FILTERS.map(value => ({ value, label: FILTER_LABELS[value] }))

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
const secureLink = (url: string | undefined): string | null => (url && /^https:\/\//.test(url) ? url : null)

function PrPill({ checkout }: { checkout: Checkout }) {
  const pr = checkout.pr
  if (!pr) return null
  const href = secureLink(pr.url)
  const label = `PR #${pr.number}${pr.state === 'OPEN' ? ' open' : pr.state === 'MERGED' ? ' merged' : ' closed'}`
  return (
    <Pill tone={pr.state === 'OPEN' ? 'working' : 'outline'}>
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {label}
        </a>
      ) : (
        label
      )}
    </Pill>
  )
}

function Pills({ checkout: c }: { checkout: Checkout }) {
  return (
    <>
      {c.isMain ? (
        <Pill tone="outline">Main checkout</Pill>
      ) : c.merged ? (
        <Pill tone="done">Merged</Pill>
      ) : c.empty ? (
        <Pill tone="idle">No commits yet</Pill>
      ) : c.trunk && c.branch ? (
        <Pill tone="idle">Not merged into {c.trunk}</Pill>
      ) : null}
      <PrPill checkout={c} />
      {c.dirty > 0 ? <Pill tone="needs">{c.dirty} uncommitted</Pill> : null}
      {c.unpushed > 0 ? <Pill tone="needs">{c.unpushed} unpushed</Pill> : null}
      {c.running ? <Pill tone="working">Session running</Pill> : null}
      {c.locked ? <Pill tone="outline">Locked</Pill> : null}
    </>
  )
}

const toneOf = (c: Checkout): string =>
  c.running ? 'working' : c.clearable ? 'done' : c.dirty > 0 || c.unpushed > 0 ? 'needs' : c.pr?.state === 'OPEN' ? 'progress' : c.isMain ? 'idle' : 'queued'

function Detail({ checkout: c }: { checkout: Checkout }) {
  return (
    <div className="worktree-detail">
      {c.clearable ? (
        <p className="note">Merged, nothing uncommitted, nothing unpushed. Safe to remove.</p>
      ) : (
        <>
          <p className="note">Kept because:</p>
          <ul className="worktree-why">
            {c.blockers.map(blocker => (
              <li key={blocker.text}>{blocker.text}</li>
            ))}
          </ul>
        </>
      )}
      <p className="note">
        Worktree <code>{c.pathShort}</code>
        {c.tip ? (
          <>
            {' at '}
            <code>{c.tip.slice(0, 7)}</code>
          </>
        ) : null}
      </p>
      <h5 className="ui-label">{plural(c.sessions.length, 'session')}</h5>
      <ul className="worktree-sessions">
        {c.sessions.map((session, index) => (
          <li key={`${session.cwd}:${index}`}>
            <strong>{session.name || 'Untitled session'}</strong>{' '}
            <span className="note">
              {session.engine === 'codex' ? 'Codex' : 'Claude'}
              {session.alive ? ' · running' : ''} · <code>{session.cwd}</code>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function WorktreesPage() {
  const client = useFleetClient()
  const announce = useAnnounce()
  const { openModal } = useActions()
  const preferences = usePreferences()
  const filter = usePreference('worktreesFilter')
  const state = useResource(client.resources.worktrees)
  const report = state.data?.value
  // Open rows stay open across redraws and refreshes: the page owns that, not the DOM.
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set())
  useRefreshWhileVisible(client.resources.worktrees.key, FRESH_MS, state.data?.fetchedAt)

  const refresh = () => {
    void client.store.refresh(client.resources.worktrees).then(() => announce('Worktrees refreshed'))
  }
  const toggle = (path: string, open: boolean) =>
    setOpened(previous => {
      if (previous.has(path) === open) return previous
      const next = new Set(previous)
      if (open) next.add(path)
      else next.delete(path)
      return next
    })

  const controls = (
    <>
      <Select id="worktree-filter" label="Show" value={filter} options={FILTER_OPTIONS} onChange={value => preferences.set('worktreesFilter', value)} />
      <button type="button" className="button ghost" data-refresh-worktrees title="Read the checkouts again" onClick={refresh}>
        <Icon name="refresh" /> Refresh
      </button>
    </>
  )

  if (!report) {
    return (
      <>
        <PageHead title="Worktrees" actions={controls} />
        <div className="page-body">
          {state.error ? <Callout title="Could not load worktrees" tone="hot">Try again in a moment.</Callout> : <p className="note">Reading your checkouts…</p>}
        </div>
      </>
    )
  }

  const all = report.checkouts
  const shown = all.filter(MATCH[filter])
  const count = (test: (c: Checkout) => boolean) => all.filter(test).length
  const clearable = count(MATCH.clearable)
  const care = count(MATCH.care)
  return (
    <>
      <PageHead
        title="Worktrees"
        actions={controls}
        strip={
          <>
            <Stat label="Checkouts">{all.length}</Stat>
            <Stat label="Safe to clear" tone={clearable ? undefined : 'quiet'}>
              {clearable}
            </Stat>
            <Stat label="Open PR">{count(MATCH.pr)}</Stat>
            <Stat label="Needs care" tone={care ? 'warn' : 'quiet'} title="Uncommitted changes or commits that exist nowhere else">
              {care}
            </Stat>
          </>
        }
      />
      <div className="page-body">
        <Section
          title="Checkouts"
          count={shown.length}
          aside={
            <span className="note">
              Merged is measured against the trunk as last fetched; pull requests come from <code>gh</code> when it is signed in
            </span>
          }
        >
          {!all.length ? (
            <EmptyState title="No worktrees yet." text="Sessions that ran inside a git checkout show up here, with the branch they worked on." />
          ) : !shown.length ? (
            <EmptyState title="Nothing matches." text={`No checkout is under “${FILTER_LABELS[filter]}”.`} />
          ) : (
            <List>
              {shown.map(c => (
                <Row
                  key={c.path}
                  tone={toneOf(c)}
                  orbTitle={c.clearable ? 'Safe to clear' : 'Keep'}
                  title={c.branch ?? 'Detached HEAD'}
                  meta={
                    <>
                      <Pills checkout={c} />
                      <span className="ui-row-latest" title={c.path}>
                        {c.repo.name} · {c.pathShort}
                      </span>
                    </>
                  }
                  side={
                    c.clearable ? (
                      <button
                        type="button"
                        className="button ghost"
                        data-clear-worktree={c.path}
                        aria-label={`Clear ${c.branch ?? 'detached HEAD'}`}
                        onClick={() => openModal({ kind: 'clear-worktree', path: c.path })}
                      >
                        Clear…
                      </button>
                    ) : null
                  }
                  detail={<Detail checkout={c} />}
                  open={opened.has(c.path)}
                  onOpenChange={open => toggle(c.path, open)}
                  evidence={c.path}
                />
              ))}
            </List>
          )}
        </Section>
        {report.outside ? (
          <p className="note">
            {plural(report.outside, 'session')} ran outside a git checkout, or in a folder that is gone, and {report.outside === 1 ? 'is' : 'are'} not
            listed.
          </p>
        ) : null}
      </div>
    </>
  )
}
