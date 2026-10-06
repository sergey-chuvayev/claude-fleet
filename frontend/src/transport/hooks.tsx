// React bindings for the transport. Components read server state only through these.
import { type ReactNode, createContext, useCallback, useContext, useSyncExternalStore } from 'react'
import type { FleetClient } from './client'
import type { StreamStatus } from './events'
import type { Resource, ResourceState } from './store'

const ClientContext = createContext<FleetClient | null>(null)

export function FleetClientProvider({ client, children }: { client: FleetClient; children: ReactNode }) {
  return <ClientContext.Provider value={client}>{children}</ClientContext.Provider>
}

export function useFleetClient(): FleetClient {
  const client = useContext(ClientContext)
  if (!client) throw new Error('useFleetClient needs a FleetClientProvider above it.')
  return client
}

/**
 * Watch one resource. Subscribing loads it when it has nothing yet (or was invalidated
 * while unwatched). Pass a stable resource: a client.resources entry, a module-level
 * one, or one from resourceFamily(), never an object literal built during render.
 */
export function useResource<T>(resource: Resource<T>): ResourceState<T> {
  const { store } = useFleetClient()
  const subscribe = useCallback((onChange: () => void) => store.subscribe(resource, onChange), [store, resource])
  const read = useCallback(() => store.get(resource), [store, resource])
  return useSyncExternalStore(subscribe, read, read)
}

export function useStreamStatus(): StreamStatus {
  const client = useFleetClient()
  return useSyncExternalStore(client.subscribeStreamStatus, client.getStreamStatus, client.getStreamStatus)
}
