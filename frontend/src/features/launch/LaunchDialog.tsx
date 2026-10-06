// The New agent dialog (F06, F07, F14): Cmd/Ctrl+N or the New agent button, from any
// view. Same markup, ids and copy as the legacy #launch-backdrop in public/index.html,
// driven by control.js (openLaunch, updateLaunchTeam, the submit handler) and
// teams.js (the team editor, here a mode of this dialog, never a second dialog).
//
//   - The draft lives in the launch store (launchState.ts), not in this component:
//     Escape, the close button and the backdrop close the dialog and keep it; Discard
//     and a successful launch start over. Opening never touches the selection, and
//     nothing reaches the server until Launch.
//   - Each opening asks again for what may have changed: the server's control answer
//     (Codex availability), the model list, and the team catalog when it failed.
//   - Claude and Codex are both always offered. Codex runs one agent on its own model
//     in a sandbox set by the approval mode, so it hides the team and model fields and
//     explains the sandbox; when Codex is not installed it says how to set it up and
//     its launch is refused here, with no request.
import { type KeyboardEvent, useEffect, useRef } from 'react'
import { usePreferences } from '../../app/AppStore'
import type { ModalProps } from '../../app/modals'
import { MODAL_IDS } from '../../app/modals'
import { useNow } from '../../components/clock'
import { Dialog } from '../../components/Dialog'
import { Icon } from '../../components/Icon'
import { Select, type SelectOption } from '../../components/Select'
import { clockAt, untilReset } from '../../domain/format'
import type { ApprovalMode, Engine, TeamSummary } from '../../transport/contracts'
import { useFleetClient, useResource } from '../../transport/hooks'
import { parseUsage } from '../status/UsageStatus'
import { teamsResource } from '../teams/catalog'
import { TeamEditor } from '../teams/TeamEditor'
import type { LaunchState } from './launchState'
import { AUTO_JEV, modelOptions, useLaunchModels } from './models'
import { DEFAULT_APPROVAL, codexAvailable, useLaunchActions, useLaunchState, useLaunchStore } from './useLaunch'
import './launch.css'

const ENGINE_OPTIONS: readonly SelectOption<Engine>[] = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
]

const APPROVAL_OPTIONS: readonly SelectOption<ApprovalMode>[] = [
  { value: 'auto', label: 'Auto · ask for risky commands', description: 'Asks only for destructive or networked shell commands' },
  { value: 'ask', label: 'Ask every time', description: 'Every tool waits for you' },
  { value: 'all', label: 'Approve everything', description: 'Nothing waits, destructive commands included' },
]

/** What Fleet's approval setting means for Codex, which cannot ask before each command. */
export const CODEX_SANDBOX: Readonly<Record<ApprovalMode, string>> = {
  ask: 'Codex reads the project but changes nothing.',
  auto: 'Codex edits inside the project, without network access. It does not ask before each command.',
  all: 'Codex edits inside the project and can use the network. It does not ask before each command.',
}

export const CODEX_MISSING = 'Codex was not found. Install the Codex CLI and sign in, then reopen this dialog to check again.'
const NO_TEAM = 'No team · single agent'
const AUTO_JEV_NOTE =
  'Auto · Jev sends the task brief to Vercel AI Gateway to select a model, billed separately. Its choice stays pinned; you can switch models later.'

export function LaunchDialog({ onClose }: ModalProps<'launch'>) {
  const store = useLaunchStore()
  const state = useLaunchState()
  const editing = state.editor.status === 'open'
  // Read once, at open: which part of the dialog takes focus first.
  const initialFocus = useRef(editing ? '#team-editor input' : '#launch-prompt').current
  return (
    <Dialog
      id={MODAL_IDS.launch}
      className={`modal modal-launch${editing ? ' is-editing-team' : ''}`}
      labelledBy={editing ? 'team-editor-title' : 'draft-title'}
      initialFocus={initialFocus}
      onClose={onClose}
    >
      <Refresh />
      <ModeFocus editing={editing} />
      {state.editor.status === 'open' ? (
        <EditorMode state={state} />
      ) : (
        <LaunchForm
          state={state}
          onDiscard={() => {
            store.dispatch({ type: 'discard' })
            onClose()
          }}
        />
      )}
    </Dialog>
  )
}

