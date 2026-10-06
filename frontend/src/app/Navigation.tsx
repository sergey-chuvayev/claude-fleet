// The top bar (F01): the Fleet wordmark and version, the view tabs, and the actions
// on the right (update slot, Settings, Connections, refresh, Search, New agent, the
// inspector toggle). Markup and ids are the legacy ones.
import { useState } from 'react'
import { Icon, PanelIcon } from '../components/Icon'
import { useNow } from '../components/clock'
import { UpdateStatus } from '../features/status/UpdateStatus'
import { useFleetClient, useResource } from '../transport/hooks'
import { useActions, useModal, useView } from './AppStore'
import { useInspector } from './inspector'
import { MODAL_IDS } from './modals'
import { shortcutLabel } from './shortcuts'
import type { ModalKind } from './state'
import { VIEW_DEFINITIONS, VIEW_ORDER } from './views'

const localDate = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

interface DayProgress {
  readonly waiting?: number
  readonly proposed?: number
}

/** Today's badge: what waits on you, else what is left to triage, on today's Day. */
function TodayCount() {
  const client = useFleetClient()
  const sessions = useResource(client.resources.sessions)
  const today = localDate(useNow(60_000))
  const day = sessions.data?.sessions.find(row => row.kind === 'day' && row.dayDate === today && !row.archived)
  const progress = (day?.dayProgress ?? null) as DayProgress | null
  const waiting = progress?.waiting || 0
  const proposed = progress?.proposed || 0
  return (
    <span
      id="today-count"
      data-alert={String(!!waiting)}
      title={waiting ? `${waiting} waiting on you` : proposed ? `${proposed} to triage` : undefined}
    >
      {waiting || proposed || ''}
    </span>
  )
}

export function Navigation() {
  const client = useFleetClient()
  const control = useResource(client.resources.control)
  const view = useView()
  const modal = useModal()
  const actions = useActions()
  const inspector = useInspector()
  const [refreshing, setRefreshing] = useState(false)

  const toggle = (kind: ModalKind) => () => {
    if (modal?.kind === kind) actions.closeModal(kind)
    else if (kind === 'connections') actions.openModal({ kind, managedId: null })
    else if (kind === 'launch' || kind === 'search' || kind === 'settings') actions.openModal({ kind })
  }
  const expanded = (kind: ModalKind) => modal?.kind === kind

  const refresh = async () => {
    setRefreshing(true)
    try {
      await client.store.refresh(client.resources.sessions)
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <header className="topbar">
      <a className="brand" href="/" aria-label="Fleet home">
        <span className="brandmark">✳</span> fleet <span className="brand-sub">Your agents, together.</span>
      </a>
      <nav className="work-tabs" aria-label="Fleet view">
        {VIEW_ORDER.map(id => {
          const definition = VIEW_DEFINITIONS[id]
          return (
            <button
              key={id}
              type="button"
              className="button"
              id={`view-${id}`}
              aria-pressed={view === id}
              title={definition.title}
              onClick={() => actions.navigate(id)}
            >
              {definition.label}
              {id === 'today' ? (
                <>
                  {' '}
                  <TodayCount />
                </>
              ) : null}
            </button>
          )
        })}
      </nav>
      <span className="app-version" id="app-version" title="The version of Fleet this server is running">
        {control.data ? `v${control.data.version}` : ''}
      </span>
      <div className="refresh-info">
        <UpdateStatus />
        <button
          type="button"
          id="open-settings"
          className="button"
          aria-expanded={expanded('settings')}
          aria-controls={MODAL_IDS.settings}
          onClick={toggle('settings')}
        >
          Settings
        </button>
        <button
          type="button"
          id="open-connections"
          className="button"
          aria-expanded={expanded('connections')}
          aria-controls={MODAL_IDS.connections}
          onClick={toggle('connections')}
        >
          Connections
        </button>
        <button
          type="button"
          id="refresh"
          className="button"
          aria-label="Refresh sessions"
          title="Refresh sessions"
          disabled={refreshing}
          onClick={refresh}
        >
          <Icon name="refresh" />
        </button>
        <button
          type="button"
          id="ask-sessions"
          className="button"
          aria-expanded={expanded('search')}
          aria-controls={MODAL_IDS.search}
          title="Ask a question across every session on this machine"
          onClick={toggle('search')}
        >
          <Icon name="search" /> Search <kbd id="ask-shortcut">{shortcutLabel('K')}</kbd>
        </button>
        <button
          type="button"
          id="new-session"
          className="button resume"
          aria-expanded={expanded('launch')}
          aria-controls={MODAL_IDS.launch}
          title="Start a new agent (⌘N)"
          onClick={() => actions.openModal({ kind: 'launch' })}
        >
          <Icon name="plus" /> New agent
        </button>
        <button
          type="button"
          id="details-toggle"
          className="button details-toggle"
          aria-expanded={inspector.open}
          aria-controls="detail-content"
          title="Toggle session details"
          hidden={!inspector.available}
          onClick={() => actions.setInspector(!inspector.open)}
        >
          <PanelIcon />
          <span className="sr-only">Session details</span>
        </button>
      </div>
    </header>
  )
}
