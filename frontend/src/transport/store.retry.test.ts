// A25 regression, found by the app-level race test: a session whose read failed after
// the person had moved on kept that failure when chosen again, with no new request,
// until some event happened to name it.
import { describe, expect, it } from 'vitest'
import { flush } from '../test/fakes'
import { type Resource, ResourceStore } from './store'

function failingOnce(key: string) {
  let calls = 0
  const resource: Resource<string> = {
    key,
    async load() {
      calls++
      if (calls === 1) throw new Error('first read failed')
      return { data: `read ${calls}` }
    },
  }
  return { resource, calls: () => calls }
}

describe('ResourceStore retry on return', () => {
  it('reads again when a failed key is watched again', async () => {
    const store = new ResourceStore()
    const { resource, calls } = failingOnce('managed:a')
    const stop = store.subscribe(resource, () => {})
    await flush()
    expect(store.get(resource).status).toBe('error')
    stop()
    store.subscribe(resource, () => {})
    await flush()
    expect(calls()).toBe(2)
    expect(store.get(resource)).toMatchObject({ status: 'success', data: 'read 2' })
  })

  it('does not reload for a second watcher of a key that is already failing', async () => {
    const store = new ResourceStore()
    const { resource, calls } = failingOnce('managed:b')
    store.subscribe(resource, () => {})
    await flush()
    store.subscribe(resource, () => {})
    await flush()
    expect(calls()).toBe(1)
  })
})
