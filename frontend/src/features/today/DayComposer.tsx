// Talking to the Day agent or an item thread: a text box, Enter to send, Shift+Enter
// for a new line, Stop while it works. The draft is kept per session and its request
// id travels with it, so a send that failed is retried as the same message.
// TODO(composer): replace with the shared composer (F10: images, references, slash
// commands, queued follow-ups) once features/composer exists; this one is text only.
import { type FormEvent, type KeyboardEvent, useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import { useFleetClient } from '../../transport/hooks'
import { mutationInvalidates } from '../../transport/resources'
import { setDraft, useDraft } from './useDay'

const requestIds = new Map<string, { text: string; id: string }>()

export function DayComposer({ sessionId, placeholder, working }: { sessionId: string; placeholder: string; working: boolean }) {
  const client = useFleetClient()
  const key = `composer:${sessionId}`
  const [text, setText] = useDraft(key)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const form = useRef<HTMLFormElement>(null)

  const send = async (event?: FormEvent) => {
    event?.preventDefault()
    const message = text.trim()
    if (!message || sending) return
    let request = requestIds.get(key)
    if (!request || request.text !== message) {
      request = { text: message, id: crypto.randomUUID() }
      requestIds.set(key, request)
    }
    setSending(true)
    setError(null)
    try {
      await client.post(
        `/api/managed/${encodeURIComponent(sessionId)}/messages`,
        { message, requestId: request.id },
        { invalidate: mutationInvalidates.sessionChange(sessionId) },
      )
      requestIds.delete(key)
      if (text.trim() === message) setDraft(key, null)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setSending(false)
    }
  }

  const stop = async () => {
    try {
      await client.post(`/api/managed/${encodeURIComponent(sessionId)}/stop`, {}, { invalidate: mutationInvalidates.sessionChange(sessionId) })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    form.current?.requestSubmit()
  }

  return (
    <form ref={form} className="composer day-composer" onSubmit={event => void send(event)}>
      <label className="sr-only" htmlFor={`day-message-${sessionId}`}>
        {placeholder.replace(/…$/, '')}
      </label>
      <textarea
        id={`day-message-${sessionId}`}
        rows={3}
        maxLength={16000}
        value={text}
        placeholder={placeholder}
        onChange={event => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="composer-footer">
        <span className="note">Enter to send · Shift + Enter for a new line</span>
        {working ? (
          <button type="button" className="button stop" onClick={() => void stop()}>
            <Icon name="stop" /> Stop
          </button>
        ) : null}
        <button type="submit" className="button resume" disabled={sending || !text.trim()}>
          Send <Icon name="arrow" />
        </button>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  )
}