// Each opening re-asks the server what may have changed since the last one.
function Refresh() {
  const client = useFleetClient()
  useEffect(() => {
    void client.store.refresh(client.resources.control)
    const teams = teamsResource(client)
    if (client.store.get(teams).status === 'error') void client.store.refresh(teams)
  }, [client])
  return null
}

// Switching between the form and the team editor replaces the focused element; put
// focus where the operator continues (the prompt, or the editor's first field).
function ModeFocus({ editing }: { editing: boolean }) {
  const previous = useRef(editing)
  useEffect(() => {
    if (previous.current === editing) return
    previous.current = editing
    const target = document.querySelector<HTMLElement>(editing ? '#team-editor input' : '#launch-prompt')
    target?.focus()
  }, [editing])
  return null
}

function EditorMode({ state }: { state: LaunchState }) {
  const store = useLaunchStore()
  const actions = useLaunchActions()
  if (state.editor.status !== 'open') return null
  return (
    <TeamEditor
      session={state.editor}
      dispatch={action => store.dispatch({ type: 'editor', action })}
      onBack={() => store.dispatch({ type: 'editor-back' })}
      onSave={() => void actions.saveEditor()}
    />
  )
}

interface LaunchFormProps {
  readonly state: LaunchState
  readonly onDiscard: () => void
}

