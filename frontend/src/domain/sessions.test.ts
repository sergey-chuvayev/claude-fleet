// The list selectors against the fleet-mixed pack (A01) and hand-made rows: pools,
// counts, filters, dates, status badges, the turn line and the archive sweep.
import { describe, expect, it } from 'vitest'
import { bodyOf } from '../features/sessions/testing'
import sessionsFixture from '../test/fixtures/fleet-mixed/get-sessions.json'
import teamsFixture from '../test/fixtures/teams-heavy/get-sessions.json'
import { type SessionRow, type SessionSnapshot, parseSessionSnapshot, sessionRowOf } from '../transport/contracts'
import {
  contextPercent,
  dateCounts,
  effectiveFilter,
  emptyListText,
  filterLabel,
  heat,
  isWorking,
  matchesDate,
  ordinal,
  partitionSessions,
  shownSessions,
  statusBadge,
  sweepDayChoices,
  sweepTargets,
  turnAriaLabel,
} from './sessions'

const T0 = Date.UTC(2026, 9, 6, 10, 0, 0)
const snapshot = parseSessionSnapshot(bodyOf<SessionSnapshot>(sessionsFixture))
const row = (fields: Record<string, unknown>): SessionRow => sessionRowOf({ state: 'idle', sessionId: 's-1', ...fields } as never)

describe('partitionSessions', () => {
  const parts = partitionSessions(snapshot)

  it('keeps archived rows out of every pool but their own, and background out of the foreground', () => {
    expect(parts.archived.map(r => r.archived)).toEqual([true, true])
    expect(parts.live.every(r => !r.archived)).toBe(true)
    expect(parts.background.map(r => r.name)).toEqual(['observer'])
    expect(parts.foreground).toHaveLength(parts.live.length - 1)
    expect(parts.foreground.some(r => r.background)).toBe(false)
  })

  it('counts the foreground by state, as the server orders rows', () => {
    const counts = { busy: 0, idle: 0, stale: 0, dead: 0 }
    for (const r of parts.foreground) counts[r.state] += 1
    expect(parts.counts).toEqual(counts)
    // The server's own counts exclude archived rows and include background ones.
    expect(parts.counts.idle + 1).toBe(snapshot.counts.idle)
    expect(parts.counts.busy).toBe(snapshot.counts.busy)
    expect(parts.rows.map(r => r.managedId ?? r.sessionId)).toEqual(snapshot.sessions.map(r => r.managedId ?? r.sessionId))
  })

  it('is cached per sessions array, and rows keep their identity', () => {
    expect(partitionSessions(snapshot)).toBe(parts)
    expect(sessionRowOf(snapshot.sessions[0]!)).toBe(parts.rows[0])
  })

  it('leaves Days, project managers and open item threads to their own views', () => {
    const p = partitionSessions({
      sessions: [
        { managedId: 'd', state: 'idle', kind: 'day' },
        { managedId: 'p', state: 'idle', kind: 'project' },
        { managedId: 't1', state: 'idle', kind: 'thread', threadOpen: true },
        { managedId: 't2', state: 'idle', kind: 'thread', threadOpen: false },
        { managedId: 'a', state: 'busy', kind: 'agent' },
      ] as never,
    })
    expect(p.agents.map(r => r.managedId)).toEqual(['t2', 'a'])
  })
})

describe('filters', () => {
  const parts = partitionSessions(snapshot)

  it('shows a state, the background pool or the archive', () => {
    expect(shownSessions(parts, 'all', 'all', T0)).toEqual(parts.foreground)
    expect(shownSessions(parts, 'dead', 'all', T0).every(r => r.state === 'dead')).toBe(true)
    expect(shownSessions(parts, 'dead', 'all', T0)).toHaveLength(parts.counts.dead)
    expect(shownSessions(parts, 'background', 'all', T0)).toEqual(parts.background)
    expect(shownSessions(parts, 'archived', 'all', T0)).toEqual(parts.archived)
  })

  it('falls back from Archived to All when nothing is archived', () => {
    const empty = partitionSessions({ sessions: snapshot.sessions.filter(r => !r.archived) })
    expect(effectiveFilter('archived', empty)).toBe('all')
    expect(effectiveFilter('archived', parts)).toBe('archived')
  })

  it('counts creation dates against the foreground', () => {
    const counts = dateCounts(parts, T0)
    expect(counts.all).toBe(parts.foreground.length)
    expect(counts.today).toBeLessThanOrEqual(counts.week)
    expect(counts.week).toBeLessThanOrEqual(counts.all)
    expect(shownSessions(parts, 'all', 'week', T0)).toHaveLength(counts.week)
  })

  it('reads Today as local midnight and This week as a rolling seven days', () => {
    const midnight = new Date(T0)
    midnight.setHours(0, 0, 0, 0)
    const at = midnight.getTime()
    expect(matchesDate(row({ startedAt: at }), 'today', T0)).toBe(true)
    expect(matchesDate(row({ startedAt: at - 1 }), 'today', T0)).toBe(false)
    expect(matchesDate(row({ startedAt: new Date(T0 - 6.9 * 86400000).toISOString() }), 'week', T0)).toBe(true)
    expect(matchesDate(row({ startedAt: T0 - 7.1 * 86400000 }), 'week', T0)).toBe(false)
    expect(matchesDate(row({}), 'today', T0)).toBe(false)
    expect(matchesDate(row({}), 'all', T0)).toBe(true)
  })

  it('names the active combination and explains an empty list', () => {
    expect(filterLabel('all', 'all')).toBe('All sessions')
    expect(filterLabel('dead', 'today')).toBe('Offline · Today')
    expect(filterLabel('archived', 'week')).toBe('Archived · This week')
    expect(emptyListText('background', 3)).toEqual(['No background sessions right now.'])
    expect(emptyListText('all', 3)[0]).toBe('No sessions match your filters.')
    expect(emptyListText('all', 0)[0]).toBe('Your fleet is quiet.')
  })
})

