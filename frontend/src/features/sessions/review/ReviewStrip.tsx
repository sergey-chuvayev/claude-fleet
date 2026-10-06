// The review loop strip (#review-panel, F30): the state and CI of the pull requests a
// session mentioned (read by the server with gh), and, for a Fleet-managed session, a
// Feedback form that tells it what to fix. Feedback goes through the normal message
// route, so it queues behind a running turn exactly as a typed message does. Ported
// from public/review.js. Mount it keyed by session, so each session starts fresh; the
// typed draft is kept per session in `drafts` while another one is open.
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { Icon } from '../../../components/Icon'
import { Select } from '../../../components/Select'
import { type SessionKey, sessionKey } from '../../../domain/ids'
import type { FleetClient } from '../../../transport/client'
import { type PrStatus, type SessionLink, type SessionRow, parsePrStatus } from '../../../transport/contracts'
import { useFleetClient, useResource } from '../../../transport/hooks'
import { mutationInvalidates, perClient, resourceFamily } from '../../../transport/resources'
import type { Resource } from '../../../transport/store'
import { Pill } from '../../../components/ui'
import { CI_LABEL, STATE, ciFeedback, names, prLinks, problem } from './review'

const POLL_MS = 30_000
const CUSTOM = 'custom'
const CI = 'ci'

/** What was typed per session, kept while another session is open. */
const drafts = new Map<SessionKey, string>()

// The PR status route needs no token and no conditional state. A PR that cannot be
// read is a line saying so, not a failed strip.
async function loadStatus(client: FleetClient, url: string, signal: AbortSignal): Promise<PrStatus> {
  try {
    return await client.getJson(`/api/pr-status?url=${encodeURIComponent(url)}`, parsePrStatus, { signal })
  } catch (error) {
    if (signal.aborted) throw error
    return { ok: false, reason: 'failed' }
  }
}

// One resource per client and set of links, so the store dedupes and invalidates it.
const families = perClient((client: FleetClient) =>
  resourceFamily(
    (urls: string) => `pr-status:${urls}`,
    (key, urls: string): Resource<PrStatus[]> => ({
      key,
      load: async ({ signal }) => ({ data: await Promise.all(urls.split(' ').map(url => loadStatus(client, url, signal))) }),
    }),
  ),
)
const prStatusResource = (client: FleetClient, links: readonly SessionLink[]): Resource<PrStatus[]> =>
  families(client)(links.map(link => link.url).join(' '))

function PrLine({ link, status }: { link: SessionLink; status: PrStatus | undefined }) {
  const head = (
    <a className="work-link" href={link.url} target="_blank" rel="noopener noreferrer" title={link.url}>
      <Icon name="pr" /> {link.label ?? link.url} <Icon name="arrow" />
    </a>
  )
  if (!status)
    return (
      <li className="review-pr">
        {head}
        <span className="note">Checking…</span>
      </li>
    )
  if (!status.ok)
    return (
      <li className="review-pr">
        {head}
        <span className="note">{problem(status.reason)}</span>
      </li>
    )
  const [stateText, stateTone] = STATE[status.state] ?? STATE.unknown!
  const [ciText, ciTone] = CI_LABEL[status.ci.result]!
  return (
    <li className="review-pr">
      {head}
      <Pill tone={stateTone}>{status.draft && status.state === 'open' ? 'Draft' : stateText}</Pill>
      {/* Which checks fail is on the pill's tooltip, so every PR stays one line. */}
      {status.state === 'open' ? (
        <Pill tone={ciTone} title={status.ci.failing.length ? `Failing: ${names(status.ci.failing)}` : undefined}>
          {ciText}
        </Pill>
      ) : null}
    </li>
  )
}

export function ReviewStrip({ row }: { row: SessionRow }) {
  const links = prLinks(row)
  if (!links.length) return null
  return <ReviewPanel row={row} links={links} />
}

function ReviewPanel({ row, links }: { row: SessionRow; links: readonly SessionLink[] }) {
  const client = useFleetClient()
  const resource = prStatusResource(client, links)
  const statuses = useResource(resource).data
  const key = sessionKey(row)
  const managedId = row.managed && row.managedId ? row.managedId : null

  // Poll while the strip is on screen and the page is visible.
  useEffect(() => {
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) client.store.invalidate(resource.key)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [client, resource.key])

  const [text, setText] = useState(() => drafts.get(key) ?? '')
  // The form stays folded unless something was already typed into it.
  const [open, setOpen] = useState(() => !!drafts.get(key))
  const [preset, setPreset] = useState<string>(CUSTOM)
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState('')
  const [error, setError] = useState<string | null>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const ci = ciFeedback(statuses ?? [])
  const presetValue = preset === CI && !ci ? CUSTOM : preset

  const write = (value: string) => {
    setText(value)
    if (value) drafts.set(key, value)
    else drafts.delete(key)
  }

  const send = async (message: string) => {
    if (!managedId || sending || !message.trim()) return
    setSending(true)
    setError(null)
    try {
      await client.post(
        `/api/managed/${encodeURIComponent(managedId)}/messages`,
        { message: message.trim(), requestId: crypto.randomUUID() },
        { invalidate: mutationInvalidates.sessionChange(managedId) },
      )
      write('')
      setPreset(CUSTOM)
      setSent('Feedback sent to this session.')
    } catch (caught) {
      setError(caught instanceof Error && caught.message ? caught.message : 'Could not send feedback.')
    } finally {
      setSending(false)
    }
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    void send(text)
  }

  return (
    <div id="review-panel">
      <div className="review-strip" title={`Pull request status via gh${managedId ? '' : '. Continue this session in Fleet to send it feedback.'}`}>
        <div id="review-status">
          <ul className="review-prs">
            {links.map((link, i) => (
              <PrLine key={link.url} link={link} status={statuses?.[i]} />
            ))}
          </ul>
        </div>
        {managedId ? (
          <button
            type="button"
            className="button review-toggle"
            id="review-toggle"
            aria-expanded={open}
            aria-controls="review-form"
            onClick={() => {
              setOpen(!open)
              if (!open) requestAnimationFrame(() => textRef.current?.focus())
            }}
          >
            Feedback
          </button>
        ) : null}
      </div>
      {managedId ? (
        <form id="review-form" className="review-form" hidden={!open} onSubmit={onSubmit}>
          <label className="review-field">
            Feedback to this session
            <Select
              id="review-preset"
              label="Feedback to send"
              value={presetValue}
              options={[
                { value: CUSTOM, label: 'Write your own', description: 'Say what you want changed' },
                ...(ci ? [{ value: CI, label: 'CI failed, fix it', description: ci }] : []),
              ]}
              onChange={value => {
                setPreset(value)
                if (value === CI) write(ci)
                textRef.current?.focus()
              }}
            />
          </label>
          <textarea
            ref={textRef}
            id="review-text"
            rows={3}
            maxLength={16000}
            placeholder="What should it change?"
            aria-label="Feedback message"
            value={text}
            onChange={event => write(event.target.value)}
          />
          <div className="ui-actions">
            <button type="button" className="button" id="review-ci-send" hidden={!ci} title={ci} disabled={sending} onClick={() => void send(ci)}>
              Send CI fix request
            </button>
            <button type="submit" className="button resume" disabled={sending}>
              Send feedback <Icon name="arrow" />
            </button>
          </div>
          <p id="review-sent" className="note" role="status">
            {sent}
          </p>
          <p id="review-error" className="form-error" role="alert" hidden={!error}>
            {error}
          </p>
        </form>
      ) : null}
    </div>
  )
}
