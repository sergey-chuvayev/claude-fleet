import { describe, expect, it } from 'vitest'
import type { DayItem, DaySubagent } from '../../transport/contracts'
import { type RowInfo, byRole, checkedLine, contextFolds, duration, linkLabel, linksIn, liveStatus, localDate, workingLine } from './day'

const item = (over: Partial<DayItem> = {}): DayItem => ({
  id: 'i1',
  title: 'Reply to Thomas',
  source: 'slack',
  priority: 'must',
  status: 'today',
  mode: 'draft',
  links: [],
  needs: [],
  log: [],
  createdAt: 1,
  ...over,
})
const row = (status: string): RowInfo => ({
  managedId: 'm1',
  kind: 'agent',
  dayDate: null,
  archived: false,
  status,
  name: 'Agent',
  parentDayId: 'd',
  itemId: null,
  threadOpen: false,
  progress: null,
})
const NOW = Date.UTC(2026, 9, 6, 10, 0, 0)

describe('Day helpers', () => {
  it('reads the local calendar date, not UTC', () => {
    // 23:30 local on the 5th is still the 5th, whatever UTC says.
    const late = new Date(2026, 9, 5, 23, 30).getTime()
    expect(localDate(late)).toBe('2026-10-05')
    expect(localDate(new Date(2026, 9, 6, 0, 5).getTime())).toBe('2026-10-06')
  })

  it('labels links as the thing they point at', () => {
    expect(linkLabel('https://linear.app/team/issue/tech-201/thing')).toBe('TECH-201')
    expect(linkLabel('https://github.com/example-org/web-app/pull/77')).toBe('web-app#77')
    expect(linkLabel('https://github.com/example-org/web-app/issues/9')).toBe('web-app#9')
    expect(linkLabel('https://example.slack.com/archives/C1/p1')).toBe('Slack')
    expect(linkLabel('https://www.notion.so/page')).toBe('Notion')
    expect(linkLabel('https://notes.granola.ai/x')).toBe('Granola')
    expect(linkLabel('https://www.figma.com/file/1')).toBe('Figma')
    expect(linkLabel('https://docs.google.com/document/d/1')).toBe('Google Doc')
    expect(linkLabel('https://app.usepylon.com/issues/1')).toBe('Pylon')
    expect(linkLabel('https://www.example.com/ledger')).toBe('example.com')
    expect(linkLabel('not a url')).toBe('Link')
  })

  it('pulls distinct links out of a note', () => {
    expect(linksIn('See https://a.test/x and (https://b.test/y) and https://a.test/x')).toEqual(['https://a.test/x', 'https://b.test/y'])
  })

  it('folds long or structured context only', () => {
    expect(contextFolds('Short note.')).toBe(false)
    expect(contextFolds('Intro\n## Why\nBecause')).toBe(true)
    expect(contextFolds('x'.repeat(401))).toBe(true)
  })

  it('prints durations as the board does', () => {
    expect(duration(45)).toBe('45m')
    expect(duration(60)).toBe('1h')
    expect(duration(90)).toBe('1h 30m')
  })

  it('says where an item actually is', () => {
    const rows = new Map<string, RowInfo>()
    const ctx = { dayStatus: 'idle', focus: null, subagents: [] as DaySubagent[], rows, now: NOW }
    expect(liveStatus(item({ status: 'later' }), ctx)).toBeNull()
    expect(liveStatus(item(), ctx)).toEqual(['idle', 'Not started'])
    expect(liveStatus(item(), { ...ctx, dayStatus: 'running' })).toEqual(['queued', 'Queued for the Day'])
    expect(liveStatus(item({ mode: 'me' }), ctx)).toBeNull()
    expect(liveStatus(item({ mode: 'agent' }), ctx)).toEqual(['queued', 'Launch brief at the next run'])
    expect(liveStatus(item(), { ...ctx, dayStatus: 'running', focus: { itemId: 'i1', at: NOW - 5 * 60000 } })).toEqual([
      'working',
      'Working now · Day agent · 5m',
    ])
    const sub = { id: 's', role: 'researcher', status: 'running', itemId: 'i1', startedAt: NOW - 65 * 60000 } as DaySubagent
    expect(liveStatus(item(), { ...ctx, subagents: [sub] })).toEqual(['working', 'Working now · researcher · 1h 5m'])
    rows.set('m1', row('approval'))
    expect(liveStatus(item({ launched: ['m1'] }), ctx)).toEqual(['needs', 'Its session needs you'])
    rows.set('m1', row('running'))
    expect(liveStatus(item({ launched: ['m1'] }), ctx)).toEqual(['running', 'Running in its own session'])
    rows.set('m1', row('idle'))
    expect(liveStatus(item({ launched: ['m1'] }), ctx)).toBeNull()
    const launch = { id: 'n', kind: 'launch', question: 'Start?' }
    expect(liveStatus(item({ status: 'waiting_on_you', needs: [launch] }), ctx)).toEqual(['needs', 'Launch brief ready · approve it above'])
  })

  it('says when the Day last checked and when it checks next, in local time', () => {
    const lastAt = new Date(2026, 9, 6, 9, 40).getTime()
    expect(checkedLine({ lastAt, everyMin: 30, hours: [8, 19] }, lastAt)).toMatch(/^Checked 0?9:40( AM)? · next 10:10( AM)?$/)
    const evening = new Date(2026, 9, 6, 18, 50).getTime()
    expect(checkedLine({ lastAt: evening, everyMin: 30, hours: [8, 19] }, evening)).toMatch(/next tomorrow 0?8:00( AM)?$/)
    expect(checkedLine(null, NOW)).toBe('')
  })

  it('says what the Day is working on', () => {
    const items = [item(), item({ id: 'i2', title: 'Second' })]
    const sub = { id: 's', role: 'r', status: 'running', itemId: 'i2' } as DaySubagent
    expect(workingLine(items, 'i1', [sub], undefined).text).toBe('Working on Reply to Thomas +1 · 1 subagent…')
    expect(workingLine([], null, [], { text: 'Sweep', runPrompt: 'x' }).text).toBe('Auto check…')
    expect(workingLine([], null, [], { text: 'Hi' }).text).toBe('Working…')
  })

  it('groups subagents by role, scouts first, latest run last', () => {
    const run = (id: string, role: string, startedAt: number) => ({ id, role, status: 'completed', startedAt }) as DaySubagent
    const groups = byRole([run('c1', 'calendar-scout', 1), run('s1', 'slack-scout', 2), run('s2', 'slack-scout', 5), run('x', 'researcher', 9)])
    expect(groups.map(g => [g.role, g.latest.id, g.runs.length])).toEqual([
      ['slack-scout', 's2', 2],
      ['calendar-scout', 'c1', 1],
      ['researcher', 'x', 1],
    ])
  })
})
