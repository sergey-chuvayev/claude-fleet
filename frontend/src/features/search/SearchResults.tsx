// The results of one search: the question and stats, the status line, the written
// answer and the cards. Keyword hits render the moment the server has them; once the
// answer arrives its matches lead, in the order Claude cited them, and the hits it did
// not cite fold under one disclosure. Everything is text, never markup.
import type { ReactNode } from 'react'
import { CopyButton } from '../../components/CopyButton'
import { Disclosure } from '../../components/Disclosure'
import { Icon } from '../../components/Icon'
import { age } from '../../domain/format'
import { sessionKey } from '../../domain/ids'
import type { SearchHit, SearchJob, SearchMatch, SessionSummary } from '../../transport/contracts'

/** What the dialog shows: the server's job, or the moment before it answers. */
export type SearchView =
  | { readonly status: 'searching'; readonly question: string; readonly hits: readonly SearchHit[] }
  | SearchJob

const REL_WORD: Record<string, string> = { high: 'strong match', medium: 'related', low: 'loosely related' }
const dateOf = (ms: number) => new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' })
const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`

export interface SearchResultsProps {
  readonly job: SearchView
  readonly sessions: readonly SessionSummary[]
  readonly now: number
  /** Open a live session in the Sessions view. */
  readonly onOpenSession: (session: SessionSummary) => void
}

export function SearchResults({ job, sessions, now, onOpenSession }: SearchResultsProps) {
  const id = 'id' in job ? job.id : null
  const hits = job.hits
  const ai = 'ai' in job ? job.ai : null
  const error = 'error' in job ? job.error : null
  const liveOf = (sessionId: string) => sessions.find(s => s.sessionId === sessionId) ?? null
  const card = (hit: SearchHit, match: SearchMatch | null) => (
    <HitCard key={hit.sessionId} hit={hit} match={match} live={liveOf(hit.sessionId)} now={now} onOpenSession={onOpenSession} />
  )

  let status = null
  if (job.status === 'searching') status = <p className="ask-status is-live">Searching your transcripts…</p>
  else if (job.status === 'thinking')
    status = (
      <p className="ask-status is-live">
        Reading the {Math.min(hits.length, 10)} best matches with {'model' in job ? job.model : ''}…
      </p>
    )
  else if (job.status === 'error')
    status = (
      <p className="ask-status is-failed">
        {error || 'The answer failed.'}
        {hits.length ? ' Keyword matches are still shown below.' : ''}
      </p>
    )
  else if (job.status === 'stopped') status = <p className="ask-status">{error || 'Replaced by a newer search.'}</p>

  let cards: ReactNode = null
  if (ai && ai.matches.length) {
    const byId = new Map(hits.map(h => [h.sessionId, h]))
    const cited = ai.matches.flatMap(m => {
      const hit = byId.get(m.sessionId)
      return hit ? [[m, hit] as const] : []
    })
    const rest = hits.filter(h => !ai.matches.some(m => m.sessionId === h.sessionId))
    cards = (
      <>
        {cited.map(([m, h]) => card(h, m))}
        {rest.length ? (
          <Disclosure
            className="ask-rest"
            summary={`${plural(rest.length, 'other keyword match', 'other keyword matches')} Claude did not find relevant`}
          >
            {rest.map(h => card(h, null))}
          </Disclosure>
        ) : null}
      </>
    )
  } else if (hits.length) {
    cards = (
      <>
        <p className="ask-section">Keyword matches{ai ? ' · none judged relevant' : ''}</p>
        {hits.map(h => card(h, null))}
      </>
    )
  } else if (id) {
    cards = <p className="ask-empty">No matching threads yet. Try a project name, a feature, or a few words you remember.</p>
  }

  return (
    <>
      <div className="ask-head">
        <span className="ask-question">“{job.question}”</span>
        {id && 'sessions' in job ? (
          <span className="ask-stats">
            {plural(job.sessions ?? 0, 'session')} · {job.passages ?? 0} passages · {job.searchMs ?? 0} ms
          </span>
        ) : null}
      </div>
      {status}
      {ai ? (
        <div className="ask-answer">
          <span className="ask-answer-label">Answer</span>
          <p>{ai.answer}</p>
        </div>
      ) : null}
      {cards}
    </>
  )
}

function HitCard({
  hit,
  match,
  live,
  now,
  onOpenSession,
}: {
  hit: SearchHit
  match: SearchMatch | null
  live: SessionSummary | null
  now: number
  onOpenSession: (session: SessionSummary) => void
}) {
  const title = hit.title || live?.title || live?.name || 'Untitled session'
  const when = hit.lastAt ? `${dateOf(hit.lastAt)} · ${age(hit.lastAt, now)} ago` : ''
  const snippets = hit.snippets ?? []
  const matches = hit.matches ?? snippets.length
  return (
    <article className="ask-hit" data-relevance={match?.relevance ?? ''} data-session={hit.sessionId}>
      <div className="ask-hit-head">
        <span className="ask-hit-title">{title}</span>
        {match ? <span className="ask-rel">{REL_WORD[match.relevance ?? ''] ?? 'related'}</span> : null}
        <span className="ask-hit-meta">
          {hit.project || 'unknown project'}
          {when ? ` · ${when}` : ''}
          {live ? (
            <>
              {' · '}
              <span className="ask-live">open now</span>
            </>
          ) : null}
        </span>
      </div>
      {match?.context ? <p className="ask-context">{match.context}</p> : null}
      {match?.quote ? <blockquote className="ask-quote">{match.quote}</blockquote> : null}
      {snippets.length ? (
        <Disclosure
          className="ask-snippets"
          defaultOpen={!match}
          summary={`${plural(matches, 'matching passage')} · keyword excerpts`}
        >
          {snippets.map((s, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: excerpts are a fixed list per hit
            <p className="ask-snippet" key={i}>
              <span className="ask-role">{s.role === 'user' ? 'you' : 'claude'}</span>
              {s.text}
            </p>
          ))}
        </Disclosure>
      ) : null}
      <div className="ask-hit-actions">
        {live ? (
          <button type="button" className="button ask-open" data-open-session={sessionKey(live)} onClick={() => onOpenSession(live)}>
            Open in Fleet <Icon name="arrow" />
          </button>
        ) : (
          <CopyButton
            className="button ask-open"
            text={`claude --resume ${hit.sessionId}`}
            copiedMessage="Resume command copied"
            title="This session is not open right now"
          >
            Copy resume command
          </CopyButton>
        )}
      </div>
    </article>
  )
}
