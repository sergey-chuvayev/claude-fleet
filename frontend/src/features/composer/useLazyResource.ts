// useResource that subscribes (and so loads) only once `enabled` turns true: the slash
// catalog is read the first time the operator types `/`, not for every session opened.
import { useCallback, useSyncExternalStore } from 'react'
import { useFleetClient } from '../../transport/hooks'
import type { Resource, ResourceState } from '../../transport/store'

const nothing = () => () => {}

export function useLazyResource<T>(resource: Resource<T>, enabled: boolean): ResourceState<T> {
  const { store } = useFleetClient()
  const subscribe = useCallback((onChange: () => void) => store.subscribe(resource, onChange), [store, resource])
  const read = useCallback(() => store.get(resource), [store, resource])
  return useSyncExternalStore(enabled ? subscribe : nothing, read, read)
}
