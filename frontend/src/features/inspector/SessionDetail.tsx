// Everything in aside#detail for the Sessions view: the control panel and, beside it,
// the inspector (features/inspector/SessionInspector) when useInspector().open says so.
//
// The control panel (#control-panel) for a managed session, top to bottom, as legacy
// control.js drew it: header, Jev routing line, team overview with its divider, the
// conversation, then the shared SessionTail: the now-line, queued follow-ups, the
// error line, approvals, the composer's divider and the composer. An external session gets its own console
// (features/external). A delegation is read only: no control panel, only its detail
// (features/agents/DelegationDetail).
import { type RefObject, useEffect, useRef, useState } from 'react'
import { useSelection } from '../../app/AppStore'
import { useInspector } from '../../app/inspector'
import { COMPOSER_MIN, OVERVIEW_MIN } from '../../app/preferences'
import { type Selection, selectionKey } from '../../app/state'
import { EmptyState } from '../../components/EmptyState'
import { PanelSplitter } from '../../components/SplitPane'
import { useToast } from '../../components/Toast'
import { type ManagedDetail, readControlFields } from '../../transport/contracts'
import { useFleetClient, useResource } from '../../transport/hooks'
import { DelegationDetail } from '../agents/DelegationDetail'
import { Conversation } from '../conversation'
import { isWorking } from '../conversation/format'
import { ExternalConsole } from '../external/ExternalConsole'
import { SessionHeader } from '../session-header/SessionHeader'
import { SessionTail } from '../session-header/SessionTail'
import { TeamOverview, overviewOf } from '../teams/TeamOverview'
import { SessionInspector } from './SessionInspector'
import '../../styles/console.css'

type SessionSelection = Extract<Selection, { kind: 'managed' | 'external' }>

export function SessionDetail() {
  const selection = useSelection('sessions')
  const inspector = useInspector()
  if (selection?.kind === 'delegation') return <DelegationDetail selection={selection} />
  if (selection && (selection.kind === 'managed' || selection.kind === 'external')) {
    const key = selectionKey(selection)
    return (
      <>
        <section id="control-panel" aria-label="Agent controls">
          {/* Keyed: switching sessions starts fresh pickers, disclosures and read position. */}
          {selection.kind === 'managed' ? <ManagedConsole key={key} managedId={selection.managedId} sessionKey={key} /> : <ExternalConsole key={key} selection={selection} />}
        </section>
        {inspector.open ? <SessionInspector selection={selection as SessionSelection} /> : null}
      </>
    )
  }
  return (
    <div id="detail-content">
      <EmptyState title="The full picture." text="Select a session to inspect it." />
    </div>
  )
}

/** The composer's divider: 110px minimum, 130 by default, a floor rather than a fixed height. */
const COMPOSER_INITIAL = 130
/** The team overview's divider: 90px minimum, 220 by default. */
const OVERVIEW_INITIAL = 220

/**
 * The largest a panel may be: under half the control panel, and never so tall that
 * the conversation drops below 120px (legacy watchConversation's `maximum`).
 */
function panelMax(panel: RefObject<HTMLElement | null>, min: number): () => number {
  return () => {
    const element = panel.current
    const container = element?.parentElement
    if (!element || !container) return min
    const log = container.querySelector<HTMLElement>('.conversation')
    const height = element.getBoundingClientRect().height
    return Math.max(min, Math.min(container.clientHeight * 0.45, height + (log?.clientHeight ?? 0) - 120))
  }
}

function ManagedConsole({ managedId, sessionKey }: { managedId: string; sessionKey: string }) {
  const client = useFleetClient()
  const toast = useToast()
  const state = useResource(client.resources.managed(managedId))
  const [closed, setClosed] = useState(false)
  const [overviewOpen, setOverviewOpen] = useState(true)
  const composer = useRef<HTMLFormElement>(null)
  const overview = useRef<HTMLDetailsElement>(null)
  const session = state.data?.session

  if (closed) {
    return <p className="note">Closed. Claude still has its own transcript of it.</p>
  }
  if (!session) {
    return (
      <>
        <div className="conversation-header">
          <div className="header-title">
            <h3 id="conversation-title">Conversation</h3>
            <span id="agent-state" className="subtle">
              Connecting…
            </span>
          </div>
        </div>
        {/* The conversation says loading or why it could not load. */}
        <Conversation sessionKey={sessionKey} onNotice={toast} />
      </>
    )
  }
  return (
    <LoadedConsole
      session={session}
      sessionKey={sessionKey}
      refreshError={state.status === 'error' ? (state.error?.message ?? '') : ''}
      composer={composer}
      overview={overview}
      overviewOpen={overviewOpen}
      setOverviewOpen={setOverviewOpen}
      onClosed={() => setClosed(true)}
    />
  )
}

function LoadedConsole({
  session,
  sessionKey,
  refreshError,
  composer,
  overview,
  overviewOpen,
  setOverviewOpen,
  onClosed,
}: {
  session: ManagedDetail['session']
  sessionKey: string
  refreshError: string
  composer: RefObject<HTMLFormElement | null>
  overview: RefObject<HTMLDetailsElement | null>
  overviewOpen: boolean
  setOverviewOpen: (open: boolean) => void
  onClosed: () => void
}) {
  const toast = useToast()
  const fields = readControlFields(session)
  const working = isWorking(session.status)
  const team = overviewOf(fields)
  const placeholder =
    fields.kind === 'project'
      ? 'Ask about this project: status, blockers, are we on track…'
      : team
        ? `Message ${team.manager}…`
        : 'Message your agent…  @ references · / commands'

  // Re-measure the dividers' limits when the overview opens or closes.
  const [, setToggled] = useState(0)
  useEffect(() => setToggled(n => n + 1), [overviewOpen])

  return (
    <>
      <SessionHeader session={session} fields={fields} onClosed={onClosed} />
      {team ? (
        <>
          <TeamOverview fields={fields} working={working} open={overviewOpen} onOpenChange={setOverviewOpen} panelRef={overview} />
          <PanelSplitter
            panelRef={overview}
            preference="overviewHeight"
            label="Resize team overview"
            min={OVERVIEW_MIN}
            initial={OVERVIEW_INITIAL}
            max={panelMax(overview, OVERVIEW_MIN)}
            collapsed={!overviewOpen}
          />
        </>
      ) : null}
      <Conversation sessionKey={sessionKey} onNotice={toast} />
      <SessionTail
        session={session}
        draftKey={sessionKey}
        placeholder={placeholder}
        refreshError={refreshError}
        formRef={composer}
        divider={
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
        }
      />
    </>
  )
}