describe('row facts', () => {
  it('says a queued session is queued, and where it is in line', () => {
    expect(statusBadge(row({ managed: true, managedStatus: 'queued', queuePosition: 3 }))).toEqual({ label: 'Queued · 3rd', className: 'dead' })
    expect(statusBadge(row({ managed: true, managedStatus: 'queued', queuePosition: 0 })).label).toBe('Queued')
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd'])
  })

  it('labels managed, external and held sessions as legacy did', () => {
    const fixture = (id: string) => partitionSessions(snapshot).rows.find(r => r.managedId === id)!
    expect(statusBadge(fixture('m-claude-approval'))).toEqual({ label: 'Needs approval', className: 'stale' })
    expect(statusBadge(fixture('m-claude-error'))).toEqual({ label: 'Error', className: 'hot' })
    expect(statusBadge(fixture('m-claude-idle')).label).toBe('Ready')
    expect(statusBadge(fixture('m-held'))).toEqual({
      label: 'In terminal',
      className: 'elsewhere busy',
      title: 'Open in a terminal (held-in-terminal), working',
    })
    expect(isWorking(fixture('m-held'))).toBe(true)
    expect(statusBadge(row({ state: 'dead' })).label).toBe('Offline')
  })

  it('keeps unknown context unknown, and heats from 75% and 90%', () => {
    expect(contextPercent(row({}))).toBeNull()
    expect(contextPercent(row({ contextTokens: 0, contextLimit: 200000 }))).toBe(0)
    expect(contextPercent(row({ contextTokens: 300000, contextLimit: 200000 }))).toBe(100)
    expect([null, 74, 75, 89, 90].map(heat)).toEqual(['', '', 'warn', 'warn', 'hot'])
  })

  it('tells the turn as steps, the step now and failures', () => {
    const r = row({
      managed: true,
      managedStatus: 'running',
      turn: {
        steps: [
          { t: 'Read', k: 'inspect', ok: true },
          { t: 'Bash', k: 'run', ok: false, target: 'npm test' },
        ],
        current: { t: 'Edit', target: 'a.ts' },
        turnStartedAt: T0,
      },
    })
    expect(turnAriaLabel(r)).toBe('This turn: 1 inspecting, 1 running commands, 1 failed. Now: Edit a.ts')
    expect(turnAriaLabel(row({ turn: { steps: [], current: null, last: null } }))).toBeNull()
  })

  it('falls back to absent for a field with the wrong shape instead of failing the row', () => {
    const r = row({ links: 'nope', turn: 7, delegations: [{ nope: true }], model: 4 })
    expect(r.links).toBeNull()
    expect(r.turn).toBeNull()
    expect(r.delegations).toBeNull()
    expect(r.model).toBeNull()
  })

  it('reads the compact delegation list of a team session', () => {
    const team = partitionSessions(parseSessionSnapshot(bodyOf(teamsFixture))).rows[0]!
    expect(team.delegations).toHaveLength(25)
    expect(team.delegations![0]).toMatchObject({ role: 'developer', model: 'sonnet', status: 'completed' })
  })
})

describe('sweepTargets', () => {
  it('takes offline external sessions with a transcript older than the rule, never managed ones', () => {
    const old = T0 - 10 * 86400000
    const rows = [
      row({ sessionId: 'a', state: 'dead', lastActivity: old }),
      row({ sessionId: 'b', state: 'dead', lastActivity: T0 - 86400000 }),
      row({ sessionId: 'c', state: 'idle', lastActivity: old }),
      row({ managedId: 'm', sessionId: 'd', managed: true, state: 'dead', lastActivity: old }),
      row({ sessionId: 'e', state: 'dead', lastActivity: old, archived: true }),
      row({ sessionId: null, pid: 4, state: 'dead', lastActivity: old }),
    ]
    expect(sweepTargets(rows, 7, T0).map(r => r.sessionId)).toEqual(['a'])
    expect(sweepTargets(rows, 0.5, T0).map(r => r.sessionId)).toEqual(['a', 'b'])
  })

  it('offers the stored rule among the presets', () => {
    expect(sweepDayChoices(14)).toEqual([3, 7, 14, 30])
    expect(sweepDayChoices(10)).toEqual([3, 7, 10, 14, 30])
  })
})
