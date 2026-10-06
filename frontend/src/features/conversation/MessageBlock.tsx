// One conversation record as a block: a header with who/what, time and actions, and a
// body. Ported from blockHtml in public/blocks.js. Memoized on the message object:
// the transport hands back the same object for an unchanged message, so a streaming
// reply re-renders its own block and nothing else.
import { memo, useRef, useState } from 'react'
import { Markdown } from '../../components/markdown/Markdown'
import type { Attachment, Message, MessageReference } from '../../transport/contracts'
import { ICONS, clock, copyText, duration, isDelegation, startsCollapsed, toolLabel, toolState } from './format'
import { useRenderProbe } from './probe'
import { CopyButton, Disclosure, PixelRun, useSeen } from './primitives'
import { ToolBody, ToolResult } from './ToolBody'

export interface MessageBlockProps {
  readonly message: Message
  /** This is the reply being written right now. */
  readonly streaming: boolean
  /** Who replies: CLAUDE or CODEX. */
  readonly agent: string
  readonly onNotice?: ((text: string) => void) | undefined
}

// Only ids the server itself generates (a UUID and an image extension) become URLs.
const ATTACHMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/
export const attachmentUrl = (id: string): string | null => (ATTACHMENT_ID.test(id) ? `/api/attachments/${id}` : null)

function Attachments({ attachments }: { attachments: readonly Attachment[] }) {
  return (
    <div className="block-attachments">
      {attachments.map(attachment => {
        const url = attachmentUrl(attachment.id)
        const title = `${attachment.mediaType ?? 'image'} · ${Math.round((attachment.bytes ?? 0) / 1024)} KB`
        if (!url) {
          return (
            <span key={attachment.id} className="block-note" title={title}>
              Attachment unavailable
            </span>
          )
        }
        return (
          <a key={attachment.id} href={url} target="_blank" rel="noreferrer noopener" title={title}>
            <img src={url} alt="Attached image" loading="lazy" />
          </a>
        )
      })}
    </div>
  )
}

/** A referenced session as it was when the message was sent. Display only. */
function Reference({ reference }: { reference: MessageReference }) {
  return (
    <Disclosure
      className="block-reference"
      summary={
        <>
          ✳ {reference.title ?? 'Session'} <span>· session snapshot</span>
        </>
      }
    >
      <p>
        {reference.project ?? ''} · {reference.state ?? ''}
      </p>
      <pre>{reference.context ?? ''}</pre>
    </Disclosure>
  )
}

function Actions({ message, collapsed, onCollapse, onNotice }: {
  message: Message
  collapsed: boolean
  onCollapse: () => void
  onNotice?: ((text: string) => void) | undefined
}) {
  return (
    <span className="block-actions">
      <CopyButton value={() => copyText(message)} onNotice={onNotice} />
      <button
        type="button"
        className="block-button"
        data-collapse=""
        title={collapsed ? 'Expand block' : 'Collapse block'}
        aria-label={collapsed ? 'Expand block' : 'Collapse block'}
        aria-expanded={!collapsed}
        onClick={onCollapse}
      >
        ⌄
      </button>
    </span>
  )
}

function ToolHead({ message }: { message: Message }) {
  const state = toolState(message.status)
  const delegation = isDelegation(message.tool)
  const stateLabel = state === 'is-done' ? (delegation ? 'done' : '') : state.slice(3)
  const meta = [duration(message.ms), clock(message.at)].filter(Boolean).join(' · ')
  const subagent = typeof message.input?.subagent_type === 'string' && message.input.subagent_type ? message.input.subagent_type : 'subagent'
  return (
    <>
      {state === 'is-running' ? (
        // A step that is running right now wears the pixel mark instead of its icon.
        <span className="block-icon is-live">
          <PixelRun label="Running now" />
        </span>
      ) : (
        <span className="block-icon" aria-hidden="true">
          {ICONS[message.tool ?? ''] ?? '▸'}
        </span>
      )}
      <span className="block-tool" title={message.tool ?? ''}>
        {delegation ? `Delegation · ${subagent}` : message.label || toolLabel(message.tool)}
      </span>
      {message.target ? (
        <span className="block-target" title={message.target}>
          {message.target}
        </span>
      ) : null}
      <span className="block-meta">{meta}</span>
      {message.approval === 'auto' ? (
        <span className="block-auto" title="Fleet approved this automatically">
          auto
        </span>
      ) : null}
      <span className={`block-state ${state}`}>{stateLabel}</span>
    </>
  )
}

const KNOWN_ROLES = new Set(['user', 'assistant', 'tool'])

export const MessageBlock = memo(function MessageBlock({ message, streaming, agent, onNotice }: MessageBlockProps) {
  useRenderProbe(message.id)
  const [collapsed, setCollapsed] = useState(() => startsCollapsed(message))
  const body = useRef<HTMLDivElement>(null)
  // Fenced code is highlighted once the reply is final and the block is near the screen.
  const seen = useSeen(body, !streaming && !collapsed)
  const toggle = () => setCollapsed(value => !value)

  // A run that started on its own (an intake, a check, picking up answers): a marker in
  // the timeline, not a message the operator typed.
  if (message.role === 'event') {
    return (
      <article className="block" data-block={message.id} data-role="event">
        <div className="block-event">
          <span>{message.text ?? ''}</span>
          <span className="block-meta">{clock(message.at)}</span>
        </div>
      </article>
    )
  }

  const className = collapsed ? 'block collapsed' : 'block'
  const actions = <Actions message={message} collapsed={collapsed} onCollapse={toggle} onNotice={onNotice} />

  if (message.role === 'tool') {
    return (
      <article className={className} data-block={message.id} data-role="tool" data-tool={message.tool ?? ''} data-status={message.status ?? ''}>
        <div className="block-head">
          <ToolHead message={message} />
          {actions}
        </div>
        {collapsed ? null : (
          <div className="block-body" ref={body}>
            <ToolBody message={message} />
            <ToolResult message={message} />
          </div>
        )}
      </article>
    )
  }

  // user, assistant, and any record kind this client does not know yet (shown as text).
  const known = KNOWN_ROLES.has(message.role)
  const user = message.role === 'user'
  const who = user ? 'YOU' : known ? agent : message.role.toUpperCase()
  const attachments = message.attachments ?? []
  const references = message.references ?? []
  return (
    <article className={className} data-block={message.id} data-role={message.role} data-tool="" data-status="">
      <div className="block-head">
        <span className="block-icon" aria-hidden="true">
          {user ? '›' : known ? '✳' : '•'}
        </span>
        <span className="block-tool">{who}</span>
        <span className="block-meta">{clock(message.at)}</span>
        {streaming ? (
          <span className="block-state is-running is-live">
            <PixelRun label="Writing now" />
            writing
          </span>
        ) : null}
        {actions}
      </div>
      {collapsed ? null : (
        <div className="block-body" ref={body}>
          {references.map((reference, index) => (
            <Reference key={reference.id ?? index} reference={reference} />
          ))}
          {attachments.length ? <Attachments attachments={attachments} /> : null}
          {message.text ? (
            known ? (
              <Markdown source={message.text} highlight={!streaming && seen} />
            ) : (
              <pre className="block-plain">{message.text}</pre>
            )
          ) : null}
        </div>
      )}
    </article>
  )
})
