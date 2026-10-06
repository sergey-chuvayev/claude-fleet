// The team editor's working copy, as pure data and a reducer, ported from
// public/teams.js (open/render/syncTools/read). A role keeps a stable `uid` while its
// id is renamed, so the row and its open disclosure survive the rename; the manager
// and the verifiers point at uids, and ids are only checked and assembled into a
// TeamDefinition when the team is saved.
//
// Rules carried over:
//   - a built-in team is copied: id `<id>-custom` (plus `-copy` until unique), name
//     `<name> · custom`; a custom team is updated in place and its id is read-only;
//   - a team manager may only read (Read, Glob, Grep, WebSearch, WebFetch); an
//     owner-review owner keeps every tool; a verifier never gets an edit tool. A tool a
//     role may not have is unticked and disabled;
//   - at most eight roles; the manager cannot be removed; owner-review teams have
//     exactly their two roles, so roles are neither added nor removed;
//   - role ids are lowercase letters, numbers and hyphens, unique, never a reserved
//     object key.
// Everything else (role counts, worker/verifier shape, ranges) the server validates and
// explains; its message is shown as it is.
import type { TeamCatalog, TeamDefinition, TeamMode } from '../../transport/contracts'

export const READ_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch']
export const EDIT_TOOLS: readonly string[] = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export const MODEL_SUGGESTIONS = ['opus', 'sonnet', 'haiku', 'inherit'] as const
export const MAX_ROLES = 8
const RESERVED = ['constructor', 'prototype', '__proto__']
const ROLE_ID = /^[a-z][a-z0-9-]{0,39}$/

export interface RoleDraft {
  /** Stable for the life of the draft; never sent. */
  readonly uid: string
  readonly id: string
  readonly description: string
  readonly prompt: string
  readonly model: string
  /** As typed, so an emptied field stays empty until it is saved. */
  readonly maxTurns: string
  readonly effort: string
  readonly tools: readonly string[]
}

export interface TeamDraft {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly mode: TeamMode
  readonly maxAttempts: string
  readonly roles: readonly RoleDraft[]
  /** uid of the manager (the owner, in owner-review). */
  readonly manager: string
  /** uids of the required verifiers. */
  readonly reviewers: readonly string[]
}

export interface TeamEditorSession {
  readonly draft: TeamDraft
  /** Every tool a role can be given, in the server's order. */
  readonly tools: readonly string[]
  /** The custom team being updated (its id is read-only), or null for a new copy. */
  readonly originalId: string | null
  /** The launch form's team when the editor opened; Back returns to it. */
  readonly returnTeam: string
  readonly error: string | null
  readonly saving: boolean
  /** Bumped by every structural change, for uids. */
  readonly serial: number
}

export const isOwnerReview = (draft: Pick<TeamDraft, 'mode'>) => draft.mode === 'owner-review'

/** Whether `role` may be given `tool` under the team's current manager and verifiers. */
export function toolAllowed(draft: TeamDraft, role: RoleDraft, tool: string): boolean {
  if (role.uid === draft.manager && !isOwnerReview(draft) && !READ_TOOLS.includes(tool)) return false
  if (draft.reviewers.includes(role.uid) && EDIT_TOOLS.includes(tool)) return false
  return true
}

/** Untick what the manager and verifier restrictions forbid (legacy syncTools). */
export function restrict(draft: TeamDraft): TeamDraft {
  let changed = false
  const roles = draft.roles.map(role => {
    const tools = role.tools.filter(tool => toolAllowed(draft, role, tool))
    if (tools.length === role.tools.length) return role
    changed = true
    return { ...role, tools }
  })
  return changed ? { ...draft, roles } : draft
}

/** A fresh copy of a team for editing: built-ins become a new custom copy. */
export function startEditing(
  team: TeamDefinition,
  catalog: TeamCatalog,
  selected: string,
): TeamEditorSession {
  const custom = catalog.teams.find(t => t.id === selected)?.custom === true
  let id = team.id
  let name = team.name
  if (!custom) {
    id = `${team.id}-custom`
    while (catalog.teams.some(t => t.id === id)) id += '-copy'
    name += ' · custom'
  }
  const workflow = team.workflow ?? { reviewers: ['qa'], maxAttempts: 3 }
  const mode: TeamMode = workflow.mode === 'owner-review' ? 'owner-review' : 'team'
  const roles: RoleDraft[] = Object.entries(team.roles).map(([key, role], index) => {
    const manager = key === team.manager
    const tools =
      role.tools ??
      catalog.tools.filter(t => !(role.disallowedTools ?? []).includes(t) && (!manager || READ_TOOLS.includes(t)))
    return {
      uid: `r${index}`,
      id: key,
      description: role.description,
      prompt: role.prompt,
      model: role.model || 'inherit',
      maxTurns: String(role.maxTurns ?? (manager ? 100 : 30)),
      effort: role.effort || (manager ? 'high' : 'medium'),
      tools,
    }
  })
  const uidOf = (key: string) => roles.find(r => r.id === key)?.uid
  const draft: TeamDraft = {
    id,
    name,
    description: team.description,
    mode,
    maxAttempts: String(workflow.maxAttempts ?? 3),
    roles,
    manager: uidOf(team.manager) ?? '',
    reviewers: workflow.reviewers.flatMap(key => uidOf(key) ?? []),
  }
  return {
    draft: restrict(draft),
    tools: catalog.tools,
    originalId: custom ? selected : null,
    returnTeam: selected,
    error: null,
    saving: false,
    serial: roles.length,
  }
}

