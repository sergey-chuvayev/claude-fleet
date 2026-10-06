// Render helpers for shell and feature tests: the real providers, an in-memory
// localStorage, a fake event stream and fixture responses.
import { render } from '@testing-library/react'
import { type ReactNode, StrictMode } from 'react'
import { AppProviders } from '../app/AppProviders'
import { AppStore } from '../app/AppStore'
import { PreferenceStore, type StorageLike } from '../app/preferences'
import { Clock } from '../components/clock'
import { Notifier } from '../components/Toast'
import { FleetClient } from '../transport/client'
import type { FetchLike } from '../transport/conditional'
import { FakeEventSource } from './fakes'

export class MemoryStorage implements StorageLike {
  readonly map = new Map<string, string>()
  constructor(initial: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(initial)) this.map.set(key, value)
  }
  getItem = (key: string) => this.map.get(key) ?? null
  setItem = (key: string, value: string) => void this.map.set(key, value)
  removeItem = (key: string) => void this.map.delete(key)
}

export interface Harness {
  readonly client: FleetClient
  readonly store: AppStore
  readonly storage: MemoryStorage
  readonly notifier: Notifier
  readonly clock: Clock
}

export function makeHarness(fetch: FetchLike, storage = new MemoryStorage()): Harness {
  FakeEventSource.instances = []
  const client = new FleetClient({ fetch, eventSource: url => new FakeEventSource(url), visibility: null })
  return {
    client,
    store: new AppStore(new PreferenceStore(storage)),
    storage,
    notifier: new Notifier(),
    clock: new Clock({ visibility: null }),
  }
}

export function Providers({ harness, children }: { harness: Harness; children: ReactNode }) {
  return (
    <StrictMode>
      <AppProviders client={harness.client} store={harness.store} notifier={harness.notifier} clock={harness.clock}>
        {children}
      </AppProviders>
    </StrictMode>
  )
}

export function renderWith(harness: Harness, ui: ReactNode) {
  return render(<Providers harness={harness}>{ui}</Providers>)
}
