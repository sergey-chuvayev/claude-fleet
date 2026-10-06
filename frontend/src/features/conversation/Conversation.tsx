// The conversation pane's log: a managed session's messages, or an external
// (terminal) session's transcript, with read position and the pinned question. It
// owns no app state: it reads the client and store through hooks, nothing else.
//
//   <Conversation sessionKey={sessionKey(row)} onNotice={toast} />
//
// `sessionKey` is the list's key (domain/ids sessionKey): `managed:<id>` for a Fleet
// session, `claude:<transcriptId>` or `codex:<transcriptId>` for an external one.
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { engineOf } from '../../domain/ids'
import type { Engine, Message } from '../../transport/contracts'
import { keys } from '../../transport/resources'
import { useFleetClient, useResource } from '../../transport/hooks'
import { agentLabel, isWorking } from './format'
import { MessageList, windowOf } from './MessageList'
import { QuestionPin } from './QuestionPin'
import { positionMemory, useReadPosition } from './readPosition'
import '../../styles/conversation.css'

export type ConversationTarget =
  | { readonly kind: 'managed'; readonly id: string }
  | { readonly kind: 'external'; readonly engine: Engine; readonly id: string }

/** What a session key points at, or null for one without a conversation (a bare pid). */
export function conversationTarget(sessionKey: string): ConversationTarget | null {
  const split = sessionKey.indexOf(':')
  if (split < 1) return null
  const prefix = sessionKey.slice(0, split)
  const id = sessionKey.slice(split + 1)
  if (!id) return null
  if (prefix === 'managed') return { kind: 'managed', id }
  if (prefix === 'claude' || prefix === 'codex') return { kind: 'external', engine: prefix, id }
  return null
}

export interface ConversationProps {
  /** The session list's key for the row (see domain/ids sessionKey). */
  readonly sessionKey: string
  /** The app's toast, for copy feedback. Optional; the copy button also says it itself. */
  readonly onNotice?: (text: string) => void
  /**
   * Derive what is shown from the stored messages (the Day's grouped board calls).
   * Must be a stable function; it runs only when the messages change.
   */
  readonly present?: (messages: readonly Message[]) => readonly Message[]
}

export function Conversation({ sessionKey, onNotice, present }: ConversationProps) {
  const target = conversationTarget(sessionKey)
  // A stable callback, so a new toast function from the parent never re-renders blocks.
  const latest = useRef(onNotice)
  latest.current = onNotice
  const notice = useCallback((text: string) => latest.current?.(text), [])
  if (!target) {
    return (
      <div className="conversation-frame">
        <div className="conversation" role="log" aria-live="off">
          <p className="note">This session has no saved conversation to show yet.</p>
        </div>
      </div>
    )
  }
  // Keyed by session: switching remounts, so nothing (disclosures, collapse, the pin)
  // carries over from one conversation to another; read position is restored from memory.
  return target.kind === 'managed' ? (
    <ManagedConversation key={sessionKey} sessionKey={sessionKey} id={target.id} onNotice={notice} present={present} />
  ) : (
    <ExternalConversation
      key={sessionKey}
      sessionKey={sessionKey}
      engine={target.engine}
      id={target.id}
      onNotice={notice}
      present={present}
    />
  )
}

interface ViewProps {
  readonly sessionKey: string
  readonly onNotice: (text: string) => void
  readonly present: ((messages: readonly Message[]) => readonly Message[]) | undefined
}

/** Safety refresh of an open managed session, on top of the event stream (plan section 7). */
const ACTIVE_REFRESH_MS = 2500
const IDLE_REFRESH_MS = 30_000

