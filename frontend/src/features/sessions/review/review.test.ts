// Ported from review.test.js (the pure helpers): the same assertions.
import { describe, expect, it } from 'vitest'
import type { PrStatus } from '../../../transport/contracts'
import { ciFeedback, prLinks, problem } from './review'

const failing = (number: number, ...names: string[]): PrStatus => ({ ok: true, number, state: 'open', draft: false, ci: { result: 'fail', failing: names } })
const passing = (number: number): PrStatus => ({ ok: true, number, state: 'open', draft: false, ci: { result: 'pass', failing: [] } })
const link = (n: number) => ({ kind: 'pr', label: `PR #${n}`, url: `https://github.com/example-org/demo-repo/pull/${n}` })

describe('review helpers', () => {
  it('the failing-CI message names the checks and the PR', () => {
    expect(ciFeedback([failing(12, 'build', 'lint')])).toBe('CI failed on build, lint (PR #12). Fix it and push.')
    expect(ciFeedback([failing(12, 'build'), passing(13), failing(14, 'e2e')])).toBe(
      'CI failed on build (PR #12). Fix it and push. CI failed on e2e (PR #14). Fix it and push.',
    )
  })

  it('a long list of failures is trimmed, and nothing red means no prefilled message', () => {
    expect(ciFeedback([failing(1, 'a', 'b', 'c', 'd', 'e', 'f', 'g')])).toMatch(/^CI failed on a, b, c, d, e and 2 more \(PR #1\)/)
    expect(ciFeedback([passing(12)])).toBe('')
    expect(ciFeedback([{ ok: false, reason: 'missing' }, undefined])).toBe('')
    expect(ciFeedback([])).toBe('')
  })

  it('only GitHub PR links count, and only the latest three', () => {
    const session = { links: [{ kind: 'linear', label: 'ABC-1', url: 'https://linear.app/x/issue/ABC-1' }, link(1), link(2), link(3), link(4)] }
    expect(prLinks(session).map(l => l.label)).toEqual(['PR #2', 'PR #3', 'PR #4'])
    expect(prLinks({})).toEqual([])
    for (const kind of ['day', 'project', 'thread']) expect(prLinks({ ...session, kind })).toEqual([])
    expect(prLinks({ ...session, kind: 'agent' })).toHaveLength(3)
    expect(prLinks(null)).toEqual([])
  })

  it('each way gh can be unavailable says what to do about it', () => {
    expect(problem('missing')).toMatch(/not installed/)
    expect(problem('unauthenticated')).toMatch(/gh auth login/)
    expect(problem('rate-limited')).toMatch(/rate limiting/)
    expect(problem('anything-else')).toMatch(/could not read/)
  })
})
