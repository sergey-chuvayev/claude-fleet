// The Search dialog (F21): one question across every transcript on this machine.
// Keyword matches render the moment the server has them; the written answer arrives a
// few seconds later (polled every 700 ms while the job is thinking) and reorders the
// cards by what Claude found relevant. Opened by the Search button and Cmd/Ctrl+K,
// both owned by the shell.
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { useActions } from '../../app/AppStore'
import type { ModalProps } from '../../app/modals'
import { MODAL_IDS } from '../../app/modals'
import { selectionOf } from '../../app/state'
import { Dialog, DialogFoot, DialogHead } from '../../components/Dialog'
import { Icon } from '../../components/Icon'
import { Select } from '../../components/Select'
import { useNow } from '../../components/clock'
import { type SessionSummary, parseSearchJob } from '../../transport/contracts'
import { useFleetClient, useResource } from '../../transport/hooks'
import { errorText, isNotFound } from '../../transport/errors'
import { SearchResults, type SearchView } from './SearchResults'
import '../../styles/search.css'

export const POLL_MS = 700

const MODELS = [
  { value: 'haiku', label: 'Haiku' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'opus', label: 'Opus' },
] as const

const SUGGESTIONS = [
  { symbol: '↳', title: 'Pick up a thought', hint: 'What did we decide about…', question: 'What did we decide about ' },
  { symbol: '⌘', title: 'Find that fix', hint: 'How did we fix…', question: 'How did we fix ' },
  { symbol: '⋯', title: 'Remember what’s next', hint: 'What is left to do on…', question: 'What is left to do on ' },
] as const

/**
 * The search state machine. `ticket` numbers each submit, so a slow answer to search A
 * can never replace search B, and a poll belongs to the job it was started for.
 */
export function useSearch() {
  const client = useFleetClient()
  const [job, setJob] = useState<SearchView | null>(null)
  const ticket = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const controller = useRef<AbortController | null>(null)

  const stopPolling = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    controller.current?.abort()
    controller.current = null
  }, [])
  useEffect(() => stopPolling, [stopPolling])

  const poll = useCallback(
    (id: string, mine: number) => {
      timer.current = setTimeout(async () => {
        timer.current = null
        const abort = new AbortController()
        controller.current = abort
        try {
          const next = await client.getJson(`/api/search/${encodeURIComponent(id)}`, parseSearchJob, { signal: abort.signal, timeoutMs: 8000 })
          if (mine !== ticket.current || next.id !== id) return
          setJob(next)
          if (next.status === 'thinking') poll(id, mine)
        } catch (error) {
          if (mine !== ticket.current || abort.signal.aborted) return
          if (isNotFound(error)) {
            // The job expired on the server: keep what we have, say so, stop.
            setJob(current =>
              current && 'id' in current
                ? { ...current, status: 'error', error: 'This search expired. Search again to read the answer.' }
                : current,
            )
            return
          }
          poll(id, mine) // A blip: the next poll will tell.
        }
      }, POLL_MS)
    },
    [client],
  )

  const submit = useCallback(
    async (question: string, model: string) => {
      const mine = ++ticket.current
      stopPolling()
      setJob({ status: 'searching', question, hits: [] })
      try {
        const next = parseSearchJob(await client.post('/api/search', { question, model }))
        if (mine !== ticket.current) return
        setJob(next)
        if (next.status === 'thinking') poll(next.id, mine)
      } catch (error) {
        if (mine !== ticket.current) return
        setJob({ id: '', question, model, status: 'error', hits: [], error: errorText(error, 'The search failed.') })
      }
    },
    [client, poll, stopPolling],
  )

  return { job, submit }
}

export function SearchDialog({ onClose }: ModalProps<'search'>) {
  const client = useFleetClient()
  const actions = useActions()
  const now = useNow(30_000)
  const sessions = useResource(client.resources.sessions).data?.sessions
  const { job, submit } = useSearch()
  const [question, setQuestion] = useState('')
  const [model, setModel] = useState('haiku')
  const input = useRef<HTMLInputElement>(null)

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    const text = question.trim()
    if (text) void submit(text, model)
  }
  // A newer search replaces one still in flight, so the button never locks.
  // Selection and view are the app's; go through its actions, then get out of the way.
  const openSession = (session: SessionSummary) => {
    actions.closeModal('search')
    actions.navigate('sessions')
    actions.select(selectionOf(session), { reveal: true })
  }

  return (
    <Dialog id={MODAL_IDS.search} className="modal modal-ask" labelledBy="ask-title" onClose={onClose} initialFocus="#ask-input">
      <DialogHead
        titleId="ask-title"
        spark="✳"
        eyebrow="A LITTLE HELP REMEMBERING"
        title="Find the thread."
        lead="Good ideas are somewhere in your sessions. Let’s find them."
        closeLabel="Close search"
      />
      <form id="ask-form" className="ask-bar" onSubmit={onSubmit}>
        <div className="ask-input-wrap">
          <span className="ask-icon" aria-hidden="true">
            <Icon name="search" />
          </span>
          <input
            ref={input}
            id="ask-input"
            type="text"
            placeholder="What did we discuss?"
            maxLength={500}
            required
            autoComplete="off"
            aria-label="Search all sessions"
            value={question}
            onChange={event => setQuestion(event.target.value)}
          />
        </div>
        <Select id="ask-model" className="ask-model" label="Model that reads the matches" value={model} options={MODELS} onChange={setModel} />
        <button type="submit" id="ask-submit" className="button resume ask-go">
          Search <Icon name="arrow" />
        </button>
      </form>
      <div className="modal-body ask-content">
        {job ? null : (
          <div id="ask-welcome" className="ask-welcome">
            <div className="suggestion-heading">
              <span>START WITH A QUESTION</span>
              <span>Across all your sessions</span>
            </div>
            {SUGGESTIONS.map(s => (
              <button
                key={s.title}
                type="button"
                className="ask-suggestion"
                data-question={s.question}
                onClick={() => {
                  setQuestion(s.question)
                  input.current?.focus()
                }}
              >
                <span className="suggestion-symbol" aria-hidden="true">
                  {s.symbol}
                </span>
                <span>
                  <strong>{s.title}</strong>
                  <small>{s.hint}</small>
                </span>
                <span aria-hidden="true">
                  <Icon name="arrow" />
                </span>
              </button>
            ))}
          </div>
        )}
        <div id="ask-results" aria-live="polite" aria-busy={job?.status === 'searching' || job?.status === 'thinking'}>
          {job ? <SearchResults job={job} sessions={sessions ?? []} now={now} onOpenSession={openSession} /> : null}
        </div>
      </div>
      <DialogFoot>
        <span>
          <span className="modal-status-dot" aria-hidden="true" />
          Your sessions, a little easier to find.
        </span>
        <span>
          <kbd>↵</kbd> search{' '}
          <span className="shortcut-gap">
            <kbd>Esc</kbd> close
          </span>
        </span>
      </DialogFoot>
    </Dialog>
  )
}
