// Ported from fleet.test.js ("a delegation selected outside the visible tail still
// renders, and only it reads as selected"): the recent 20, plus a selected older one.
import { describe, expect, it } from 'vitest'
import type { DelegationSummary } from '../../transport/contracts'
import { DELEGATION_ROW_LIMIT, delegationCounts, delegationGroupId, formatModel, visibleDelegations } from './visibleDelegations'

const make = (n: number): DelegationSummary[] =>
  Array.from({ length: n }, (_, i) => ({ id: `d${i}`, role: 'developer', model: 'sonnet', status: i === n - 1 ? 'running' : 'completed' }))

describe('visibleDelegations', () => {
  it('shows everything up to the limit', () => {
    expect(visibleDelegations(make(3), null)).toEqual({ shown: make(3), earlier: 0 })
  })

  it('shows the most recent 20 and counts the rest as earlier', () => {
    const { shown, earlier } = visibleDelegations(make(25), null)
    expect(shown.map(d => d.id)).toEqual(make(25).slice(-DELEGATION_ROW_LIMIT).map(d => d.id))
    expect(earlier).toBe(5)
  })

  it('keeps a selected delegation that aged out of the tail, ahead of the tail', () => {
    const { shown, earlier } = visibleDelegations(make(25), 'd0')
    expect(shown[0]!.id).toBe('d0')
    expect(shown).toHaveLength(21)
    expect(earlier).toBe(4)
    // A selected row inside the tail is not drawn twice.
    expect(visibleDelegations(make(25), 'd24').shown).toHaveLength(20)
  })

  it('summarises the group and formats models', () => {
    const all = [...make(3), { id: 'x', role: 'qa', model: null, status: 'failed' }]
    expect(delegationCounts(all)).toBe('4 sub-agents · 1 working · 1 failed')
    expect(delegationCounts(make(1).map(d => ({ ...d, status: 'completed' })))).toBe('1 sub-agent')
    expect(formatModel('claude-opus-4')).toBe('opus-4')
    expect(formatModel(null)).toBe('Model pending')
    expect(delegationGroupId('m:1/x')).toBe('children-m_1_x')
  })
})
