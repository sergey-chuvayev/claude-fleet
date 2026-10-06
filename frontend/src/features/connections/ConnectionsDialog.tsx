// The Connections dialog (F22). Opened from the top bar (modal.managedId null) or from
// a managed session's header (managedId set): check which MCP servers an agent can see,
// get a blocked one moving (sign in, reconnect), turn one on or off. Checking connects
// configured servers; it never sends an agent a message. Only the fields the page
// needs ever leave the contract parser: no command lines, environments or headers.
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { usePreference, useSelection } from '../../app/AppStore'
import type { ModalProps } from '../../app/modals'
import { MODAL_IDS } from '../../app/modals'
import { Dialog, DialogFoot, DialogHead } from '../../components/Dialog'
import { Icon } from '../../components/Icon'
import { Select } from '../../components/Select'
import { type ConnectionServer, type ConnectionResult } from '../../transport/contracts'
import { useFleetClient, useResource } from '../../transport/hooks'
import '../../styles/connections.css'
import {
  type ConnectionAction,
  SIGN_IN_TIMEOUT_MS,
  type SignInWait,
  displayName,
  useConnections,
} from './useConnections'

const LABELS: Record<string, string> = {
  connected: 'Connected',
  failed: 'Failed',
  'needs-auth': 'Needs sign-in',
  pending: 'Connecting',
  disabled: 'Disabled',
}
// What is broken first, then what works, then what could: a long tail of connectors
// never signed in to should not push the working ones off the screen.
const ORDER = ['failed', 'connected', 'pending', 'needs-auth', 'disabled'] as const
const GROUP: Record<string, string> = {
  'needs-auth': 'Needs sign-in',
  failed: 'Failed',
  pending: 'Connecting',
  connected: 'Connected',
  disabled: 'Off',
}
const KIND: Record<string, string> = { claudeai: 'Claude.ai', project: 'Project', local: 'Local', user: 'Your config' }

