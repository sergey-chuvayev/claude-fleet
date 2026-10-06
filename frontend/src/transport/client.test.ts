// The client's wiring: events become invalidations, bursts coalesce, a hidden page
// waits, a reopened stream starts conditional state over, and POST carries the token.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import controlFixture from '../test/fixtures/control.json'
import sessionsFixture from '../test/fixtures/sessions.json'
import { FakeEventSource, FakeVisibility, flush, jsonResponse, syncRoute } from '../test/fakes'
import { FleetClient } from './client'
import type { FetchLike } from './conditional'
import { HttpError } from './errors'
import { keys, keysForSessionsEvent } from './resources'

interface Call {
  url: string
  method: string
  headers: Headers
  body: string | null
}

function harness() {
  const sessions = syncRoute(['sessions'], ['generatedAt'])
  sessions.set(sessionsFixture)
  const calls: Call[] = []
  let control: () => Response = () => jsonResponse(controlFixture)
  let post: (call: Call) => Response = () => jsonResponse({ ok: true })
  const fetch: FetchLike = async (url, init) => {
    const call = {
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
    }
    calls.push(call)
    if (call.method === 'POST') return post(call)
    if (url === '/api/control') return control()
    if (url === '/api/sessions') return sessions.fetch(url, init)
    return jsonResponse({ error: 'Not found.' }, 404)
  }
  const visibility = new FakeVisibility()
  const client = new FleetClient({
    fetch,
    eventSource: url => new FakeEventSource(url),
    visibility,
    listCoalesceMs: 1000,
    recoveryPollMs: 30_000,
  })
  const gets = (url: string) => calls.filter(c => c.method === 'GET' && c.url === url)
  return {
    client,
    calls,
    gets,
    sessions,
    visibility,
    stream: () => {
      const source = FakeEventSource.instances.at(-1)
      if (!source) throw new Error('no event stream')
      return source
    },
    setControl: (next: () => Response) => {
      control = next
    },
    setPost: (next: (call: Call) => Response) => {
      post = next
    },
  }
}

beforeEach(() => {
  FakeEventSource.instances = []
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('keysForSessionsEvent', () => {
  it('maps managed ids to their detail keys and special ids to their resources', () => {
    expect(keysForSessionsEvent(['m1', 'projects', 'queue', 'm1', ''])).toEqual([
      keys.managed('m1'),
      keys.projects,
      keys.control,
      keys.sessions,
    ])
  })
})

describe('FleetClient', () => {
  it('opens one stream, however often it is started', () => {
    const h = harness()
    h.client.start()
    h.client.start()
    expect(FakeEventSource.instances).toHaveLength(1)
    h.client.stop()
    expect(h.stream().closed).toBe(true)
  })

  it('coalesces a burst of list events into one refetch', async () => {
    const h = harness()
    h.client.start()
    h.client.store.subscribe(h.client.resources.sessions, () => {})
    await flush(20)
    expect(h.gets('/api/sessions')).toHaveLength(1)
    for (let i = 0; i < 10; i++) h.stream().emit('list', '{}')
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.gets('/api/sessions')).toHaveLength(2)
    expect(h.sessions.wire.at(-1)?.status).toBe(304)
    h.client.stop()
  })

  it('waits while hidden and refreshes what is watched on return', async () => {
    const h = harness()
    h.client.start()
    h.client.store.subscribe(h.client.resources.sessions, () => {})
    await flush(20)
    h.visibility.hidden = true
    h.stream().emit('list', '{}')
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.gets('/api/sessions')).toHaveLength(1)
    h.visibility.set(false)
    await flush(20)
    expect(h.gets('/api/sessions')).toHaveLength(2)
    h.client.stop()
  })

  it('invalidates detail keys named by a sessions event, and ignores malformed ones', async () => {
    const h = harness()
    h.client.start()
    const spy = vi.spyOn(h.client.store, 'invalidate')
    h.stream().emit('sessions', '["m1","queue"]')
    h.stream().emit('sessions', 'not json')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(keys.managed('m1'), keys.control, keys.sessions)
    h.client.stop()
  })

  it('starts conditional state over when the stream reopens', async () => {
    const h = harness()
    h.client.start()
    h.client.store.subscribe(h.client.resources.sessions, () => {})
    await flush(20)
    h.stream().open()
    await flush(20)
    expect(h.sessions.wire.at(-1)?.ifNoneMatch).toBeTruthy() // first open: a cheap revalidation
    h.stream().fail()
    h.stream().open()
    await flush(20)
    expect(h.sessions.wire.at(-1)).toMatchObject({ ifNoneMatch: null, known: null, status: 200 })
    h.client.stop()
  })

  it('retries a refused stream with backoff', async () => {
    const h = harness()
    h.client.start()
    const statuses: string[] = []
    h.client.subscribeStreamStatus(() => statuses.push(h.client.getStreamStatus()))
    h.stream().fail(true)
    expect(FakeEventSource.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeEventSource.instances).toHaveLength(2)
    h.stream().open()
    expect(statuses).toEqual(['reconnecting', 'open'])
    h.client.stop()
  })

  it('polls the list as a safety net only while visible', async () => {
    const h = harness()
    h.client.start()
    h.client.store.subscribe(h.client.resources.sessions, () => {})
    await flush(20)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.gets('/api/sessions')).toHaveLength(2)
    h.visibility.hidden = true
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.gets('/api/sessions')).toHaveLength(2)
    h.client.stop()
  })

  it('posts JSON with the control token, which never reaches the store', async () => {
    const h = harness()
    const data = await h.client.post('/api/queue', { paused: true }, { invalidate: [keys.sessions] })
    expect(data).toEqual({ ok: true })
    const post = h.calls.find(c => c.method === 'POST')
    expect(post?.headers.get('x-fleet-token')).toBe(controlFixture.token)
    expect(post?.headers.get('content-type')).toBe('application/json')
    expect(post?.body).toBe('{"paused":true}')
    expect(h.client.store.get(h.client.resources.control).data).not.toHaveProperty('token')
    expect(h.client.store.get(h.client.resources.control).data?.version).toBe(controlFixture.version)
  })

  it('does not retry a refused command, and fetches a fresh token for the next one', async () => {
    const h = harness()
    h.setPost(() => {
      // The server restarted: a new process, a new token.
      h.setControl(() => jsonResponse({ ...controlFixture, token: 'fresh-token' }))
      return jsonResponse({ error: 'Reload Fleet before sending commands.' }, 403)
    })
    await expect(h.client.post('/api/queue', { paused: true })).rejects.toBeInstanceOf(HttpError)
    expect(h.calls.filter(c => c.method === 'POST')).toHaveLength(1)
    h.setPost(() => jsonResponse({ ok: true }))
    await flush(20)
    await h.client.post('/api/queue', { paused: false })
    expect(h.calls.filter(c => c.method === 'POST').at(-1)?.headers.get('x-fleet-token')).toBe('fresh-token')
  })

  it('reports an unusable control answer instead of trusting it', async () => {
    const h = harness()
    h.setControl(() => jsonResponse({ version: '1.0.0' }))
    await expect(h.client.post('/api/queue', {})).rejects.toThrow(/Unexpected \/api\/control response/)
    expect(h.calls.filter(c => c.method === 'POST')).toHaveLength(0)
  })
})
