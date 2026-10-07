// A25: SSE burst while a GET is pending, a stale GET after a mutation, a selection
// swap with a slow answer, and abort on a new server instance.
import { describe, expect, it, vi } from 'vitest'
import { type Deferred, deferred, flush } from '../test/fakes'
import type { ConditionalState } from './conditional'
import { type LoadContext, type LoadResult, type Resource, ResourceStore } from './store'

/** A resource whose every load waits for the test to answer it. */
function manual<T>(key: string) {
  const calls: Array<{ ctx: LoadContext<T>; answer: Deferred<LoadResult<T>> }> = []
  const resource: Resource<T> = {
    key,
    load(ctx) {
      const answer = deferred<LoadResult<T>>()
      calls.push({ ctx, answer })
      return answer.promise
    },
  }
  const call = (index: number) => {
    const found = calls[index]
    if (!found) throw new Error(`no load #${index} for ${key}`)
    return found
  }
  return { resource, calls, call }
}

const tagged = (tag: string): ConditionalState => ({ tag, items: new Map([['aaaaaaaaaaaaaaaa', { id: 1 }]]) })

describe('ResourceStore (A25)', () => {
  it('shares one in-flight load per key across subscribers and refreshes', async () => {
    const store = new ResourceStore()
    const r = manual<string>('sessions')
    store.subscribe(r.resource, () => {})
    store.subscribe(r.resource, () => {})
    void store.refresh(r.resource)
    void store.refresh(r.resource)
    expect(r.calls).toHaveLength(1)
    expect(store.get(r.resource).status).toBe('loading')
    r.call(0).answer.resolve({ data: 'first' })
    await flush()
    expect(store.get(r.resource)).toMatchObject({ data: 'first', status: 'success' })
  })

  it('turns an invalidation burst during a load into exactly one follow-up', async () => {
    const store = new ResourceStore()
    const r = manual<number>('sessions')
    store.subscribe(r.resource, () => {})
    for (let i = 0; i < 5; i++) store.invalidate('sessions')
    expect(r.calls).toHaveLength(1)
    r.call(0).answer.resolve({ data: 1, conditional: tagged('"one"') })
    await flush()
    expect(r.calls).toHaveLength(2)
    // The follow-up offers what the first answer left behind.
    expect(r.call(1).ctx.conditional?.tag).toBe('"one"')
    expect(r.call(1).ctx.current).toBe(1)
    r.call(1).answer.resolve({ data: 2 })
    await flush()
    expect(r.calls).toHaveLength(2)
    expect(store.get(r.resource).data).toBe(2)
  })

  it('drops a GET answer that started before a mutation result, then reconciles once', async () => {
    const store = new ResourceStore()
    const r = manual<{ name: string }>('managed:a')
    store.subscribe(r.resource, () => {})
    r.call(0).answer.resolve({ data: { name: 'before' }, conditional: tagged('"v1"') })
    await flush()

    store.invalidate('managed:a') // a poll starts...
    expect(r.calls).toHaveLength(2)
    const renamed = { name: 'after' }
    store.set(r.resource, renamed) // ...then the rename's response lands first
    r.call(1).answer.resolve({ data: { name: 'before' }, conditional: tagged('"v1"') }) // the slow, older poll
    await flush()

    expect(store.get(r.resource).data).toBe(renamed)
    // One follow-up, and it cannot 304 back to the older server copy.
    expect(r.calls).toHaveLength(3)
    expect(r.call(2).ctx.conditional?.tag).toBeNull()
    expect(r.call(2).ctx.conditional?.items.size).toBe(1)
    expect(r.call(2).ctx.current).toBe(renamed)
  })

  it('keeps each key to its own answers and errors when the selection moves', async () => {
    const store = new ResourceStore()
    const a = manual<string>('managed:a')
    const b = manual<string>('managed:b')
    const unsubscribeA = store.subscribe(a.resource, () => {})
    unsubscribeA() // the operator moved on before A answered
    store.subscribe(b.resource, () => {})
    b.call(0).answer.resolve({ data: 'B' })
    a.call(0).answer.reject(new Error('A failed'))
    await flush()
    expect(store.get(b.resource)).toMatchObject({ data: 'B', error: null, status: 'success' })
    expect(store.get(a.resource)).toMatchObject({ status: 'error' })
  })

  it('keeps the last good data through a failed refresh', async () => {
    const store = new ResourceStore()
    const r = manual<string>('sessions')
    store.subscribe(r.resource, () => {})
    r.call(0).answer.resolve({ data: 'good' })
    await flush()
    store.invalidate('sessions')
    r.call(1).answer.reject(new Error('offline'))
    await flush()
    expect(store.get(r.resource)).toMatchObject({ data: 'good', status: 'error' })
    expect(store.get(r.resource).error?.message).toBe('offline')
  })

  it('publishes nothing when a load hands back the data it was given (a 304)', async () => {
    const store = new ResourceStore()
    const r = manual<{ n: number }>('sessions')
    const listener = vi.fn()
    store.subscribe(r.resource, listener)
    r.call(0).answer.resolve({ data: { n: 1 } })
    await flush()
    const before = store.get(r.resource)
    const calls = listener.mock.calls.length
    store.invalidate('sessions')
    r.call(1).answer.resolve({ data: r.call(1).ctx.current ?? { n: 0 } })
    await flush()
    expect(store.get(r.resource)).toBe(before)
    expect(listener.mock.calls.length).toBe(calls)
  })

  it('loads an unwatched key that was invalidated only when it is watched again', async () => {
    const store = new ResourceStore()
    const r = manual<string>('projects')
    const off = store.subscribe(r.resource, () => {})
    r.call(0).answer.resolve({ data: 'p' })
    await flush()
    off()
    store.invalidate('projects')
    expect(r.calls).toHaveLength(1)
    store.subscribe(r.resource, () => {})
    expect(r.calls).toHaveLength(2)
  })

  it('aborts in-flight loads and forgets ETags for a new server instance', async () => {
    const store = new ResourceStore()
    const r = manual<string>('sessions')
    store.subscribe(r.resource, () => {})
    r.call(0).answer.resolve({ data: 'old server', conditional: tagged('"old"') })
    await flush()
    store.invalidate('sessions')
    const stale = r.call(1)
    store.forgetConditional()
    expect(stale.ctx.signal.aborted).toBe(true)
    expect(r.calls).toHaveLength(2 + 1)
    expect(r.call(2).ctx.conditional).toBeUndefined()
    stale.answer.resolve({ data: 'aborted answer' })
    r.call(2).answer.resolve({ data: 'new server' })
    await flush()
    expect(store.get(r.resource).data).toBe('new server')
  })

  it('clears the in-flight marker even when a load throws synchronously', async () => {
    const store = new ResourceStore()
    const resource: Resource<string> = {
      key: 'broken',
      load() {
        throw new Error('sync failure')
      },
    }
    await store.refresh(resource)
    expect(store.isFetching('broken')).toBe(false)
    expect(store.get(resource).status).toBe('error')
  })
})
