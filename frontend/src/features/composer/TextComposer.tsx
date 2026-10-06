// A text-only composer over the shared draft store, for routes that take a message
// and a request id but no images or references: a Day or item thread, a project's
// manager (POST /api/projects/:id/ask). Enter sends, Shift+Enter breaks the line,
// never during IME composition.
//
// Same draft semantics as the full composer (drafts.ts, A07): the text lives under
// `draftKey`, so it survives switching; a send takes a snapshot of revision and
// request id; only an accepted answer for that revision clears it (text typed while
// the request was out stays); a failure keeps the draft and its request id, so a
// deliberate retry of the same words is deduplicated by the server.
import type { FormEvent, KeyboardEvent, ReactNode } from 'react'
import { Icon } from '../../components/Icon'
import { failureText } from '../session-header/mutations'
import { type SendSnapshot, useDraft, useDraftStore } from './drafts'

export interface TextComposerProps {
  /** The draft store key. */
  readonly draftKey: string
  /** The textarea's id (its label points at it). */
  readonly inputId: string
  /** The textarea's accessible name. */
  readonly label: string
  readonly placeholder: string
  /** Extra classes beside `composer`. */
  readonly className?: string | undefined
  /** Deliver the message; the snapshot's requestId goes with it. Throw to keep the draft. */
  readonly send: (message: string, snapshot: SendSnapshot) => Promise<unknown>
  /** Said when Send is pressed with nothing typed; silent when absent. */
  readonly onEmpty?: (() => void) | undefined
  /** The Stop button, drawn in the footer before Send. */
  readonly stop?: ReactNode
  readonly hint?: string | undefined
}

export function TextComposer({ draftKey, inputId, label, placeholder, className, send, onEmpty, stop, hint }: TextComposerProps) {
  const store = useDraftStore()
  const draft = useDraft(draftKey)
  const sending = !!draft.sending

  const deliver = async () => {
    const current = store.get(draftKey)
    if (current.sending) return
    if (!current.text.trim()) {
      onEmpty?.()
      return
    }
    const snapshot = store.begin(draftKey)
    if (!snapshot) return
    try {
      await send(snapshot.text.trim(), snapshot)
      store.accepted(draftKey, snapshot)
    } catch (error) {
      store.failed(draftKey, snapshot, failureText(error))
    }
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void deliver()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key !== 'Enter' || event.shiftKey) return
    event.preventDefault()
    if (!sending) void deliver()
  }

  return (
    <form className={`composer${className ? ` ${className}` : ''}`} onSubmit={submit} aria-busy={sending || undefined}>
      <label className="sr-only" htmlFor={inputId}>
        {label}
      </label>
      <textarea
        id={inputId}
        rows={3}
        maxLength={16000}
        value={draft.text}
        placeholder={placeholder}
        onChange={event => store.edit(draftKey, { text: event.target.value })}
        onKeyDown={onKeyDown}
      />
      <div className="composer-footer">
        <span className="note">{hint ?? 'Enter to send · Shift + Enter for a new line'}</span>
        {stop}
        <button type="submit" className="button resume" disabled={sending}>
          Send <Icon name="arrow" />
        </button>
      </div>
      <p className="form-error" role="alert" hidden={!draft.error}>
        {draft.error}
      </p>
    </form>
  )
}