function LaunchForm({ state, onDiscard }: LaunchFormProps) {
  const client = useFleetClient()
  const store = useLaunchStore()
  const actions = useLaunchActions()
  const preferences = usePreferences()
  const control = useResource(client.resources.control).data
  const catalog = useResource(teamsResource(client))
  const models = useLaunchModels()
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const cwdRef = useRef<HTMLInputElement>(null)
  const { fields, submitting, error } = state

  // A new draft starts in the last directory launched from (fleet:launch-cwd), else the
  // server's default, and on the server's default approval mode. Seeding never
  // overwrites a value the draft already has, so a draft in progress keeps its own.
  const lastCwd = preferences.get().launchCwd
  useEffect(() => {
    if (fields.cwd === null && (lastCwd || control)) {
      store.dispatch({ type: 'seed', cwd: lastCwd || control?.defaultCwd || '' })
    }
    if (fields.approvalMode === null && control) {
      store.dispatch({ type: 'seed', approvalMode: control.defaultApprovalMode ?? DEFAULT_APPROVAL })
    }
  }, [store, fields.cwd, fields.approvalMode, lastCwd, control])

  // A refused launch puts focus on the field to fix.
  useEffect(() => {
    if (error?.field === 'prompt') promptRef.current?.focus()
    else if (error?.field === 'cwd') cwdRef.current?.focus()
  }, [error])

  const codex = fields.engine === 'codex'
  const codexReady = codexAvailable(control)
  const teamsLoading = catalog.status === 'loading' || catalog.status === 'idle'
  const teams = catalog.data?.teams ?? null
  const team: TeamSummary | null = codex ? null : (teams?.find(t => t.id === fields.teamId) ?? null)
  const ownerReview = team?.mode === 'owner-review'
  const approvalMode = fields.approvalMode ?? DEFAULT_APPROVAL
  const editorLoading = state.editor.status === 'loading'

  const heading = codex
    ? 'What should Codex work on?'
    : ownerReview
      ? 'Give your owner a task.'
      : team
        ? 'Give your team a brief.'
        : 'What are we working on?'
  const lead = codex
    ? 'Start a focused coding task with Codex.'
    : ownerReview
      ? 'Your owner implements, tests and finishes the request. One independent reviewer checks the changes.'
      : team
        ? `You talk to the ${team.manager || 'manager'}. They delegate to the team and bring the reports back here.`
        : 'One agent, one task. Pick a team to hand it to a manager instead.'
  const promptLabel = ownerReview ? 'Task for the owner' : team ? 'Brief for the manager' : 'What are we working on?'
  const placeholder = ownerReview
    ? 'Describe the task, the expected behavior, and any constraints. Your owner will implement it and request independent review.'
    : team
      ? 'Describe what you want to accomplish. Your manager will work out the tasks and bring back any questions.'
      : 'Describe the task and what a good result looks like…'

  const teamNote = team
    ? [team.description, `Roles: ${team.roles.map(r => r.name).join(', ')}.`].filter(Boolean).join(' ')
    : teamsLoading
      ? 'Loading teams…'
      : teams
        ? ''
        : 'Teams unavailable. Reopen New agent to retry; single agents still work.'
  const engineNote = codex
    ? codexReady
      ? `${CODEX_SANDBOX[approvalMode]}${control?.codex.model ? ` Model: ${control.codex.model}.` : ''}`
      : CODEX_MISSING
    : ''
  const modelStatus = models.refreshing
    ? 'Refreshing available models…'
    : models.failed
      ? 'Could not refresh models. The choices above still work; reopen New agent to retry.'
      : ''

  const teamOptions: SelectOption[] = [
    { value: '', label: NO_TEAM },
    ...(teams ?? []).map(t => ({ value: t.id, label: t.name })),
    // A chosen team the catalog does not list (it failed to load) stays chosen.
    ...(fields.teamId && !teams?.some(t => t.id === fields.teamId) ? [{ value: fields.teamId, label: fields.teamId }] : []),
  ]

  const edit = (field: 'prompt' | 'cwd' | 'engine' | 'teamId' | 'model' | 'approvalMode') => (value: string) =>
    store.dispatch({ type: 'edit', field, value })
  const launch = () => void actions.launch({ codexReady })
  const onPromptKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter launches, as it sends in a conversation; Shift + Enter and IME composition do not.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      launch()
    }
  }

  return (
    <form
      id="launch-form"
      className="draft-form"
      noValidate
      onSubmit={event => {
        event.preventDefault()
        launch()
      }}
    >
      <header className="draft-head">
        <div className="draft-heading">
          <h3>
            <span className="launch-mark" aria-hidden="true">
              ✳
            </span>{' '}
            New agent
          </h3>
          <span className="subtle">Nothing starts until you send.</span>
        </div>
        <button type="button" className="modal-close" data-close-modal aria-label="Close new agent">
          <Icon name="close" />
        </button>
      </header>
      <div className="draft-empty">
        <h2 id="draft-title">{heading}</h2>
        <p id="draft-lead" className="note">
          {lead}
        </p>
      </div>
      <div className="composer draft-composer">
        <label className="sr-only" htmlFor="launch-prompt" id="launch-prompt-label">
          {promptLabel}
        </label>
        <textarea
          ref={promptRef}
          id="launch-prompt"
          name="prompt"
          rows={4}
          maxLength={16000}
          placeholder={placeholder}
          required
          value={fields.prompt}
          disabled={submitting}
          aria-invalid={error?.field === 'prompt' ? true : undefined}
          onChange={event => edit('prompt')(event.target.value)}
          onKeyDown={onPromptKeyDown}
        />
      </div>
      <div className="draft-setup">
        <label className="draft-field draft-field-dir">
          <span>Directory</span>
          <input
            ref={cwdRef}
            name="cwd"
            id="launch-cwd"
            placeholder="~/projects/my-project"
            maxLength={4096}
            autoComplete="off"
            spellCheck={false}
            value={fields.cwd ?? ''}
            disabled={submitting}
            aria-invalid={error?.field === 'cwd' ? true : undefined}
            onChange={event => edit('cwd')(event.target.value)}
          />
        </label>
        <label className="draft-field" id="launch-engine-field" htmlFor="launch-engine">
          <span>Agent</span>
          <Select
            id="launch-engine"
            name="engine"
            label="Agent"
            value={fields.engine}
            options={ENGINE_OPTIONS}
            disabled={submitting}
            onChange={edit('engine')}
          />
        </label>
        {codex ? null : (
          <label className="draft-field" htmlFor="launch-team">
            <span>Team</span>
            <Select
              id="launch-team"
              name="teamId"
              label="Team"
              value={fields.teamId}
              options={teamOptions}
              disabled={submitting || teamsLoading}
              aria-describedby="launch-team-note"
              onChange={edit('teamId')}
            />
          </label>
        )}
        {codex ? null : (
          <label className="draft-field" htmlFor="launch-model">
            <span>Model</span>
            <Select
              id="launch-model"
              name="model"
              label="Model"
              value={fields.model}
              options={modelOptions(models.list, fields.model)}
              disabled={submitting}
              aria-describedby="launch-model-status"
              onChange={edit('model')}
            />
          </label>
        )}
        <label className="draft-field" htmlFor="launch-mode">
          <span>Approvals</span>
          <Select
            id="launch-mode"
            name="approvalMode"
            label="Approvals"
            value={approvalMode}
            options={APPROVAL_OPTIONS}
            disabled={submitting}
            onChange={edit('approvalMode')}
          />
        </label>
      </div>
      <p className="draft-notes note">
        <span id="launch-team-note" role="status">
          {codex ? '' : teamNote}
        </span>
        <span id="launch-engine-note" role="status">
          {engineNote}
        </span>{' '}
        {codex ? null : (
          <button
            type="button"
            className="draft-link"
            id="customize-team"
            disabled={submitting || teamsLoading || editorLoading}
            onClick={() => void actions.openEditor()}
          >
            Customize team…
          </button>
        )}
        <span id="launch-model-status" role="status" hidden={codex || !modelStatus}>
          {codex ? '' : modelStatus}
        </span>
        <span id="launch-model-note" hidden={codex || fields.model !== AUTO_JEV}>
          {AUTO_JEV_NOTE}
        </span>
      </p>
      <RateLimitNotice />
      {error?.code === 'CAPACITY' ? (
        <p id="launch-capacity" className="rate-warning" role="status">
          {error.message} Your draft is kept; launch again when a slot is free.
        </p>
      ) : null}
      {error && error.code !== 'CAPACITY' ? (
        <p id="launch-error" className="form-error" role="alert">
          {error.message}
        </p>
      ) : null}
      <div className="composer-footer">
        <button type="button" className="button" id="draft-discard" disabled={submitting} onClick={onDiscard}>
          Discard
        </button>
        <span className="note">Enter to launch · Shift + Enter for a new line</span>
        <button type="submit" className="button resume" id="launch-submit" disabled={submitting}>
          {submitting ? (
            'Launching…'
          ) : (
            <>
              {team ? 'Launch initiative' : 'Launch agent'} <Icon name="arrow" />
            </>
          )}
        </button>
      </div>
    </form>
  )
}

// The account's rate-limit wall, said where it changes a decision (legacy
// renderStatusbar's #launch-blocked): a new agent would not get past its first message.
function RateLimitNotice() {
  const client = useFleetClient()
  const snapshot = useResource(client.resources.sessions).data
  const blocked = parseUsage(snapshot?.usage)?.blocked ?? null
  if (!blocked) return null
  return <BlockedLine resetsAt={blocked.resetsAt} />
}

function BlockedLine({ resetsAt }: { resetsAt: number }) {
  const now = useNow(30_000)
  return (
    <p id="launch-blocked" className="rate-warning" role="status">
      Rate limited until {clockAt(resetsAt)} ({untilReset(resetsAt, now)}). A new agent will not get past its first message
      until this window resets.
    </p>
  )
}
