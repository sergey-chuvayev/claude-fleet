// Everything a managed console draws under its conversation, as legacy control.js did
// for every managed session (agent, initiative, Day, item thread, project manager):
// the now-line, queued follow-ups, the error line, pending approvals and the full
// composer (images, @ references, / commands, Queue while it works) with Stop or
// Cancel queued task, with the composer's height divider above it (legacy app.js put
// it on whatever #composer was on screen, under one preference). The Sessions, Today
// and Projects consoles all mount this one.
import { type RefObject, useRef } from 'react'
import { COMPOSER_MIN } from '../../app/preferences'
import { PanelSplitter } from '../../components/SplitPane'
import { type ManagedDetail, readControlFields } from '../../transport/contracts'
import { Approvals } from '../approvals/Approvals'
import { Composer } from '../composer/Composer'
import { isWorking } from '../conversation/format'
import { AgentError, QueuedMessages } from './ConsoleStatus'
import { NowLine } from './NowLine'
import { managedNow } from './status'
import { StopButton } from './StopButton'

export interface SessionTailProps {
  readonly session: ManagedDetail['session']
  /** The draft key: the session list's key for this conversation (`managed:<id>`). */
  readonly draftKey: string
  readonly placeholder: string
  /** A refresh that could not reach Fleet, shown on the error line. */
  readonly refreshError?: string | undefined
}

/** The composer's divider: 110px minimum, 130 by default, a floor rather than a fixed height. */
const COMPOSER_INITIAL = 130

/**
 * The largest a panel may be: under half the control panel, and never so tall that
 * the conversation drops below 120px (legacy watchConversation's `maximum`).
 */
export function panelMax(panel: RefObject<HTMLElement | null>, min: number): () => number {
  return () => {
    const element = panel.current
    const container = element?.parentElement
    if (!element || !container) return min
    const log = container.querySelector<HTMLElement>('.conversation')
    const height = element.getBoundingClientRect().height
    return Math.max(min, Math.min(container.clientHeight * 0.45, height + (log?.clientHeight ?? 0) - 120))
  }
}

export function SessionTail({ session, draftKey, placeholder, refreshError = '' }: SessionTailProps) {
  const composer = useRef<HTMLFormElement>(null)
  const fields = readControlFields(session)
  const holder = fields.openElsewhere ?? null
  return (
    <>
      <NowLine now={managedNow(session.status, session.messages, !!holder)} />
      <QueuedMessages queue={fields.queue ?? []} />
      <AgentError text={session.error || refreshError} />
      <Approvals managedId={session.id} approvals={fields.approvals ?? []} />
      <PanelSplitter
        panelRef={composer}
        preference="composerHeight"
        label="Resize message composer"
        min={COMPOSER_MIN}
        initial={COMPOSER_INITIAL}
        max={panelMax(composer, COMPOSER_MIN)}
        before
        grow
      />
      <Composer
        managedId={session.id}
        draftKey={draftKey}
        transcriptId={session.sessionId ?? null}
        engine={session.engine === 'codex' ? 'codex' : 'claude'}
        working={isWorking(session.status)}
        holder={holder}
        placeholder={placeholder}
        stop={<StopButton managedId={session.id} status={session.status} />}
        formRef={composer}
      />
    </>
  )
}
