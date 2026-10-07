// The New agent draft (F06, F07, F14), as a reducer behind a small store that lives as
// long as the FleetClient, not the dialog: closing the dialog (Escape, the close
// button, the backdrop) keeps every field, Discard and a successful launch start a new
// draft. Nothing here talks to the server; LaunchDialog's actions do, and report back
// with actions.
//
// Request identity, as legacy control.js: the request id is minted on the first launch
// attempt and kept while nothing changes, so retrying a failed or unanswered launch
// sends the same id and the server answers with the session it already made (if it
// made one). Any edit, and saving a team, drops it.
import type { ApprovalMode, Engine } from '../../transport/contracts'
import { type EditorAction, type TeamEditorSession, editorReducer } from '../teams/catalogDraft'

export interface LaunchFields {
  readonly prompt: string
  /** null until seeded from fleet:launch-cwd or the server's default directory. */
  readonly cwd: string | null
  readonly engine: Engine
  /** '' is a single agent. */
  readonly teamId: string
  /** '' is "Fleet default". */
  readonly model: string
  /** null until seeded from the server's default approval mode. */
  readonly approvalMode: ApprovalMode | null
}

export type EditableField = 'prompt' | 'cwd' | 'engine' | 'teamId' | 'model' | 'approvalMode'

export interface LaunchError {
  readonly message: string
  /** The server's machine-readable code (CAPACITY, VALIDATION...), or null. */
  readonly code: string | null
  /** The field to blame, for focus. */
  readonly field?: 'prompt' | 'cwd' | undefined
}

/** The team editor, a mode of the dialog: closed, fetching the team, or open. */
export type EditorState =
  | { readonly status: 'closed' }
  | { readonly status: 'loading'; readonly token: number }
  | ({ readonly status: 'open' } & TeamEditorSession)

export interface LaunchState {
  readonly fields: LaunchFields
  readonly requestId: string | null
  readonly submitting: boolean
  readonly error: LaunchError | null
  readonly editor: EditorState
}

export type LaunchAction =
  | { readonly type: 'edit'; readonly field: EditableField; readonly value: string }
  /** Fill fields the operator has not set yet; never overwrites one that has a value. */
  | { readonly type: 'seed'; readonly cwd?: string | undefined; readonly approvalMode?: ApprovalMode | undefined }
  | { readonly type: 'invalid'; readonly error: LaunchError }
  | { readonly type: 'submit'; readonly requestId: string }
  | { readonly type: 'failed'; readonly error: LaunchError }
  /** The launch landed: a new, empty draft. */
  | { readonly type: 'launched' }
  | { readonly type: 'discard' }
  | { readonly type: 'editor-loading'; readonly token: number }
  | { readonly type: 'editor-opened'; readonly token: number; readonly session: TeamEditorSession }
  | { readonly type: 'editor-failed'; readonly token: number }
  | { readonly type: 'editor'; readonly action: EditorAction }
  /** Back to the form, on the team that was chosen when the editor opened. */
  | { readonly type: 'editor-back' }
  /** A team was saved: back to the form, with it chosen. */
  | { readonly type: 'editor-saved'; readonly teamId: string }

export const freshFields = (): LaunchFields => ({
  prompt: '',
  cwd: null,
  engine: 'claude',
  teamId: '',
  model: '',
  approvalMode: null,
})

export const initialLaunchState = (): LaunchState => ({
  fields: freshFields(),
  requestId: null,
  submitting: false,
  error: null,
  editor: { status: 'closed' },
})

const ENGINES: readonly string[] = ['claude', 'codex']
const MODES: readonly string[] = ['ask', 'auto', 'all']

export function launchReducer(state: LaunchState, action: LaunchAction): LaunchState {
  switch (action.type) {
    case 'edit': {
      if (state.submitting) return state
      const { field, value } = action
      if (field === 'engine' && !ENGINES.includes(value)) return state
      if (field === 'approvalMode' && !MODES.includes(value)) return state
      if (state.fields[field] === value) return state
      return { ...state, fields: { ...state.fields, [field]: value }, requestId: null }
    }
    case 'seed': {
      const cwd = state.fields.cwd === null && action.cwd !== undefined ? action.cwd : state.fields.cwd
      const approvalMode =
        state.fields.approvalMode === null && action.approvalMode !== undefined ? action.approvalMode : state.fields.approvalMode
      if (cwd === state.fields.cwd && approvalMode === state.fields.approvalMode) return state
      return { ...state, fields: { ...state.fields, cwd, approvalMode } }
    }
    case 'invalid':
      return { ...state, error: action.error }
    case 'submit':
      return state.submitting ? state : { ...state, submitting: true, error: null, requestId: action.requestId }
    case 'failed':
      // The request id stays: a retry of this exact form is the same request.
      return { ...state, submitting: false, error: action.error }
    case 'launched':
    case 'discard':
      return initialLaunchState()
    case 'editor-loading':
      return { ...state, editor: { status: 'loading', token: action.token } }
    case 'editor-opened':
      if (state.editor.status !== 'loading' || state.editor.token !== action.token) return state
      return { ...state, editor: { status: 'open', ...action.session } }
    case 'editor-failed':
      if (state.editor.status !== 'loading' || state.editor.token !== action.token) return state
      return { ...state, editor: { status: 'closed' } }
    case 'editor': {
      if (state.editor.status !== 'open') return state
      const { status: _status, ...session } = state.editor
      const next = editorReducer(session, action.action)
      return next === session ? state : { ...state, editor: { status: 'open', ...next } }
    }
    case 'editor-back': {
      if (state.editor.status !== 'open') return state
      const teamId = state.editor.returnTeam
      return {
        ...state,
        editor: { status: 'closed' },
        fields: { ...state.fields, teamId },
        requestId: teamId === state.fields.teamId ? state.requestId : null,
      }
    }
    case 'editor-saved':
      return { ...state, editor: { status: 'closed' }, fields: { ...state.fields, teamId: action.teamId }, requestId: null }
  }
}

type Listener = () => void

/** The reducer behind useSyncExternalStore; one per FleetClient (see useLaunch). */
export class LaunchStore {
  private state: LaunchState = initialLaunchState()
  private readonly listeners = new Set<Listener>()
  private token = 0

  getState = (): LaunchState => this.state

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispatch = (action: LaunchAction): void => {
    const next = launchReducer(this.state, action)
    if (next === this.state) return
    this.state = next
    for (const listener of [...this.listeners]) listener()
  }

  /** A new token for a team-editor fetch; an answer for an older one is ignored. */
  nextToken(): number {
    return ++this.token
  }
}
