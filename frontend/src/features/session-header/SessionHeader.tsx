// The managed console's header (F12): the title (renamed in place for agents and
// initiatives), context share, state, and the per-session controls: model for the
// next turn, project tag, approval mode (or the Day's outward-gate note), Connections
// and a two-click Close. Then the Jev routing line when the model is Auto · Jev.
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { useActions } from '../../app/AppStore'
import { Select, type SelectOption } from '../../components/Select'
import { useToast } from '../../components/Toast'
import type { ManagedId } from '../../domain/ids'
import type { ControlFields, ManagedDetail } from '../../transport/contracts'
import { keys, mutationInvalidates, projectMutationInvalidates, projectsResource } from '../../transport/resources'
import { useFleetClient, useResource } from '../../transport/hooks'
import { isWorking } from '../conversation/format'
import { failureText, sessionCommand } from './mutations'
import { STANDARD_MODELS, modelsResource, projectChoices } from './reads'
import { APPROVAL_MODES, CODEX_SANDBOX, MODE_TOASTS, contextShare, gated, renameable, stateText, titleOf } from './status'

export interface SessionHeaderProps {
  readonly session: ManagedDetail['session']
  readonly fields: ControlFields
  /** The session was closed; the panel shows that until the selection moves on. */
  readonly onClosed: () => void
}

export function SessionHeader({ session, fields, onClosed }: SessionHeaderProps) {
  const id = session.id
  const codex = session.engine === 'codex'
  const holder = fields.openElsewhere ?? null
  const share = contextShare(fields.contextTokens, fields.contextLimit)
  const limit = fields.contextLimit || 200000
  const isGated = gated(fields.kind)
  const pm = fields.kind === 'project'
  const routing = fields.modelRouting ?? null
  const stale = session.status === 'approval' || !!holder
  return (
    <>
      <div className="conversation-header">
        <div className="header-title">
          <Title managedId={id} title={titleOf(fields)} renameable={renameable(fields.kind)} codex={codex} />
          <span
            id="agent-context"
            className={`subtle context-chip ${share === null ? '' : share >= 90 ? 'hot' : share >= 75 ? 'warn' : ''}`}
            title={share === null ? '' : `${(fields.contextTokens ?? 0).toLocaleString()} of ${limit.toLocaleString()} tokens used`}
          >
            {share === null ? '' : `${share}%`}
          </span>
          <span id="agent-state" className={`subtle ${stale ? 'stale' : ''}`}>
            {stateText({ status: session.status, kind: fields.kind, currentTool: fields.currentTool, queueLength: fields.queue?.length ?? 0, holder })}
          </span>
        </div>
        <div className="header-controls">
          {codex ? null : <ModelPicker managedId={id} selected={fields.selectedModel ?? ''} />}
          {renameable(fields.kind) ? <ProjectPicker managedId={id} projectId={fields.projectId ?? null} /> : null}
          {isGated ? (
            <span
              id="day-gate-note"
              className="subtle day-gate-note"
              title={
                pm
                  ? 'When you ask, it can change your Notion pages, Linear issues and GitHub, one approved change at a time, and logs each one in the project. It never messages people.'
                  : 'Slack messages, Linear changes and GitHub reviews go out only after you approve the exact text on the board.'
              }
            >
              {pm ? 'Changes need your approval' : 'Sends need your approval'}
            </span>
          ) : (
            <ModePicker managedId={id} mode={fields.approvalMode ?? 'auto'} codex={codex} />
          )}
          <ConnectionsButton managedId={id} />
          <CloseButton managedId={id} working={isWorking(session.status)} onClosed={onClosed} />
        </div>
      </div>
      {fields.selectedModel === 'auto-jev' ? (
        <p id="model-routing" className="model-routing note" role="status">
          {routing
            ? `Jev → ${routing.model} · Pinned for this session. ${routing.description ?? ''}${
                routing.signals && typeof routing.signals.probability === 'number'
                  ? ` Complexity: ${String(routing.signals.complexity)} (${Math.round(routing.signals.probability * 100)}% choice probability).`
                  : ''
              }`
            : 'Jev will select a model from this task’s brief. If unavailable, Fleet uses the preset.'}
        </p>
      ) : null}
    </>
  )
}

// ── Title and rename ────────────────────────────────────────────────────────

function Title({ managedId, title, renameable: canRename, codex }: { managedId: string; title: string; renameable: boolean; codex: boolean }) {
  const client = useFleetClient()
  const toast = useToast()
  const [editing, setEditing] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const done = useRef(false)

  const start = () => {
    if (!canRename || editing) return
    done.current = false
    setEditing(true)
  }
  const finish = (save: boolean, value: string) => {
    if (done.current) return
    done.current = true
    setEditing(false)
    const name = value.trim()
    if (!save || !name || name === title) return
    sessionCommand(client, managedId, 'name', { name }).catch(error => toast(failureText(error)))
  }

  if (editing) {
    return (
      <input
        id="rename-input"
        className="rename-input"
        maxLength={100}
        defaultValue={title}
        aria-label="Name this agent"
        // biome-ignore lint/a11y/noAutofocus: the operator just asked to rename; focus belongs here.
        autoFocus
        onFocus={event => event.currentTarget.select()}
        onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Enter' || event.key === 'Escape') {
            event.preventDefault()
            finish(event.key === 'Enter', event.currentTarget.value)
            requestAnimationFrame(() => heading.current?.focus())
          }
        }}
        onBlur={event => finish(true, event.currentTarget.value)}
      />
    )
  }
  return (
    <h3
      ref={heading}
      id="conversation-title"
      className={canRename ? 'is-renameable' : undefined}
      data-engine={codex ? 'codex' : ''}
      {...(canRename
        ? {
            role: 'button',
            tabIndex: 0,
            title: 'Rename this agent',
            onClick: start,
            onKeyDown: (event: KeyboardEvent<HTMLHeadingElement>) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                start()
              }
            },
          }
        : {})}
    >
      {title}
    </h3>
  )
}

