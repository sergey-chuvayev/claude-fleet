// Everything a managed console draws under its conversation, as legacy control.js did
// for every managed session (agent, initiative, Day, item thread, project manager):
// the now-line, queued follow-ups, the error line, pending approvals and the full
// composer (images, @ references, / commands, Queue while it works) with Stop or
// Cancel queued task. The Sessions, Today and Projects consoles all mount this one.
import type { ReactNode, RefObject } from 'react'
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
  /** Drawn between the approvals and the composer (the Sessions console's divider). */
  readonly divider?: ReactNode
  readonly formRef?: RefObject<HTMLFormElement | null>
}

export function SessionTail({ session, draftKey, placeholder, refreshError = '', divider, formRef }: SessionTailProps) {
  const fields = readControlFields(session)
  const holder = fields.openElsewhere ?? null
  return (
    <>
      <NowLine now={managedNow(session.status, session.messages, !!holder)} />
      <QueuedMessages queue={fields.queue ?? []} />
      <AgentError text={session.error || refreshError} />
      <Approvals managedId={session.id} approvals={fields.approvals ?? []} />
      {divider}
      <Composer
        managedId={session.id}
        draftKey={draftKey}
        transcriptId={session.sessionId ?? null}
        engine={session.engine === 'codex' ? 'codex' : 'claude'}
        working={isWorking(session.status)}
        holder={holder}
        placeholder={placeholder}
        stop={<StopButton managedId={session.id} status={session.status} />}
        {...(formRef ? { formRef } : {})}
      />
    </>
  )
}
