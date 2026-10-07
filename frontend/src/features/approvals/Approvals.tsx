// Pending approvals for a managed session (F13): a tool call waiting for allow once or
// deny, with its input, the reason and, inside an initiative, the role that asked; or
// Claude's AskUserQuestion with single or multiple choice plus free text.
//
// Each card is keyed by its approval id, and the answers live in the answer store, so
// a refresh of the session (the stream sending a new message every second) changes
// nothing in a card: picks, typed text and focus all stay. A decision is sent once,
// never retried; an approval that is no longer pending (STALE_APPROVAL, 409) is
// explained and the session read again. Nothing here ever answers by itself: an
// approval is only ever sent from a click.
import { type FormEvent, memo, useRef, useState } from 'react'
import { useToast } from '../../components/Toast'
import { type Approval, type AskQuestion, askQuestionSchema } from '../../transport/contracts'
import { useFleetClient } from '../../transport/hooks'
import { codeOf, failureText, sessionCommand } from '../session-header/mutations'
import { useAnswerDraft } from './answers'

export interface ApprovalsProps {
  readonly managedId: string
  readonly approvals: readonly Approval[]
}

export function Approvals({ managedId, approvals }: ApprovalsProps) {
  return (
    <div id="approvals">
      {approvals.map(approval => (
        <ApprovalCard key={approval.id} managedId={managedId} approval={approval} />
      ))}
    </div>
  )
}

/**
 * After a decision the card goes away with the button that had focus, and focus would
 * fall to the page. Hand it to the next card waiting, else the composer.
 */
function keepFocus() {
  requestAnimationFrame(() => {
    const now = document.activeElement
    if (now && now !== document.body && now.isConnected) return
    const next =
      document.querySelector<HTMLElement>('#approvals form.approval button:not([disabled])') ??
      document.querySelector<HTMLElement>('#message-input')
    next?.focus()
  })
}

const STALE_TEXT = 'This request is no longer waiting: it was answered elsewhere or the agent moved on. The conversation was read again.'

export function questionsOf(approval: Approval): AskQuestion[] {
  const list = approval.input?.questions
  if (!Array.isArray(list)) return []
  return list.flatMap(q => {
    const parsed = askQuestionSchema.safeParse(q)
    return parsed.success ? [parsed.data] : []
  })
}

const ApprovalCard = memo(function ApprovalCard({ managedId, approval }: { managedId: string; approval: Approval }) {
  const client = useFleetClient()
  const toast = useToast()
  const key = `${managedId}:${approval.id}`
  const [draft, answers] = useAnswerDraft(key)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const form = useRef<HTMLFormElement>(null)
  const question = approval.tool === 'AskUserQuestion'
  const questions = question ? questionsOf(approval) : []
  // Inside an initiative, which role wants this is the whole question.
  const who = approval.role ? ` · ${approval.role.toUpperCase()}` : ''

  const decide = (decision: 'allow' | 'deny', given?: Record<string, string>) => {
    if (busy) return
    // Read before the buttons disable themselves and drop focus.
    const hadFocus = !!form.current?.contains(document.activeElement)
    setBusy(true)
    setError(null)
    const body = given ? { decision, answers: given } : { decision }
    sessionCommand(client, managedId, `approvals/${encodeURIComponent(approval.id)}`, body)
      .then(() => {
        answers.clear(key)
        if (hadFocus) keepFocus()
      })
      .catch(failure => {
        const stale = codeOf(failure) === 'STALE_APPROVAL'
        setError(stale ? STALE_TEXT : failureText(failure))
        if (stale) toast(STALE_TEXT)
        setBusy(false)
      })
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!question) return decide('allow')
    const given: Record<string, string> = {}
    for (const [i, q] of questions.entries()) {
      const other = (draft.other[i] ?? '').trim()
      given[q.question] = other || (draft.choices[i] ?? []).join(', ')
      if (!given[q.question]) {
        setError('Answer each question before continuing.')
        return
      }
    }
    decide('allow', given)
  }

  return (
    <form ref={form} className="approval" data-approval={approval.id} onSubmit={submit} aria-busy={busy || undefined}>
      <div className="eyebrow">
        {question ? 'CLAUDE HAS A QUESTION' : 'APPROVAL REQUIRED'}
        {who}
      </div>
      <h4>{approval.description || approval.tool}</h4>
      {approval.reason && !question ? <p className="approval-reason">{approval.reason}</p> : null}
      {question ? (
        questions.map((q, i) => (
          <fieldset key={`${i}:${q.question}`}>
            <legend>{q.question}</legend>
            {(q.options ?? []).map(option => (
              <label key={option.label} className="answer-option">
                <input
                  type={q.multiSelect ? 'checkbox' : 'radio'}
                  name={`q${i}`}
                  value={option.label}
                  checked={(draft.choices[i] ?? []).includes(option.label)}
                  onChange={event => answers.pick(key, i, option.label, !!q.multiSelect, event.currentTarget.checked)}
                />
                <span>
                  {option.label}
                  {option.description ? <small>{option.description}</small> : null}
                </span>
              </label>
            ))}
            <label className="other-answer">
              Your answer
              <input
                type="text"
                name={`other${i}`}
                placeholder="Or type your own answer"
                maxLength={4000}
                value={draft.other[i] ?? ''}
                onChange={event => answers.type(key, i, event.currentTarget.value)}
              />
            </label>
          </fieldset>
        ))
      ) : (
        <pre className="tool-input">{JSON.stringify(approval.input ?? {}, null, 2)}</pre>
      )}
      <div className="approval-actions">
        <button className="button" type="button" data-deny={approval.id} disabled={busy} onClick={() => decide('deny')}>
          {question ? 'Skip question' : 'Deny'}
        </button>
        <button className="button resume" type="submit" disabled={busy}>
          {question ? 'Send answer' : 'Allow once'}
        </button>
      </div>
      <p className="form-error" role="alert" hidden={!error}>
        {error}
      </p>
    </form>
  )
})
