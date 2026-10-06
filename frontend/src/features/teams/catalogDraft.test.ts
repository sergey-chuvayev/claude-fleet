// The team editor's rules (legacy teams.js open/syncTools/read), as pure functions.
import { describe, expect, it } from 'vitest'
import teamsFixture from '../../test/fixtures/teams-heavy/get-teams.json'
import bugfixFixture from '../../test/fixtures/teams-heavy/team-bugfix.json'
import ownerFixture from '../../test/fixtures/teams-heavy/team-owner-review.json'
import type { TeamCatalog, TeamDefinition } from '../../transport/contracts'
import { EDIT_TOOLS, READ_TOOLS, editorReducer, startEditing, toDefinition, toolAllowed } from './catalogDraft'

const catalog = structuredClone(teamsFixture.response.body) as TeamCatalog
const bugfix = () => structuredClone(bugfixFixture.response.body.team) as TeamDefinition
const owner = () => structuredClone(ownerFixture.response.body.team) as TeamDefinition
const roleBy = (session: ReturnType<typeof startEditing>, id: string) => session.draft.roles.find(r => r.id === id)!

describe('team editor draft', () => {
  it('copies a built-in team under a new id and name, and updates a custom one in place', () => {
    const copy = startEditing(bugfix(), catalog, 'bugfix')
    expect(copy.draft.id).toBe('bugfix-custom')
    expect(copy.draft.name).toBe('Bug fix · custom')
    expect(copy.originalId).toBeNull()

    const taken: TeamCatalog = { ...catalog, teams: [...catalog.teams, { ...catalog.teams[0]!, id: 'bugfix-custom', custom: true }] }
    expect(startEditing(bugfix(), taken, 'bugfix').draft.id).toBe('bugfix-custom-copy')

    const mine = { ...bugfix(), id: 'bugfix-custom', name: 'Mine' }
    const update = startEditing(mine, taken, 'bugfix-custom')
    expect(update.draft.id).toBe('bugfix-custom')
    expect(update.draft.name).toBe('Mine')
    expect(update.originalId).toBe('bugfix-custom')
    // The id of a team being updated is read-only.
    expect(editorReducer(update, { type: 'team-field', field: 'id', value: 'renamed' }).draft.id).toBe('bugfix-custom')
  })

  it('keeps the manager to read tools and verifiers away from edit tools, unticking what they lose', () => {
    let session = startEditing(bugfix(), catalog, 'bugfix')
    const manager = roleBy(session, 'manager')
    const developer = roleBy(session, 'developer')
    expect(manager.tools.every(t => READ_TOOLS.includes(t))).toBe(true)
    expect(toolAllowed(session.draft, manager, 'Bash')).toBe(false)
    // Ticking a forbidden tool does nothing.
    expect(editorReducer(session, { type: 'tool', uid: manager.uid, tool: 'Bash', on: true }).draft).toBe(session.draft)

    session = editorReducer(session, { type: 'reviewer', uid: developer.uid, on: true })
    expect(roleBy(session, 'developer').tools.some(t => EDIT_TOOLS.includes(t))).toBe(false)
    expect(roleBy(session, 'developer').tools).toContain('Bash')

    // The developer becomes manager: it keeps only read tools.
    session = editorReducer(session, { type: 'manager', uid: developer.uid })
    expect(roleBy(session, 'developer').tools.every(t => READ_TOOLS.includes(t))).toBe(true)
    // The old manager is free again.
    expect(toolAllowed(session.draft, roleBy(session, 'manager'), 'Bash')).toBe(true)
  })

  it('lets an owner-review owner keep every tool but never adds or removes its two roles', () => {
    const session = startEditing(owner(), catalog, 'owner-review')
    const ownerRole = roleBy(session, 'owner')
    expect(ownerRole.tools).toContain('Write')
    expect(toolAllowed(session.draft, ownerRole, 'Bash')).toBe(true)
    expect(editorReducer(session, { type: 'add-role' })).toBe(session)
    expect(editorReducer(session, { type: 'remove-role', uid: roleBy(session, 'reviewer').uid })).toBe(session)
    expect(toDefinition(session.draft, session.tools).workflow).toMatchObject({ mode: 'owner-review', reviewers: ['reviewer'] })
  })

  it('adds specialists up to eight roles and never removes the manager', () => {
    let session = startEditing(bugfix(), catalog, 'bugfix')
    session = editorReducer(session, { type: 'add-role' })
    session = editorReducer(session, { type: 'add-role' })
    expect(session.draft.roles.map(r => r.id)).toEqual(['manager', 'developer', 'qa', 'specialist', 'specialistx'])
    while (session.draft.roles.length < 8) session = editorReducer(session, { type: 'add-role' })
    expect(editorReducer(session, { type: 'add-role' }).error).toBe('A team can have up to eight roles.')

    const manager = roleBy(session, 'manager')
    expect(editorReducer(session, { type: 'remove-role', uid: manager.uid }).error).toBe(
      'Choose another manager before removing this role.',
    )
    const qa = roleBy(session, 'qa')
    const removed = editorReducer(session, { type: 'remove-role', uid: qa.uid })
    expect(removed.draft.roles.some(r => r.id === 'qa')).toBe(false)
    expect(removed.draft.reviewers).not.toContain(qa.uid)
  })

  it('renames a role without losing its manager or verifier part, and assembles the definition', () => {
    let session = startEditing(bugfix(), catalog, 'bugfix')
    session = editorReducer(session, { type: 'role-field', uid: roleBy(session, 'qa').uid, field: 'id', value: 'checker' })
    session = editorReducer(session, { type: 'role-field', uid: roleBy(session, 'manager').uid, field: 'id', value: 'lead' })
    session = editorReducer(session, { type: 'role-field', uid: roleBy(session, 'lead').uid, field: 'maxTurns', value: '60' })
    session = editorReducer(session, { type: 'team-field', field: 'maxAttempts', value: '5' })
    const definition = toDefinition(session.draft, session.tools)
    expect(definition.manager).toBe('lead')
    expect(definition.workflow).toEqual({ reviewers: ['checker'], maxAttempts: 5 })
    expect(Object.keys(definition.roles)).toEqual(['lead', 'developer', 'checker'])
    expect(definition.roles.lead).toMatchObject({ maxTurns: 60, effort: 'high', model: 'opus' })
    // Tools go out in the catalog's order.
    expect(definition.roles.developer!.tools).toEqual(catalog.tools.filter(t => definition.roles.developer!.tools!.includes(t)))
  })

  it('refuses malformed and repeated role ids before saving', () => {
    let session = startEditing(bugfix(), catalog, 'bugfix')
    const qa = roleBy(session, 'qa').uid
    for (const bad of ['QA', '9qa', 'qa_1', '__proto__', '']) {
      const next = editorReducer(session, { type: 'role-field', uid: qa, field: 'id', value: bad })
      expect(() => toDefinition(next.draft, next.tools)).toThrow('Role IDs need lowercase letters, numbers and hyphens.')
    }
    session = editorReducer(session, { type: 'role-field', uid: qa, field: 'id', value: 'developer' })
    expect(() => toDefinition(session.draft, session.tools)).toThrow('Role ID “developer” is used twice.')
  })

  it('gives a role without a tool list every tool it may have', () => {
    const team = bugfix()
    delete team.roles.developer!.tools
    team.roles.developer!.disallowedTools = ['WebFetch']
    delete team.roles.manager!.tools
    const session = startEditing(team, catalog, 'bugfix')
    expect(roleBy(session, 'developer').tools).toEqual(catalog.tools.filter(t => t !== 'WebFetch'))
    expect(roleBy(session, 'manager').tools).toEqual(catalog.tools.filter(t => READ_TOOLS.includes(t)))
  })
})
