// One open question on a Day item (F18): approve an exact or edited draft, reject,
// choose, give information, launch a session from a brief with its repository and
// team, or reply in words. A reply goes to the Day agent as a message and never
// approves anything outward; only Approve or Launch does, with exactly the text shown.
import { type KeyboardEvent, useState } from 'react'
import { Icon } from '../../components/Icon'
import { Select } from '../../components/Select'
import { useToast } from '../../components/Toast'
import type { DayAction, DayItem, DayNeed as Need } from '../../transport/contracts'
import { type Named, dayErrorMessage, setDraft, useDraft } from './useDay'

type Answer = Extract<DayAction, { op: 'answer' }>

export interface DayNeedProps {
  readonly item: DayItem
  readonly need: Need
  readonly teams: readonly Named[]
  readonly act: (action: DayAction) => Promise<unknown>
}

/** Enter sends a one-line answer, as in the composer; Shift+Enter and IME composition do not. */
const sendOnEnter = (send: () => void) => (event: KeyboardEvent<HTMLInputElement>) => {
  if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
  event.preventDefault()
  send()
}

const rowsFor = (text: string, min: number, max: number) => Math.min(max, Math.max(min, text.split('\n').length + 1))

export function DayNeed({ item, need, teams, act }: DayNeedProps) {
  const toast = useToast()
  const key = `${item.id}:${need.id}`
  const original = need.draft ?? ''
  const [draft, setDraftText] = useDraft(`draft:${key}`, original)
  const [reply, setReply] = useDraft(`reply:${key}`)
  const [info, setInfo] = useDraft(`info:${key}`)
  const [cwd, setCwd] = useDraft(`cwd:${key}`, need.launch?.cwd ?? '')
  const [teamId, setTeamId] = useDraft(`team:${key}`, need.launch?.teamId ?? '')
  const [busy, setBusy] = useState(false)

  const send = async (body: Omit<Answer, 'op' | 'itemId' | 'needId'>, done: string) => {
    if (busy) return
    setBusy(true)
    try {
      await act({ op: 'answer', itemId: item.id, needId: need.id, ...body })
      for (const field of ['draft', 'reply', 'info', 'cwd', 'team']) setDraft(`${field}:${key}`, null)
      toast(done)
    } catch (error) {
      // What was typed stays where it was, so the operator can try again.
      toast(dayErrorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  // An edited draft is the operator's own version, sent exactly as typed.
  const approve = () => {
    const edited = draft.trim() && draft !== original
    const launch = need.kind === 'launch'
    const plan = launch ? { cwd: cwd.trim(), teamId } : {}
    void send(
      edited ? { answer: draft, decision: 'edit', ...plan } : { answer: 'approve', decision: 'approve', ...plan },
      launch && cwd.trim() ? 'Launched. It is in Sessions now.' : 'Answered',
    )
  }
  const reject = () => void send({ answer: 'reject', decision: 'reject' }, 'Rejected')
  const sendReply = () => {
    const text = reply.trim()
    if (!text) return toast('Type a reply first.')
    void send({ answer: text, decision: 'reply' }, 'Sent to your day agent')
  }
  const sendInfo = () => {
    const text = info.trim()
    if (!text) return toast('Type an answer first.')
    void send({ answer: text, decision: 'info' }, 'Answered')
  }

  const replyBox = (
    <div className="day-reply">
      <input
        value={reply}
        maxLength={2000}
        placeholder="Reply to your day agent…"
        aria-label="Reply to your day agent"
        onChange={event => setReply(event.target.value)}
        onKeyDown={sendOnEnter(sendReply)}
      />
      <button type="button" className="button" disabled={busy} onClick={sendReply}>
        Reply
      </button>
    </div>
  )

  if (need.kind === 'approve') {
    return (
      <div className="day-need" data-kind="approve" data-need={need.id}>
        <p>{need.question}</p>
        <textarea
          value={draft}
          rows={rowsFor(original, 3, 8)}
          maxLength={16000}
          aria-label="The exact text that will be sent"
          onChange={event => setDraftText(event.target.value)}
        />
        <div className="ui-actions">
          <button type="button" className="button resume" disabled={busy} onClick={approve}>
            Approve
          </button>
          <button type="button" className="button" disabled={busy} onClick={reject}>
            Reject
          </button>
          <span className="note">Edit the text to approve your version, or reply to discuss it.</span>
        </div>
        {replyBox}
      </div>
    )
  }

  if (need.kind === 'choose') {
    return (
      <div className="day-need" data-kind="choose" data-need={need.id}>
        <p>{need.question}</p>
        <div className="ui-actions">
          {(need.options ?? []).map(option => (
            <button
              key={option}
              type="button"
              className="button"
              disabled={busy}
              onClick={() => void send({ answer: option, decision: 'choose' }, 'Answered')}
            >
              {option}
            </button>
          ))}
        </div>
        {replyBox}
      </div>
    )
  }

  if (need.kind === 'launch') {
    const plannedTeam = need.launch?.teamId ?? ''
    const teamOptions = [
      { value: '', label: 'Single agent' },
      ...teams.map(t => ({ value: t.id, label: t.name })),
      ...(plannedTeam && !teams.some(t => t.id === plannedTeam) ? [{ value: plannedTeam, label: plannedTeam }] : []),
    ]
    return (
      <div className="day-need" data-kind="launch" data-need={need.id}>
        <p>{need.question}</p>
        <label className="day-field">
          Brief the new session starts from
          <textarea value={draft} rows={rowsFor(original, 4, 10)} maxLength={16000} onChange={event => setDraftText(event.target.value)} />
        </label>
        <div className="day-launch-fields">
          <label className="day-field">
            Repository
            <input value={cwd} maxLength={4096} data-launch="cwd" onChange={event => setCwd(event.target.value)} />
          </label>
          <div className="day-field">
            <span aria-hidden="true">Who</span>
            <Select value={teamId} options={teamOptions} onChange={setTeamId} label="Who" block />
          </div>
        </div>
        <div className="ui-actions">
          <button type="button" className="button resume" disabled={busy} onClick={approve}>
            Launch <Icon name="arrow" />
          </button>
          <button type="button" className="button" disabled={busy} onClick={reject}>
            Not now
          </button>
          <span className="note">Starts a Fleet session from this brief. It shows up in Sessions.</span>
        </div>
        {replyBox}
      </div>
    )
  }

  // info, and any kind this client does not know yet: answered in words.
  return (
    <div className="day-need" data-kind="info" data-need={need.id}>
      <p>{need.question}</p>
      <div className="ui-actions day-inline">
        <input
          value={info}
          maxLength={2000}
          aria-label={`Answer: ${need.question}`}
          onChange={event => setInfo(event.target.value)}
          onKeyDown={sendOnEnter(sendInfo)}
        />
        <button type="button" className="button resume" disabled={busy} onClick={sendInfo}>
          Answer
        </button>
      </div>
    </div>
  )
}
