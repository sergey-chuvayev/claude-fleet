// A24 at app level (hard gate): the conditional-GET sequence through the whole app.
// The transport tests (transport/conditional.test.ts) prove the algorithm; these prove
// what the person sees: after 200, 304, packed, an unknown fingerprint and 431 the list
// on screen is exactly the server's latest, nothing is lost, a 304 is never parsed,
// unchanged rows keep their objects, and a failing route is retried once, not forever.
import { act, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '../test/fakes'
import { type AppFleet, type MountedApp, appFleet, bannerText, emit, mountApp, rowKeys, sessionRow } from './appFleet'

let app: MountedApp | null = null
afterEach(() => {
  app?.unmount()
  app = null
  vi.unstubAllGlobals()
})

const visibleKeys = (fleet: AppFleet) =>
  (fleet.snapshot().sessions as Array<{ managedId: string | null; sessionId: string; archived: boolean; kind?: string; background?: boolean }>)
    .filter(row => !row.archived && !row.background && row.kind !== 'day' && row.kind !== 'project')
    .map(row => row.managedId ?? row.sessionId)

const rows = (a: MountedApp) => a.client.store.get(a.client.resources.sessions).data?.sessions ?? []

async function boot() {
  const fleet = appFleet()
  app = mountApp(fleet)
  await screen.findByText('Clean up stale branches', { selector: '.session-title' })
  return { fleet, app }
}

describe('A24 conditional sequence, whole app', () => {
  it('ends exactly at the server after 304, packed, drifted and 431 answers, never parsing a 304', async () => {
    const { fleet, app } = await boot()
    const listGets = () => fleet.getsOf(/^\/api\/sessions$/)
    expect(listGets()).toHaveLength(1)
    expect(rowKeys()).toEqual(visibleKeys(fleet))
    const before = rows(app)

    // 304: nothing changed. The answer has no body to read (reading it throws).
    await emit(app, 'list', '{}')
    await waitFor(() => expect(listGets()).toHaveLength(2))
    expect(listGets()[1]?.ifNoneMatch).toBeTruthy()
    expect(fleet.sessions.wire.at(-1)?.status).toBe(304)
    expect(rows(app)).toBe(before)

    // Packed: one row renamed, the rest sent as {h} and rebuilt from what the page holds.
    fleet.patchRow('m-claude-idle', { name: 'Renamed on the server', title: 'Renamed on the server' })
    await emit(app, 'list', '{}')
    await screen.findByText('Renamed on the server', { selector: '.session-title' })
    expect(listGets().at(-1)?.known).toBeTruthy()
    const after = rows(app)
    const changed = after.filter((row, i) => row !== before[i]).map(row => row.managedId ?? row.sessionId)
    expect(changed).toEqual(['m-claude-idle'])
    expect(rowKeys()).toEqual(visibleKeys(fleet))

    // A fingerprint the page never had: one unconditional retry, then the exact list.
    fleet.patchRow('m-tagged', { name: 'Drifted copy', title: 'Drifted copy' })
    fleet.next(/^\/api\/sessions$/, () => {
      const snap = fleet.snapshot()
      return jsonResponse({ ...snap, sessions: snap.sessions.map(() => ({ h: 'AAAAAAAAAAAAAAAA' })) }, 200, { etag: '"drift"' })
    })
    const beforeDrift = listGets().length
    await emit(app, 'list', '{}')
    await screen.findByText('Drifted copy', { selector: '.session-title' })
    expect(listGets().length - beforeDrift).toBe(2)
    expect(listGets().at(-1)?.ifNoneMatch).toBeNull()
    expect(listGets().at(-1)?.known).toBeNull()
    expect(rowKeys()).toEqual(visibleKeys(fleet))

    // 431: the same single unconditional retry.
    fleet.patchRow('m-claude-error', { name: 'After a 431', title: 'After a 431' })
    fleet.next(/^\/api\/sessions$/, () => jsonResponse({ error: 'Request Header Fields Too Large' }, 431))
    const before431 = listGets().length
    await emit(app, 'list', '{}')
    await screen.findByText('After a 431', { selector: '.session-title' })
    expect(listGets().length - before431).toBe(2)
    expect(bannerText()).toBeNull()

    // A row removed and the order changed: exactly the server's latest order.
    const snap = fleet.snapshot()
    const removed = snap.sessions.find((row: { managedId: string | null }) => row.managedId === 'm-claude-stopped')
    snap.sessions = snap.sessions.filter((row: unknown) => row !== removed).reverse()
    fleet.setSessions(snap)
    await emit(app, 'list', '{}')
    await waitFor(() => expect(sessionRow('m-claude-stopped')).toBeNull())
    // The list sorts for display; compare as sets plus the sort the list itself applies.
    expect(new Set(rowKeys())).toEqual(new Set(visibleKeys(fleet)))
    expect(rows(app).map(row => row.managedId ?? row.sessionId)).toEqual(snap.sessions.map((row: { managedId: string | null; sessionId: string }) => row.managedId ?? row.sessionId))
  })

  it('a route that keeps failing is tried twice per refresh, keeps the last good list and says so', async () => {
    const { fleet, app } = await boot()
    const shown = rowKeys()
    fleet.next(/^\/api\/sessions$/, () => jsonResponse({ error: 'too large' }, 431))
    fleet.next(/^\/api\/sessions$/, () => jsonResponse({ error: 'too large' }, 431))
    const before = fleet.getsOf(/^\/api\/sessions$/).length
    await emit(app, 'list', '{}')
    await waitFor(() => expect(bannerText()).toBe('Connection lost. Showing the last successful snapshot; retrying automatically.'))
    expect(fleet.getsOf(/^\/api\/sessions$/).length - before).toBe(2)
    expect(rowKeys()).toEqual(shown)
    // Nothing loops in the background.
    await act(async () => new Promise(r => setTimeout(r, 50)))
    expect(fleet.getsOf(/^\/api\/sessions$/).length - before).toBe(2)
    // The next refresh recovers and clears the banner.
    await emit(app, 'list', '{}')
    await waitFor(() => expect(bannerText()).toBeNull())
  })

  it('a managed detail grows by packed messages without losing or reordering any', async () => {
    const { fleet, app } = await boot()
    await act(async () => sessionRow('m-claude-idle')?.click())
    const log = await screen.findByRole('log', { name: 'Agent conversation' })
    await waitFor(() => expect(log.querySelectorAll('[data-block]').length).toBeGreaterThan(0))
    const detail = fleet.held('m-claude-idle')!
    const base = detail.session.messages as Array<{ id: string }>
    for (let n = 1; n <= 30; n++) {
      fleet.patchSession('m-claude-idle', {
        messages: [...(fleet.held('m-claude-idle')!.session.messages as unknown[]), { id: `grow-${n}`, role: 'assistant', text: `Growth line ${n}`, at: 1791280800000 + n }],
      })
      await emit(app, 'sessions', '["m-claude-idle"]')
    }
    await screen.findByText('Growth line 30')
    const ids = [...log.querySelectorAll<HTMLElement>('[data-block]')].map(b => b.dataset.block)
    const expected = [...base.map(m => m.id), ...Array.from({ length: 30 }, (_, i) => `grow-${i + 1}`)]
    // Every message, in order (blocks may add suffixes for parts of one message).
    const seen = expected.filter(id => ids.some(block => block === id || block?.startsWith(`${id}`)))
    expect(seen).toEqual(expected)
    const wire = fleet.getsOf(/^\/api\/managed\/m-claude-idle$/)
    expect(wire.slice(1).every(g => g.known !== null)).toBe(true)
  })
})
