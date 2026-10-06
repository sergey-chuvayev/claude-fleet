// A session started outside Fleet (a terminal, or Codex) opens in the same console as
// a Fleet one (F08): its transcript, what it is doing now, and a composer that
// continues it here. A stopped conversation is taken over; a Claude one still open in
// its terminal is continued as a copy, since two programs writing one conversation
// would corrupt it; a live Codex session is refused until it finishes (the server
// answers UNSUPPORTED_ENGINE too), and the typed draft is kept for then.
import { type FormEvent, type KeyboardEvent, useLayoutEffect, useMemo, useRef } from 'react'
import { useActions } from '../../app/AppStore'
import { type Selection, selectionKey } from '../../app/state'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { type ManagedId, engineOf, sessionLabel } from '../../domain/ids'
import { type SessionSummary, parseSessionAnswer } from '../../transport/contracts'
import { keys } from '../../transport/resources'
import { useFleetClient, useResource } from '../../transport/hooks'
import { Conversation } from '../conversation'
import { toolLabel } from '../conversation/format'
import { useDraft, useDraftStore } from '../composer/drafts'
import { failureText } from '../session-header/mutations'
import { NowLine } from '../session-header/NowLine'
import type { NowState } from '../session-header/status'
import { type ExternalRow, buttonText, continueBody, continueMode, hintText, placeholderText, stateText, successText } from './actions'

export interface ExternalConsoleProps {
  readonly selection: Extract<Selection, { kind: 'external' }>
}

interface Turn {
  readonly current?: { readonly t?: string; readonly target?: string | null; readonly at?: number | null } | null
  readonly turnStartedAt?: number | null
}

const turnOf = (row: SessionSummary | undefined): Turn | null => {
  const turn = (row as { turn?: unknown } | undefined)?.turn
  return turn && typeof turn === 'object' ? (turn as Turn) : null
}

function findRow(rows: readonly SessionSummary[] | undefined, selection: ExternalConsoleProps['selection']): SessionSummary | undefined {
  if (!rows) return undefined
  if (selection.transcriptId) return rows.find(s => !s.managedId && s.sessionId === selection.transcriptId && engineOf(s) === selection.engine)
  return rows.find(s => !s.managedId && !s.sessionId && s.pid === selection.pid)
}

export function ExternalConsole({ selection }: ExternalConsoleProps) {
  const client = useFleetClient()
  const toast = useToast()
  const snapshot = useResource(client.resources.sessions)
  const summary = findRow(snapshot.data?.sessions, selection)
  const key = selectionKey(selection)
  const row: ExternalRow = useMemo(
    () => ({
      engine: selection.engine,
      transcriptId: selection.transcriptId,
      cwd: summary?.cwd ?? null,
      alive: !!summary?.alive,
      busy: summary?.state === 'busy',
      title: summary ? sessionLabel(summary) : 'Untitled session',
    }),
    [selection, summary],
  )
  const turn = turnOf(summary)
  const step = row.busy ? turn?.current : null
  const now: NowState | null = step
    ? { text: `Running ${toolLabel(step.t)}${step.target ? ` · ${step.target}` : ''}`, since: step.at ?? turn?.turnStartedAt ?? null, tone: '' }
    : row.busy
      ? { text: row.engine === 'codex' ? 'Working in Codex' : 'Working in the terminal', since: turn?.turnStartedAt ?? null, tone: '' }
      : null

  return (
    <>
      <div className="conversation-header" id="outside-console">
        <div className="header-title">
          <h3>{row.title}</h3>
          <span id="outside-state" className="subtle">
            {summary ? stateText(row) : ''}
          </span>
        </div>
      </div>
      <Conversation sessionKey={key} onNotice={toast} />
      <NowLine now={now} />
      <ExternalComposer draftKey={key} row={row} known={!!summary} />
    </>
  )
}

function ExternalComposer({ draftKey, row, known }: { draftKey: string; row: ExternalRow; known: boolean }) {
  const client = useFleetClient()
  const toast = useToast()
  const { select } = useActions()
  const store = useDraftStore()
  const draft = useDraft(draftKey)
  const box = useRef<HTMLTextAreaElement>(null)
  const mode = continueMode(row)
  const blocked = mode === 'refused' || mode === 'unavailable'
  const sending = !!draft.sending

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [draft.text])

  const send = async () => {
    const current = store.get(draftKey)
    if (blocked || current.sending || !current.text.trim()) return
    const snap = store.begin(draftKey)
    if (!snap) return
    try {
      const raw = await client.post('/api/managed', continueBody(row, snap.text.trim(), snap.requestId), { invalidate: [keys.sessions] })
      store.accepted(draftKey, snap)
      const detail = parseSessionAnswer(raw)
      if (detail) {
        client.store.set(client.resources.managed(detail.session.id), detail)
        select({ kind: 'managed', managedId: detail.session.id as ManagedId }, { reveal: true })
      }
      toast(successText(row))
    } catch (error) {
      // The server refuses a live Codex session (UNSUPPORTED_ENGINE) in its own words;
      // the draft stays for when it finishes.
      store.failed(draftKey, snap, failureText(error))
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return
    event.preventDefault()
    if (!sending && !blocked) void send()
  }

  return (
    <form
      id="composer"
      className="composer outside-composer"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        void send()
      }}
    >
      <label className="sr-only" htmlFor="message-input">
        Continue this conversation
      </label>
      <textarea
        ref={box}
        id="message-input"
        rows={3}
        maxLength={16000}
        disabled={blocked}
        placeholder={placeholderText(row)}
        value={draft.text}
        onChange={event => store.edit(draftKey, { text: event.currentTarget.value })}
        onKeyDown={onKeyDown}
      />
      <div className="composer-footer">
        <span id="composer-hint" className="note">
          {known ? hintText(row) : ''}
        </span>
        <button id="send-message" className="button resume" type="submit" disabled={blocked || sending}>
          {buttonText(row)} <Icon name="arrow" />
        </button>
      </div>
      <p id="send-error" className="form-error" role="alert" hidden={!draft.error}>
        {draft.error}
      </p>
    </form>
  )
}
