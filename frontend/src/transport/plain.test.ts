// Plain JSON reads: client.getJson and client.resources.plain go through the client's
// own fetch, validate, and surface the server's error code.
import { describe, expect, it } from 'vitest'
import { deferred, jsonResponse } from '../test/fakes'
import { FleetClient } from './client'
import type { FetchLike } from './conditional'
import { ContractError, HttpError, ProtocolError } from './errors'

function make(answer: (url: string) => Response | Promise<Response>) {
  const urls: string[] = []
  const fetch: FetchLike = async url => {
    urls.push(url)
    return answer(url)
  }
  return { client: new FleetClient({ fetch, eventSource: null, visibility: null }), urls }
}

const parseCount = (raw: unknown): { n: number } => {
  if (typeof raw !== 'object' || raw === null || typeof (raw as { n?: unknown }).n !== 'number') {
    throw new ContractError('count', 'n is not a number')
  }
  return { n: (raw as { n: number }).n }
}

describe('client.getJson', () => {
  it('reads through the client fetch and returns parsed data', async () => {
    const { client, urls } = make(() => jsonResponse({ n: 3 }))
    expect(await client.getJson('/api/count', parseCount)).toEqual({ n: 3 })
    expect(urls).toEqual(['/api/count'])
  })

  it('throws HttpError with the server code', async () => {
    const { client } = make(() => jsonResponse({ error: 'Gone.', code: 'NOT_FOUND' }, 404))
    const error = await client.getJson('/api/count', parseCount).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HttpError)
    expect(error).toMatchObject({ status: 404, code: 'NOT_FOUND', message: 'Gone.' })
  })

  it('throws ProtocolError for an unreadable body and the parser error for a wrong shape', async () => {
    const bad = make(() => new Response('not json', { status: 200 }))
    await expect(bad.client.getJson('/api/count', parseCount)).rejects.toBeInstanceOf(ProtocolError)
    const wrong = make(() => jsonResponse({ n: 'three' }))
    await expect(wrong.client.getJson('/api/count', parseCount)).rejects.toBeInstanceOf(ContractError)
  })
})

describe('client.resources.plain', () => {
  it('hands out one resource per key and dedupes concurrent loads', async () => {
    const gate = deferred<Response>()
    const { client, urls } = make(() => gate.promise)
    const a = client.resources.plain({ key: 'count', url: '/api/count', parse: parseCount })
    const b = client.resources.plain({ key: 'count', url: '/api/count', parse: parseCount })
    expect(a).toBe(b)
    const first = client.store.refresh(a)
    const second = client.store.refresh(b)
    gate.resolve(jsonResponse({ n: 1 }))
    await Promise.all([first, second])
    expect(urls).toEqual(['/api/count'])
    expect(client.store.get(a).data).toEqual({ n: 1 })
  })

  it('keeps the held object when `equal` says nothing changed', async () => {
    const { client } = make(() => jsonResponse({ n: 1 }))
    const resource = client.resources.plain({
      key: 'count',
      url: '/api/count',
      parse: parseCount,
      equal: (x, y) => x.n === y.n,
    })
    await client.store.refresh(resource)
    const held = client.store.get(resource).data
    await client.store.refresh(resource)
    expect(client.store.get(resource).data).toBe(held)
  })

  it('carries the shared plain resources on every client', () => {
    const { client } = make(() => jsonResponse([]))
    expect(client.resources.projects.key).toBe('projects')
    expect(client.resources.archivedProjects.key).toBe('projects:archived')
    expect(client.resources.progress.key).toBe('progress')
    expect(client.resources.worktrees.key).toBe('worktrees')
  })
})
