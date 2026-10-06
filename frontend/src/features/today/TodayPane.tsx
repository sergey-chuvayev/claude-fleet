// The Today tab's working pane (shell slot, inside section#today-pane): today's Day
// board, or the button that starts one. One Day per local date; the server refuses a
// second, so starting can only ever lead to one.
import { useRef, useState } from 'react'
import { EmptyState } from '../../components/EmptyState'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { useFleetClient } from '../../transport/hooks'
import { keys } from '../../transport/resources'
import { DayBoard } from './DayBoard'
import { ReportBack } from './ReportBack'
import { dayErrorMessage, setDraft, useDraft, useTodayRows } from './useDay'
import '../../styles/today.css'

export function TodayPane() {
  return (
    <>
      <ReportBack />
      <TodayContent />
    </>
  )
}

function TodayContent() {
  const today = useTodayRows()
  if (!today.loaded) {
    return today.error ? <EmptyState className="today-empty" title="Good morning." text={today.error.message} /> : null
  }
  const dayId = today.day?.managedId
  if (!dayId) return <StartDay carriesOver={today.anyDay} />
  // Keyed by the Day: a new date is a new board, nothing carries over in the UI.
  return <DayBoard key={dayId} dayId={dayId} today={today} />
}

function StartDay({ carriesOver }: { carriesOver: boolean }) {
  const client = useFleetClient()
  const toast = useToast()
  const [note, setNote] = useDraft('start:note')
  const [busy, setBusy] = useState(false)
  // Kept until the server has the Day, so a retry after a lost answer is the same request.
  const requestId = useRef<string | null>(null)
  const start = async () => {
    if (busy) return
    setBusy(true)
    requestId.current ??= crypto.randomUUID()
    const prompt = note.trim()
    try {
      await client.post('/api/managed', { kind: 'day', ...(prompt ? { prompt } : {}), requestId: requestId.current }, { invalidate: [keys.sessions] })
      requestId.current = null
      setDraft('start:note', null)
      toast('Good morning. Gathering your day.')
    } catch (error) {
      // A Day for this date already exists (another window started it): show it.
      client.store.invalidate(keys.sessions)
      toast(dayErrorMessage(error))
      setBusy(false)
    }
  }
  return (
    <EmptyState
      className="today-empty"
      title="Good morning."
      text="One agent reads your Slack, Linear, Granola, GitHub and calendar, proposes a plan, and works through it with you all day. Nothing is sent without your approval."
    >
      <textarea
        id="today-note"
        rows={3}
        maxLength={8000}
        value={note}
        aria-label="Anything to add before it starts"
        placeholder="Anything to add before it starts? Optional."
        onChange={event => setNote(event.target.value)}
      />
      <button type="button" className="button resume" id="start-day" disabled={busy} onClick={() => void start()}>
        Start my day <Icon name="arrow" />
      </button>
      {carriesOver ? <p className="note">Unfinished items from your last Day carry over, with their open questions.</p> : null}
    </EmptyState>
  )
}