function ManagedConversation({ sessionKey, id, onNotice, present }: ViewProps & { readonly id: string }) {
  const client = useFleetClient()
  const resource = client.resources.managed(id)
  const state = useResource(resource)
  const session = state.data?.session
  const status = session?.status

  useEffect(() => {
    const active = isWorking(status) || status === 'queued'
    const timer = setInterval(
      () => {
        if (typeof document === 'undefined' || document.visibilityState !== 'hidden') client.store.invalidate(resource.key)
      },
      active ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS,
    )
    return () => clearInterval(timer)
  }, [client, resource, status])

  const messages = useMemo(() => (session ? (present ? present(session.messages) : session.messages) : undefined), [session?.messages, present])
  const last = messages?.[messages.length - 1]
  const streamingId = isWorking(status) && last?.role === 'assistant' ? last.id : null

  let note: string | null = null
  if (!messages) note = state.error ? state.error.message : 'Loading conversation…'
  else if (!messages.length) note = 'Send your first instruction below.'

  return (
    <ConversationLog
      sessionKey={sessionKey}
      label="Agent conversation"
      messages={messages}
      streamingId={streamingId}
      agent={agentLabel(session?.engine)}
      note={note}
      earlier={false}
      onNotice={onNotice}
    />
  )
}

/**
 * The list row's change marker for an external session. The transcript is read again
 * only when the session has moved, as the legacy console does.
 */
function useExternalMark(engine: Engine, transcriptId: string): string | null {
  const client = useFleetClient()
  const resource = client.resources.sessions
  const subscribe = useCallback((onChange: () => void) => client.store.subscribe(resource, onChange), [client, resource])
  const read = useCallback(() => {
    const row = client.store
      .get(resource)
      .data?.sessions.find(s => s.sessionId === transcriptId && engineOf(s) === engine)
    return row ? `${row.lastActivity ?? ''}:${row.alive ?? ''}` : null
  }, [client, resource, engine, transcriptId])
  return useSyncExternalStore(subscribe, read, read)
}

function ExternalConversation({ sessionKey, engine, id, onNotice, present }: ViewProps & { readonly engine: Engine; readonly id: string }) {
  const client = useFleetClient()
  const resource = client.resources.history(engine, id)
  const state = useResource(resource)
  const mark = useExternalMark(engine, id)
  const seenMark = useRef(mark)
  useEffect(() => {
    if (mark !== null && seenMark.current !== null && mark !== seenMark.current) client.store.invalidate(keys.history(engine, id))
    seenMark.current = mark
  }, [client, mark, engine, id])

  const history = state.data
  const messages = useMemo(() => (history ? (present ? present(history.messages) : history.messages) : undefined), [history?.messages, present])

  let note: string | null = null
  if (!messages) note = state.error ? state.error.message : 'Loading the conversation…'
  else if (!messages.length) note = 'No messages in this conversation yet.'

  return (
    <ConversationLog
      sessionKey={sessionKey}
      label="Conversation from the terminal"
      messages={messages}
      streamingId={null}
      agent={agentLabel(engine)}
      note={note}
      earlier={!!history?.truncated}
      onNotice={onNotice}
    />
  )
}

const EMPTY: readonly Message[] = []

function ConversationLog({
  sessionKey,
  label,
  messages,
  streamingId,
  agent,
  note,
  earlier,
  onNotice,
}: {
  sessionKey: string
  label: string
  messages: readonly Message[] | undefined
  streamingId: string | null
  agent: string
  note: string | null
  earlier: boolean
  onNotice: (text: string) => void
}) {
  const client = useFleetClient()
  const log = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const shown = useMemo(() => (messages ? windowOf(messages) : EMPTY), [messages])
  useReadPosition(log, content, sessionKey, positionMemory(client), shown)

  return (
    <div className="conversation-frame">
      <QuestionPin log={log} messages={shown} />
      <div ref={log} className="conversation" role="log" aria-label={label} aria-live="off" data-session={sessionKey}>
        <div ref={content} className="conversation-content">
          {earlier ? <p className="note outside-earlier">Earlier messages are in the transcript; this shows the most recent part.</p> : null}
          {note ? <p className="note">{note}</p> : null}
          {shown.length ? <MessageList messages={shown} streamingId={streamingId} agent={agent} onNotice={onNotice} /> : null}
        </div>
      </div>
    </div>
  )
}
