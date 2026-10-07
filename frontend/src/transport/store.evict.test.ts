// A28: the resource cache stays bounded. Keys nobody watches are kept for a quick
// return, newest first, up to KEEP_UNWATCHED; watched keys and keys with a request in
// flight are never dropped.
import { describe, expect, it } from 'vitest'
import { deferred, flush } from '../test/fakes'
import { resourceFamily } from './resources'
import { KEEP_UNWATCHED, type Resource, ResourceStore } from './store'

const entries = (store: ResourceStore) => (store as unknown as { entries: Map<string, unknown> }).entries

const instant = (key: string): Resource<string> => ({ key, load: async () => ({ data: key }) })

describe('ResourceStore eviction', () => {
  it('keeps only the newest unwatched keys', async () => {
    const store = new ResourceStore()
    for (let n = 0; n < 200; n++) {
      const stop = store.subscribe(instant(`managed:${n}`), () => {})
      await flush()
      stop()
    }
    const left = [...entries(store).keys()]
    expect(left).toHaveLength(KEEP_UNWATCHED)
    expect(left.at(-1)).toBe('managed:199')
    expect(left[0]).toBe(`managed:${200 - KEEP_UNWATCHED}`)
  })

  it('never drops a watched key or one with a request in flight', async () => {
    const store = new ResourceStore()
    const watched = instant('sessions')
    store.subscribe(watched, () => {})
    const slow = deferred<{ data: string }>()
    const pending: Resource<string> = { key: 'managed:slow', load: () => slow.promise }
    store.subscribe(pending, () => {})()
    for (let n = 0; n < 100; n++) {
      const stop = store.subscribe(instant(`managed:${n}`), () => {})
      await flush()
      stop()
    }
    expect(entries(store).has('sessions')).toBe(true)
    expect(entries(store).has('managed:slow')).toBe(true)
    slow.resolve({ data: 'late' })
    await flush()
  })

  it('a dropped key loads again when it is next watched', async () => {
    const store = new ResourceStore()
    let loads = 0
    const first: Resource<string> = { key: 'managed:first', load: async () => ({ data: `load ${++loads}` }) }
    store.subscribe(first, () => {})()
    await flush()
    for (let n = 0; n < KEEP_UNWATCHED + 5; n++) store.subscribe(instant(`managed:${n}`), () => {})()
    await flush()
    expect(entries(store).has('managed:first')).toBe(false)
    store.subscribe(first, () => {})
    await flush()
    expect(store.get(first)).toMatchObject({ status: 'success', data: 'load 2' })
  })
})

describe('resourceFamily', () => {
  it('stays bounded and hands out the same definition while it is kept', () => {
    let made = 0
    const family = resourceFamily(
      (id: string) => `managed:${id}`,
      key => {
        made++
        return instant(key)
      },
    )
    const a = family('a')
    expect(family('a')).toBe(a)
    for (let n = 0; n < 1000; n++) family(`x${n}`)
    expect(made).toBe(1001)
    // Long gone from the family: made again, equivalent.
    expect(family('a').key).toBe('managed:a')
  })
})
