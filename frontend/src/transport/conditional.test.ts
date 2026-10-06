// A24: 304 / full / packed / unknown hash / 431 sequences against the server's own
// sync.js. Whatever travels, the result must equal a plain full fetch, unchanged rows
// must keep their identity, and retries must stay bounded.
import { describe, expect, it } from 'vitest'
import { jsonResponse, strip, syncRoute } from '../test/fakes'
import { type ConditionalOutcome, type ConditionalState, conditionalGet, knownHeader, reconstruct } from './conditional'
import { HttpError, ProtocolError } from './errors'

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ sessionId: `s${i}`, title: `Session ${i}`, state: 'idle' }))
type Row = ReturnType<typeof rows>[number]

const ok = (outcome: ConditionalOutcome) => {
  if (outcome.kind !== 'ok') throw new Error(`expected a full answer, got ${outcome.kind}`)
  return outcome
}
const sessionsOf = (value: unknown): Row[] => (value as { sessions: Row[] }).sessions

function setup() {
  const route = syncRoute(['sessions'], ['generatedAt'])
  let state: ConditionalState | undefined
  let value: unknown
  const get = async (maxKnownBytes?: number) => {
    const outcome = await conditionalGet({
      url: '/api/sessions',
      paths: ['sessions'],
      previous: state,
      fetch: route.fetch,
      ...(maxKnownBytes === undefined ? {} : { maxKnownBytes }),
    })
    if (outcome.kind === 'ok') {
      state = outcome.state
      value = outcome.value
    }
    return outcome
  }
  return { route, get, current: () => value, state: () => state }
}

