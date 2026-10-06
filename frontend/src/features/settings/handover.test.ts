// The handover wait: only a different instanceId or buildId proves a restart.
import { describe, expect, it } from 'vitest'
import control from '../../test/fixtures/fleet-mixed/get-control.json'
import { jsonResponse } from '../../test/fakes'
import { waitForNewServer } from './handover'

const body = control.response.body

/** A clock that only moves when the code under test sleeps. */
function clock() {
  let t = 0
  return { now: () => t, sleep: async (ms: number) => void (t += ms) }
}

/** Answers from a script, then repeats the last answer. `null` is a refused connection. */
function script(answers: Array<Record<string, unknown> | null>) {
  let i = 0
  const seen: string[] = []
  const fetcher = (async (url: string) => {
    seen.push(url)
    const next = answers[Math.min(i++, answers.length - 1)]
    if (next === null) throw new TypeError('fetch failed')
    return jsonResponse({ ...body, ...next })
  }) as unknown as typeof fetch
  return { fetch: fetcher, seen }
}

describe('waitForNewServer', () => {
  it('ignores the old process answering 200 and returns when instanceId changes', async () => {
    const { fetch, seen } = script([{}, {}, {}, { instanceId: 'next-process' }])
    const outcome = await waitForNewServer({ previous: { instanceId: body.instanceId, buildId: body.buildId }, fetch, ...clock() })
    expect(outcome).toBe('changed')
    expect(seen).toHaveLength(4)
    expect(seen.every(url => url === '/api/control')).toBe(true)
  })

  it('accepts a new build on the same instance id', async () => {
    const { fetch } = script([{}, { buildId: '0.55.0+abcdef012345' }])
    expect(await waitForNewServer({ previous: { instanceId: body.instanceId, buildId: body.buildId }, fetch, ...clock() })).toBe('changed')
  })

  it('does not take downtime for success: the old identity coming back is still the old server', async () => {
    const { fetch } = script([null, null, {}, null, { instanceId: 'next-process' }])
    expect(await waitForNewServer({ previous: { instanceId: body.instanceId }, fetch, ...clock() })).toBe('changed')
  })

  it('times out with an answer when the identity never changes', async () => {
    const { fetch, seen } = script([{}])
    const outcome = await waitForNewServer({ previous: { instanceId: body.instanceId }, fetch, deadlineMs: 5000, intervalMs: 700, ...clock() })
    expect(outcome).toBe('timeout')
    expect(seen.length).toBeGreaterThan(3)
  })

  it('times out when the server never returns', async () => {
    const { fetch } = script([null])
    expect(await waitForNewServer({ previous: { instanceId: body.instanceId }, fetch, deadlineMs: 3000, ...clock() })).toBe('timeout')
  })

  it('without a known previous identity, waits for it to go away and come back', async () => {
    const { fetch } = script([{}, {}, null, {}])
    expect(await waitForNewServer({ previous: {}, fetch, ...clock() })).toBe('changed')
    const stuck = script([{}])
    expect(await waitForNewServer({ previous: {}, fetch: stuck.fetch, deadlineMs: 4000, ...clock() })).toBe('timeout')
  })
})