export function ConnectionsDialog({ modal, onClose }: ModalProps<'connections'>) {
  const client = useFleetClient()
  const launchCwd = usePreference('launchCwd')
  const sessions = useResource(client.resources.sessions).data?.sessions
  const managed = useMemo(() => (sessions ?? []).filter(s => s.managed && s.managedId), [sessions])
  // From the top bar the open session is the default target, as in the legacy dialog.
  const selected = useSelection()
  const [sessionId, setSessionId] = useState<string>(modal.managedId ?? (selected?.kind === 'managed' ? selected.managedId : ''))
  const [cwd, setCwd] = useState(launchCwd ?? '')
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const { result, busy, error, pending, focusAfter, check, act, cancelSignIn, reset } = useConnections({ sessionId, cwd })
  const results = useRef<HTMLDivElement>(null)

  // Opening with a target checks it at once, as the legacy dialog did.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on open only
  useEffect(() => {
    if (sessionId || cwd) void check()
  }, [])
  // A new target means nothing known about the old one applies.
  const onSession = (value: string) => {
    setSessionId(value)
    reset()
  }
  const onCwd = (value: string) => {
    setCwd(value)
    reset()
  }

  // After an action, keep focus on the row it was for (its button may have changed).
  useEffect(() => {
    if (!focusAfter || !results.current) return
    const buttons = [...results.current.querySelectorAll<HTMLElement>('[data-server]')].filter(b => b.dataset.server === focusAfter.name)
    const target = buttons.find(b => b.dataset.connectionAction === focusAfter.action) ?? buttons[0]
    target?.focus({ preventScroll: true })
  }, [focusAfter])

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    void check()
  }

  const options = useMemo(
    () => [
      { value: '', label: 'Project directory' },
      ...managed.map(s => ({ value: s.managedId as string, label: s.title || s.name || s.cwd || (s.managedId as string) })),
    ],
    [managed],
  )
  // A session opened from its header may not be in the list yet; keep it selectable.
  const selectable = options.some(o => o.value === sessionId) ? options : [...options, { value: sessionId, label: sessionId }]

  return (
    <Dialog
      id={MODAL_IDS.connections}
      className="modal modal-connections"
      labelledBy="connections-title"
      onClose={onClose}
      initialFocus="#connections-session"
    >
      <DialogHead
        titleId="connections-title"
        spark="⌘"
        eyebrow="TOOLS WITHIN REACH"
        title="Your connections."
        lead="Check what’s available. Get a blocked connection moving."
        closeLabel="Close connections"
      />
      <div className="modal-body">
        <form id="connections-form" className="connections-form" onSubmit={onSubmit}>
          <label>
            Check connections for
            <Select id="connections-session" label="Check connections for" value={sessionId} options={selectable} onChange={onSession} disabled={busy} />
          </label>
          {sessionId ? null : (
            <label id="connections-project">
              Project directory
              <input
                id="connections-cwd"
                maxLength={4096}
                placeholder="~/projects/my-project"
                required
                value={cwd}
                disabled={busy}
                onChange={event => onCwd(event.target.value)}
              />
            </label>
          )}
          <button className="button resume" id="connections-check" type="submit" disabled={busy}>
            {busy ? 'Checking…' : 'Check connections'}
          </button>
        </form>
        <p className="note" id="connections-context">
          {contextLine(result)}
        </p>
        {error ? (
          <p id="connections-error" className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div id="connections-results" ref={results} aria-live="polite" aria-busy={busy}>
          {result ? (
            <Servers
              result={result}
              pending={pending}
              busy={busy}
              filter={filter}
              search={search}
              onFilter={setFilter}
              onSearch={setSearch}
              onAction={(action, name) => void act(action, name)}
              onCancel={cancelSignIn}
            />
          ) : (
            <p className="connections-empty">
              {sessionId || cwd ? 'Check this project’s connections to see their status.' : 'Your configured MCP servers will appear here.'}
            </p>
          )}
        </div>
        <details className="connections-help">
          <summary>Missing a connection?</summary>
          <p>
            Sign in opens the server’s own sign-in page in your browser and Fleet picks the result up by itself. Claude.ai connectors you have
            not added yet are added in Claude’s settings; local servers are configured in Claude Code for this project.
          </p>
          <a href="https://claude.ai/settings/connectors" target="_blank" rel="noopener noreferrer">
            Open Claude connector settings <Icon name="arrow" />
          </a>
          <p>
            For a local server, open Claude Code in this project and run <code>/mcp</code> to authenticate or approve its configuration. Fleet
            does not add servers from this panel.
          </p>
        </details>
      </div>
      <DialogFoot>
        <span>Connection changes never resend a task.</span>
        <span>
          <kbd>Esc</kbd> close
        </span>
      </DialogFoot>
    </Dialog>
  )
}

function contextLine(result: ConnectionResult | null): string {
  if (!result) return 'Choose a project or session. Checking connects configured servers without sending an agent message.'
  return result.source === 'session'
    ? `Live session · ${result.cwd}. These are the servers visible to this agent now.`
    : `Project · ${result.cwd}. Changes here do not reconnect an agent that is already running.`
}

interface ServersProps {
  readonly result: ConnectionResult
  readonly pending: Readonly<Record<string, SignInWait>>
  readonly busy: boolean
  readonly filter: string
  readonly search: string
  readonly onFilter: (filter: string) => void
  readonly onSearch: (search: string) => void
  readonly onAction: (action: ConnectionAction, name: string) => void
  readonly onCancel: (name: string) => void
}

function Servers({ result, pending, busy, filter: wanted, search, onFilter, onSearch, onAction, onCancel }: ServersProps) {
  const { servers } = result
  if (!servers.length) {
    return (
      <p className="connections-empty">
        No MCP servers were reported for this project. Check the configuration or Claude connector settings below.
      </p>
    )
  }
  const counts = Object.fromEntries(ORDER.map(k => [k, servers.filter(s => s.status === k).length]))
  const filter = wanted !== 'all' && !counts[wanted] ? 'all' : wanted
  const query = search.trim().toLowerCase()
  const shown = servers.filter(s => (filter === 'all' || s.status === filter) && (!query || displayName(s).toLowerCase().includes(query)))
  const chips: Array<[string, string, number]> = [
    ['all', 'All', servers.length],
    ...ORDER.filter(k => counts[k]).map((k): [string, string, number] => [k, GROUP[k] ?? k, counts[k] ?? 0]),
  ]
  const groups = ORDER.map(k => [k, shown.filter(s => s.status === k).sort((a, b) => displayName(a).localeCompare(displayName(b)))] as const).filter(
    ([, list]) => list.length,
  )
  return (
    <>
      <div className="connections-toolbar">
        <div className="connections-filters" role="group" aria-label="Filter connections">
          {chips.map(([k, label, n]) => (
            <button key={k} type="button" className="filter" data-connection-filter={k} aria-pressed={filter === k} onClick={() => onFilter(k)}>
              {label}
              <span>{n}</span>
            </button>
          ))}
        </div>
        <input
          id="connections-search"
          type="search"
          placeholder="Find a connection"
          value={search}
          aria-label="Find a connection"
          autoComplete="off"
          onChange={event => onSearch(event.target.value)}
        />
      </div>
      <p className="connections-checked">
        {servers.filter(s => s.status === 'connected').length} of {servers.length} connected · checked{' '}
        {new Date(result.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </p>
      {groups.length ? (
        groups.map(([k, list]) => (
          <section className="connections-group" key={k}>
            <h3>
              {GROUP[k]} <span>{list.length}</span>
            </h3>
            <ul className="connections-list">
              {list.map(server => (
                <ServerRow key={server.name} server={server} wait={pending[server.name]} busy={busy} onAction={onAction} onCancel={onCancel} />
              ))}
            </ul>
          </section>
        ))
      ) : (
        <p className="connections-empty">No connection matches.</p>
      )}
    </>
  )
}

function ServerRow({
  server,
  wait,
  busy,
  onAction,
  onCancel,
}: {
  server: ConnectionServer
  wait: SignInWait | undefined
  busy: boolean
  onAction: (action: ConnectionAction, name: string) => void
  onCancel: (name: string) => void
}) {
  const name = displayName(server)
  const button = (action: ConnectionAction, label: ReactNode, text: string, primary: boolean) => (
    <button
      type="button"
      className={`button${primary ? ' resume' : ''}`}
      data-connection-action={action}
      data-server={server.name}
      aria-label={`${text} ${name}`}
      disabled={busy}
      onClick={() => onAction(action, server.name)}
    >
      {label}
    </button>
  )
  let action: ReactNode = null
  if (wait) {
    const late = Date.now() - wait.since > SIGN_IN_TIMEOUT_MS
    action = late ? (
      <>
        <span className="connection-wait">Didn’t finish?</span>
        {button('authenticate', 'Try again', 'Try again', true)}
      </>
    ) : (
      <>
        <span className="connection-wait">
          <span className="day-spinner" aria-hidden="true" />
          Waiting for you to finish signing in
        </span>
        {wait.url ? (
          <a className="button" href={wait.url} target="_blank" rel="noopener noreferrer">
            Open page again <Icon name="arrow" />
          </a>
        ) : null}
        <button type="button" className="button" data-cancel-sign-in={server.name} onClick={() => onCancel(server.name)}>
          Cancel
        </button>
      </>
    )
  } else if (server.internal) action = null
  else if (server.status === 'needs-auth')
    action =
      server.canAuthenticate === false ? (
        <span className="note">
          Run <code>/mcp</code> in Claude Code for this project to sign in.
        </span>
      ) : (
        button(
          'authenticate',
          <>
            Sign in <Icon name="arrow" />
          </>,
          'Sign in',
          false,
        )
      )
  else if (server.status === 'failed') action = button('reconnect', 'Reconnect', 'Reconnect', true)
  else if (server.status === 'disabled' && server.canToggle) action = button('enable', 'Turn on', 'Turn on', false)
  else if (server.status === 'connected' && server.canToggle) action = button('disable', 'Turn off', 'Turn off', false)

  const kind = server.internal ? 'Fleet' : (KIND[server.scope ?? ''] ?? server.scope ?? '')
  const tools = server.tools
  return (
    <li className="connection-row" data-status={wait ? 'signing-in' : server.status}>
      <span className="connection-avatar" aria-hidden="true">
        {name.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 1).toUpperCase() || '·'}
      </span>
      <div className="connection-main">
        <div className="connection-name">
          <strong>{name}</strong>
          <span className="connection-kind">{kind}</span>
        </div>
        <span className="connection-status" data-status={server.status}>
          <span aria-hidden="true">●</span> {wait ? 'Signing in' : (LABELS[server.status] ?? server.status)}
        </span>
        {server.error ? <p className="note">{server.error}</p> : null}
        {tools.length ? (
          <details className="connection-tools">
            <summary>
              {tools.length} tool{tools.length === 1 ? '' : 's'}
            </summary>
            <ul>
              {tools.map(tool => (
                <li key={tool}>
                  <code>{tool}</code>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
      <div className="connection-actions">{action}</div>
    </li>
  )
}
