// The team editor (F14), a mode of the New agent dialog rather than a dialog of its
// own: it takes the dialog's place until the operator goes back or saves. Ported from
// public/teams.js render(): the same sections, ids, labels and copy. All state is the
// launch store's (catalogDraft.ts holds the rules); this component only draws it.
import { type FormEvent, useId } from 'react'
import { Select } from '../../components/Select'
import {
  EFFORTS,
  type EditorAction,
  MODEL_SUGGESTIONS,
  type RoleDraft,
  type TeamEditorSession,
  isOwnerReview,
  toolAllowed,
} from './catalogDraft'
import './TeamEditor.css'

export interface TeamEditorProps {
  readonly session: TeamEditorSession
  readonly dispatch: (action: EditorAction) => void
  readonly onBack: () => void
  readonly onSave: () => void
}

const EFFORT_OPTIONS = EFFORTS.map(effort => ({ value: effort, label: effort }))

export function TeamEditor({ session, dispatch, onBack, onSave }: TeamEditorProps) {
  const { draft, tools, originalId, error, saving } = session
  const ownerReview = isOwnerReview(draft)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    onSave()
  }
  return (
    <form className="draft-form" noValidate onSubmit={submit}>
      <section id="team-editor" aria-label="Team editor">
        <div className="team-editor-head">
          <div>
            <span className="modal-eyebrow">YOUR TEAM, YOUR WAY</span>
            <h3 id="team-editor-title">Shape the team.</h3>
            <p className="note">Choose the specialists. Fleet handles task tracking and independent verification.</p>
          </div>
          <button type="button" className="button" id="team-editor-back" onClick={onBack}>
            Back to draft
          </button>
        </div>
        <div id="team-editor-fields">
          <div className="team-meta">
            <label>
              Team name
              <input
                value={draft.name}
                maxLength={80}
                required
                onChange={e => dispatch({ type: 'team-field', field: 'name', value: e.target.value })}
              />
            </label>
            <label>
              Team ID
              <input
                value={draft.id}
                maxLength={60}
                required
                readOnly={!!originalId}
                onChange={e => dispatch({ type: 'team-field', field: 'id', value: e.target.value })}
              />
            </label>
            <label>
              Purpose
              <input
                value={draft.description}
                maxLength={500}
                required
                onChange={e => dispatch({ type: 'team-field', field: 'description', value: e.target.value })}
              />
            </label>
          </div>
          <div className="team-rules">
            <label>
              {ownerReview ? 'Reviewed implementations per request' : 'Repair attempts per task'}
              <input
                type="number"
                min={1}
                max={10}
                value={draft.maxAttempts}
                onChange={e => dispatch({ type: 'team-field', field: 'maxAttempts', value: e.target.value })}
              />
            </label>
          </div>
          <p className="note">
            {ownerReview
              ? 'One owner implements and finishes the request in the same session. One independent reviewer checks the committed changes. The initial review counts toward the request limit.'
              : 'One manager talks to you. Verification roles check every task; at least one separate worker does the work.'}{' '}
            Shell access permits commands and is governed by your approval mode.
          </p>
          <div className="team-role-list">
            {draft.roles.map((role, index) => (
              <RoleRow
                key={role.uid}
                role={role}
                first={index === 0}
                manager={role.uid === draft.manager}
                reviewer={draft.reviewers.includes(role.uid)}
                ownerReview={ownerReview}
                tools={tools}
                allowed={tool => toolAllowed(draft, role, tool)}
                dispatch={dispatch}
              />
            ))}
          </div>
          <datalist id="team-model-options">
            {MODEL_SUGGESTIONS.map(model => (
              <option key={model} value={model} />
            ))}
          </datalist>
        </div>
        {error ? (
          <p id="team-editor-error" className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="team-editor-actions">
          <button
            type="button"
            className="button"
            id="team-add-role"
            disabled={ownerReview || saving}
            onClick={() => dispatch({ type: 'add-role' })}
          >
            + Add role
          </button>
          <button type="submit" className="button resume" id="team-save" disabled={saving}>
            Save team
          </button>
        </div>
      </section>
    </form>
  )
}

interface RoleRowProps {
  readonly role: RoleDraft
  readonly first: boolean
  readonly manager: boolean
  readonly reviewer: boolean
  readonly ownerReview: boolean
  readonly tools: readonly string[]
  readonly allowed: (tool: string) => boolean
  readonly dispatch: (action: EditorAction) => void
}

function RoleRow({ role, first, manager, reviewer, ownerReview, tools, allowed, dispatch }: RoleRowProps) {
  const effortId = useId()
  const set = (field: 'id' | 'description' | 'prompt' | 'model' | 'maxTurns' | 'effort') => (value: string) =>
    dispatch({ type: 'role-field', uid: role.uid, field, value })
  return (
    // Open state belongs to the element after the first render: the first role starts open.
    <details className="team-role" data-role-key={role.id} open={first ? true : undefined}>
      <summary>
        <strong>{role.id}</strong>
        <span>{role.description}</span>
        <small>{role.model}</small>
      </summary>
      <div className="team-role-fields">
        <label>
          Role ID
          <input value={role.id} maxLength={40} required onChange={e => set('id')(e.target.value)} />
        </label>
        <label>
          Model
          <input
            value={role.model}
            list="team-model-options"
            maxLength={80}
            required
            onChange={e => set('model')(e.target.value)}
          />
        </label>
        <label>
          Turn limit
          <input
            type="number"
            min={1}
            max={100}
            value={role.maxTurns}
            required
            onChange={e => set('maxTurns')(e.target.value)}
          />
        </label>
        <label htmlFor={effortId}>
          Reasoning effort
          <Select id={effortId} label="Reasoning effort" value={role.effort} options={EFFORT_OPTIONS} onChange={set('effort')} block />
        </label>
        <label className="team-wide">
          Purpose
          <input value={role.description} maxLength={500} required onChange={e => set('description')(e.target.value)} />
        </label>
        <label className="team-wide">
          Instructions
          <textarea value={role.prompt} rows={6} maxLength={12000} required onChange={e => set('prompt')(e.target.value)} />
        </label>
        <div className="team-role-kind team-wide">
          <label>
            <input
              type="radio"
              name="team-manager-role"
              checked={manager}
              onChange={() => dispatch({ type: 'manager', uid: role.uid })}
            />{' '}
            {ownerReview ? 'Owner' : 'Manager'}
          </label>
          <label>
            <input
              type="checkbox"
              checked={reviewer}
              onChange={e => dispatch({ type: 'reviewer', uid: role.uid, on: e.target.checked })}
            />{' '}
            Required verifier
          </label>
          <button
            type="button"
            className="button"
            disabled={ownerReview}
            onClick={() => dispatch({ type: 'remove-role', uid: role.uid })}
          >
            Remove role
          </button>
        </div>
        <fieldset className="team-wide">
          <legend>Allowed tools</legend>
          <div className="team-tools">
            {tools.map(tool => {
              const enabled = allowed(tool)
              return (
                <label key={tool}>
                  <input
                    type="checkbox"
                    data-tool={tool}
                    checked={enabled && role.tools.includes(tool)}
                    disabled={!enabled}
                    onChange={e => dispatch({ type: 'tool', uid: role.uid, tool, on: e.target.checked })}
                  />{' '}
                  {tool}
                </label>
              )
            })}
          </div>
        </fieldset>
      </div>
    </details>
  )
}
