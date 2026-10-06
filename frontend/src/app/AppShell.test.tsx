// Smoke: the shell boots against fixture responses, through the real transport.
import { act, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import controlFixture from '../test/fixtures/control.json'
import sessionsFixture from '../test/fixtures/sessions.json'
import { FakeEventSource, jsonResponse, syncRoute } from '../test/fakes'
import { FleetClient } from '../transport/client'
import type { FetchLike } from '../transport/conditional'
import { FleetClientProvider } from '../transport/hooks'
import { AppShell } from './AppShell'

function boot(fetch: FetchLike) {
  FakeEventSource.instances = []
  const client = new FleetClient({ fetch, eventSource: url => new FakeEventSource(url), visibility: null })
  client.start()
  render(
    <StrictMode>
      <FleetClientProvider client={client}>
        <AppShell />
      </FleetClientProvider>
    </StrictMode>,
  )
  return client
}

let client: FleetClient | null = null
afterEach(() => {
  client?.stop()
  client = null
})

describe('AppShell', () => {
  it('loads control and the session snapshot and lists every session by name', async () => {
    const sessions = syncRoute(['sessions'], ['generatedAt'])
    sessions.set(sessionsFixture)
    const requests: string[] = []
    client = boot(async (url, init) => {
      requests.push(url)
      if (url === '/api/control') return jsonResponse(controlFixture)
      if (url === '/api/sessions') return sessions.fetch(url, init)
      return jsonResponse({ error: 'Not found.' }, 404)
    })

    expect(screen.getByText('Loading your sessions…')).toBeTruthy()
    const list = await screen.findByRole('list', { name: 'Sessions' })
    const names = [...list.querySelectorAll('li')].map(li => li.textContent)
    expect(names).toEqual([
      'Fix the flaky upload test',
      'Draft the release notes',
      'Terminal session in the desktop app',
      '0dec0de0',
      'An archived conversation',
    ])
    expect(await screen.findByText(`v${controlFixture.version}`)).toBeTruthy()
    // StrictMode mounts twice; the store still asked once per resource, on one stream.
    expect(requests.filter(url => url === '/api/sessions')).toHaveLength(1)
    expect(requests.filter(url => url === '/api/control')).toHaveLength(1)
    expect(FakeEventSource.instances).toHaveLength(1)

    expect(screen.getByRole('status').textContent).toContain('Connecting')
    act(() => FakeEventSource.instances[0]?.open())
    expect(screen.getByRole('status').textContent).toContain('Live')
  })

  it('shows a readable failure instead of a blank page when the list cannot load', async () => {
    client = boot(async url =>
      url === '/api/control' ? jsonResponse(controlFixture) : jsonResponse({ error: 'Fleet is restarting.' }, 503),
    )
    expect((await screen.findByRole('alert')).textContent).toContain('Fleet is restarting.')
  })
})