// ── Pickers ─────────────────────────────────────────────────────────────────

/** A select whose shown value is the operator's pick while the change is on its way. */
function usePending<T>(server: T): [T, (value: T | null) => void] {
  const [pending, setPending] = useState<T | null>(null)
  return [pending ?? server, setPending]
}

function ModelPicker({ managedId, selected }: { managedId: string; selected: string }) {
  const client = useFleetClient()
  const toast = useToast()
  const models = useResource(modelsResource(client))
  const [value, setPending] = usePending(selected)
  const list = models.data?.models ?? STANDARD_MODELS
  const options: SelectOption[] = list.map(m => ({ value: m.value, label: m.displayName || m.value || 'Default', description: m.description ?? undefined }))
  if (!options.some(o => o.value === value)) options.push({ value, label: value || 'Default' })
  const change = (model: string) => {
    if (model === value) return
    setPending(model)
    const label = options.find(o => o.value === model)?.label ?? model
    sessionCommand(client, managedId, 'model', { model })
      .then(() => toast(model ? `Next message uses ${label}` : 'Back to the project default'))
      .catch(error => toast(failureText(error)))
      .finally(() => setPending(null))
  }
  return (
    <label className="mode-picker">
      <span className="sr-only">Model for this agent</span>
      <Select id="model-choice" label="Model for this agent" title="Applies from your next message" value={value} options={options} onChange={change} />
    </label>
  )
}

function ModePicker({ managedId, mode, codex }: { managedId: string; mode: string; codex: boolean }) {
  const client = useFleetClient()
  const toast = useToast()
  const [value, setPending] = usePending(mode)
  const change = (next: string) => {
    if (next === value) return
    setPending(next)
    sessionCommand(client, managedId, 'mode', { mode: next })
      .then(() => toast(MODE_TOASTS[next] ?? 'Approvals changed'))
      .catch(error => toast(failureText(error)))
      .finally(() => setPending(null))
  }
  return (
    <label className="mode-picker" data-mode={value}>
      <span className="sr-only">Approvals for this agent</span>
      <Select
        id="approval-mode"
        label="Approvals for this agent"
        title={codex ? (CODEX_SANDBOX[value] ?? CODEX_SANDBOX.auto) : undefined}
        value={value}
        options={APPROVAL_MODES.map(m => ({ value: m.value, label: m.label, description: m.description }))}
        onChange={change}
      />
    </label>
  )
}

/** An agent or initiative can belong to one of the operator's projects. */
function ProjectPicker({ managedId, projectId }: { managedId: string; projectId: string | null }) {
  const client = useFleetClient()
  const toast = useToast()
  const projects = useResource(projectsResource)
  const [value, setPending] = usePending(projectId ?? '')
  const choices = projectChoices(projects.data)
  if (!choices.length && !projectId) return null
  const options: SelectOption[] = [{ value: '', label: 'No project' }, ...choices.map(p => ({ value: p.id, label: p.name }))]
  if (!options.some(o => o.value === value)) options.push({ value, label: value })
  const change = (next: string) => {
    if (next === value) return
    setPending(next)
    sessionCommand(client, managedId, 'project', { projectId: next || null }, { also: projectMutationInvalidates() })
      .then(() => toast(next ? 'Added to the project' : 'Removed from the project'))
      .catch(error => toast(failureText(error)))
      .finally(() => setPending(null))
  }
  return (
    <label className="mode-picker">
      <span className="sr-only">Project</span>
      <Select id="project-choice" label="Project" title="Which of your projects this work belongs to" value={value} options={options} onChange={change} />
    </label>
  )
}

// ── Buttons ─────────────────────────────────────────────────────────────────

function ConnectionsButton({ managedId }: { managedId: string }) {
  const { openModal } = useActions()
  return (
    <button type="button" id="agent-connections" className="button" onClick={() => openModal({ kind: 'connections', managedId: managedId as ManagedId })}>
      Connections
    </button>
  )
}

/** Close removes the conversation from Fleet; the first click only arms it for four seconds. */
function CloseButton({ managedId, working, onClosed }: { managedId: string; working: boolean; onClosed: () => void }) {
  const client = useFleetClient()
  const toast = useToast()
  const [state, setState] = useState<'idle' | 'armed' | 'closing'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )
  const click = () => {
    if (state === 'closing') return
    if (state === 'idle') {
      setState('armed')
      timer.current = setTimeout(() => setState(s => (s === 'armed' ? 'idle' : s)), 4000)
      return
    }
    if (timer.current) clearTimeout(timer.current)
    setState('closing')
    client
      // Not the detail itself: it is gone, and the panel says so until the list moves on.
      .post(`/api/managed/${encodeURIComponent(managedId)}/close`, {}, {
        invalidate: mutationInvalidates.sessionClose(managedId).filter(key => key !== keys.managed(managedId)),
      })
      .then(() => {
        onClosed()
        toast('Closed. Claude still has its own transcript of it.')
      })
      .catch(error => {
        setState('idle')
        client.store.invalidate(...mutationInvalidates.sessionChange(managedId))
        toast(failureText(error))
      })
  }
  return (
    <button
      type="button"
      id="close-agent"
      className="button close-agent"
      title="Remove this conversation from Fleet"
      data-armed={state === 'armed' ? '1' : undefined}
      disabled={state === 'closing'}
      onClick={click}
    >
      {state === 'armed' ? (working ? 'Stop and close?' : 'Close for good?') : state === 'closing' ? 'Closing…' : 'Close'}
    </button>
  )
}