export type TeamField = 'id' | 'name' | 'description' | 'maxAttempts'
export type RoleField = 'id' | 'description' | 'prompt' | 'model' | 'maxTurns' | 'effort'

export type EditorAction =
  | { readonly type: 'team-field'; readonly field: TeamField; readonly value: string }
  | { readonly type: 'role-field'; readonly uid: string; readonly field: RoleField; readonly value: string }
  | { readonly type: 'tool'; readonly uid: string; readonly tool: string; readonly on: boolean }
  | { readonly type: 'manager'; readonly uid: string }
  | { readonly type: 'reviewer'; readonly uid: string; readonly on: boolean }
  | { readonly type: 'add-role' }
  | { readonly type: 'remove-role'; readonly uid: string }
  | { readonly type: 'error'; readonly message: string | null }
  | { readonly type: 'saving'; readonly saving: boolean }

const NEW_ROLE = {
  description: 'A specialist for this task',
  prompt: 'Describe this specialist’s responsibility and expected output.',
  model: 'sonnet',
  maxTurns: '30',
  effort: 'medium',
  tools: ['Read', 'Glob', 'Grep'],
} as const

const fail = (session: TeamEditorSession, message: string): TeamEditorSession => ({ ...session, error: message })

export function editorReducer(session: TeamEditorSession, action: EditorAction): TeamEditorSession {
  const { draft } = session
  const withDraft = (next: TeamDraft): TeamEditorSession => ({ ...session, draft: next, error: null })
  switch (action.type) {
    case 'team-field':
      if (action.field === 'id' && session.originalId) return session
      return withDraft({ ...draft, [action.field]: action.value })
    case 'role-field':
      return withDraft({
        ...draft,
        roles: draft.roles.map(role => (role.uid === action.uid ? { ...role, [action.field]: action.value } : role)),
      })
    case 'tool': {
      const role = draft.roles.find(r => r.uid === action.uid)
      if (!role || (action.on && !toolAllowed(draft, role, action.tool))) return session
      const tools = action.on
        ? session.tools.filter(t => t === action.tool || role.tools.includes(t))
        : role.tools.filter(t => t !== action.tool)
      return withDraft({ ...draft, roles: draft.roles.map(r => (r === role ? { ...r, tools } : r)) })
    }
    case 'manager':
      return withDraft(restrict({ ...draft, manager: action.uid }))
    case 'reviewer': {
      const reviewers = action.on
        ? draft.reviewers.includes(action.uid)
          ? draft.reviewers
          : [...draft.reviewers, action.uid]
        : draft.reviewers.filter(uid => uid !== action.uid)
      return withDraft(restrict({ ...draft, reviewers }))
    }
    case 'add-role': {
      if (isOwnerReview(draft)) return session
      if (draft.roles.length >= MAX_ROLES) return fail(session, 'A team can have up to eight roles.')
      let id = 'specialist'
      while (draft.roles.some(r => r.id === id)) id += 'x'
      const serial = session.serial + 1
      const role: RoleDraft = { uid: `r${serial}`, id, ...NEW_ROLE, tools: [...NEW_ROLE.tools] }
      return { ...withDraft({ ...draft, roles: [...draft.roles, role] }), serial }
    }
    case 'remove-role': {
      if (isOwnerReview(draft)) return session
      if (action.uid === draft.manager) return fail(session, 'Choose another manager before removing this role.')
      return withDraft({
        ...draft,
        roles: draft.roles.filter(r => r.uid !== action.uid),
        reviewers: draft.reviewers.filter(uid => uid !== action.uid),
      })
    }
    case 'error':
      return { ...session, error: action.message }
    case 'saving':
      return { ...session, saving: action.saving }
  }
}

/** The draft as the server's TeamDefinition, or the first reason it cannot be one. */
export function toDefinition(draft: TeamDraft, tools: readonly string[]): TeamDefinition {
  const roles: TeamDefinition['roles'] = {}
  const idOf = new Map<string, string>()
  for (const role of draft.roles) {
    const id = role.id.trim()
    if (!ROLE_ID.test(id) || RESERVED.includes(id)) throw new Error('Role IDs need lowercase letters, numbers and hyphens.')
    if (Object.hasOwn(roles, id)) throw new Error(`Role ID “${id}” is used twice.`)
    idOf.set(role.uid, id)
    roles[id] = {
      description: role.description.trim(),
      prompt: role.prompt.trim(),
      model: role.model.trim(),
      maxTurns: Number(role.maxTurns),
      effort: role.effort,
      tools: tools.filter(t => role.tools.includes(t)),
    }
  }
  return {
    id: draft.id.trim(),
    name: draft.name.trim(),
    description: draft.description.trim(),
    manager: idOf.get(draft.manager) ?? '',
    roles,
    workflow: {
      ...(isOwnerReview(draft) ? { mode: 'owner-review' as const } : {}),
      reviewers: draft.reviewers.flatMap(uid => idOf.get(uid) ?? []),
      maxAttempts: Number(draft.maxAttempts),
    },
  }
}