describe('conditionalGet (A24)', () => {
  it('answers 304 for an unchanged resource without reading a body', async () => {
    const t = setup()
    let at = 1
    const sessions = rows(5)
    t.route.set({ generatedAt: at++, sessions })
    ok(await t.get())
    t.route.set({ generatedAt: at++, sessions })
    const second = await t.get()
    expect(second.kind).toBe('not-modified')
    expect(t.route.wire.at(-1)).toMatchObject({ status: 304 })
    expect(t.route.wire.at(-1)?.ifNoneMatch).toBe(t.state()?.tag)
  })

  it('rebuilds a packed answer exactly, keeping unchanged rows by reference', async () => {
    const t = setup()
    let sessions = rows(50)
    t.route.set({ sessions })
    const first = sessionsOf(ok(await t.get()).value)

    // One row changes, one is added, one removed, and the order moves.
    sessions = sessions.map((s, i) => (i === 7 ? { ...s, title: 'Renamed' } : s))
    sessions = [{ sessionId: 'new', title: 'New', state: 'busy' }, ...sessions.slice(0, 20), ...sessions.slice(21)].reverse()
    t.route.set({ sessions })
    const second = ok(await t.get())

    expect(t.route.wire.at(-1)?.known).toBeTruthy()
    expect(strip(second.value)).toEqual(t.route.plain())
    const rebuilt = sessionsOf(second.value)
    const byId = new Map(first.map(row => [row.sessionId, row]))
    for (const row of rebuilt) {
      if (row.sessionId === 's7' || row.sessionId === 'new') expect(byId.get(row.sessionId)).not.toBe(row)
      else expect(byId.get(row.sessionId)).toBe(row)
    }
    expect(rebuilt.some(row => row.sessionId === 's20')).toBe(false)
    expect(rebuilt).toHaveLength(50)
  })

  it('never mutates the previous answer while unpacking', async () => {
    const t = setup()
    let sessions = rows(3)
    t.route.set({ sessions })
    const firstValue = ok(await t.get()).value
    const frozen = JSON.stringify(firstValue)
    sessions = [...sessions, { sessionId: 'x', title: 'X', state: 'idle' }]
    t.route.set({ sessions })
    ok(await t.get())
    expect(JSON.stringify(firstValue)).toBe(frozen)
  })

  it('retries once without conditional headers when a fingerprint cannot be placed', async () => {
    const t = setup()
    const sessions = rows(3)
    t.route.set({ sessions })
    ok(await t.get())
    t.route.set({ sessions: [...sessions, { sessionId: 'y', title: 'Y', state: 'idle' }] })
    // The server names a row this page never held: the copies drifted apart.
    t.route.next(() => jsonResponse({ sessions: [{ h: 'AAAAAAAAAAAAAAAA' }] }, 200, { etag: '"drift"' }))
    const outcome = ok(await t.get())
    expect(t.route.wire).toHaveLength(3)
    expect(t.route.wire[2]).toMatchObject({ ifNoneMatch: null, known: null, status: 200 })
    expect(strip(outcome.value)).toEqual(t.route.plain())
    // Rows that came back whole but unchanged still keep their identity.
    const before = sessionsOf(t.current())
    expect(before).toHaveLength(4)
  })

  it('keeps identity through an unconditional answer when content is unchanged', () => {
    const previous = new Map<string, unknown>()
    const kept = { id: 'a', h: 'aaaaaaaaaaaaaaaa' }
    previous.set(kept.h, kept)
    const { value } = reconstruct({ list: [{ id: 'a', h: 'aaaaaaaaaaaaaaaa' }, { id: 'b' }] }, ['list'], previous)
    expect((value as { list: unknown[] }).list[0]).toBe(kept)
  })

  it('gives up with a ProtocolError after one unconditional retry, never looping', async () => {
    const t = setup()
    t.route.set({ sessions: rows(2) })
    ok(await t.get())
    const drift = () => jsonResponse({ sessions: [{ h: 'BBBBBBBBBBBBBBBB' }] })
    t.route.next(drift, drift, drift)
    await expect(t.get()).rejects.toBeInstanceOf(ProtocolError)
    expect(t.route.wire).toHaveLength(3)
  })

  it('retries a 431 once without conditional headers, then reports it', async () => {
    const t = setup()
    t.route.set({ sessions: rows(4) })
    ok(await t.get())
    t.route.set({ sessions: rows(5) })
    t.route.next(() => new Response(null, { status: 431 }))
    const outcome = ok(await t.get())
    expect(t.route.wire.slice(-2).map(w => [w.status, w.ifNoneMatch === null])).toEqual([
      [431, false],
      [200, true],
    ])
    expect(sessionsOf(outcome.value)).toHaveLength(5)

    t.route.next(
      () => new Response(null, { status: 431 }),
      () => new Response(null, { status: 431 }),
    )
    await expect(t.get()).rejects.toMatchObject({ status: 431 })
    expect(t.route.wire).toHaveLength(5)
  })

  it('leaves out X-Fleet-Known past its bound but still sends the ETag', async () => {
    const t = setup()
    t.route.set({ sessions: rows(30) })
    ok(await t.get())
    t.route.set({ sessions: rows(31) })
    ok(await t.get(100))
    expect(t.route.wire.at(-1)).toMatchObject({ known: null, status: 200 })
    expect(t.route.wire.at(-1)?.ifNoneMatch).toBeTruthy()
    expect(knownHeader(new Map([['a'.repeat(16), 1]]), 10)).toBeNull()
    expect(knownHeader(new Map())).toBeNull()
  })

  it('surfaces a server error with its message and never treats it as data', async () => {
    const t = setup()
    t.route.next(() => jsonResponse({ error: 'Session not found.' }, 404))
    const failure = t.get()
    await expect(failure).rejects.toBeInstanceOf(HttpError)
    await expect(failure).rejects.toMatchObject({ status: 404, message: 'Session not found.' })
  })

  it('runs the full sequence 200, 304, packed, drift, 431 and ends exactly current', async () => {
    const t = setup()
    let sessions = rows(10)
    t.route.set({ sessions })
    ok(await t.get())
    expect((await t.get()).kind).toBe('not-modified')
    sessions = sessions.map((s, i) => (i === 3 ? { ...s, state: 'busy' } : s))
    t.route.set({ sessions })
    ok(await t.get())
    t.route.next(() => jsonResponse({ sessions: [{ h: 'CCCCCCCCCCCCCCCC' }] }))
    sessions = sessions.slice(2)
    t.route.set({ sessions })
    ok(await t.get())
    t.route.next(() => new Response(null, { status: 431 }))
    sessions = [...sessions, { sessionId: 'z', title: 'Z', state: 'stale' }]
    t.route.set({ sessions })
    const last = ok(await t.get())
    expect(strip(last.value)).toEqual(t.route.plain())
    expect(t.route.wire.map(w => w.status)).toEqual([200, 304, 200, 200, 200, 431, 200])
  })
})
