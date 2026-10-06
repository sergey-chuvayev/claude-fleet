// The launch model picker's choices (port of fillLaunchModels in control.js). The list
// comes from the runtime through /api/models; the standard choices stand in until it
// answers and whenever it fails, so the picker is never empty. Opening the dialog asks
// again. The operator's choice lives in the launch draft, not here, so an answer that
// arrives late can change the options but never the chosen value.
import { useEffect, useState } from 'react'
import type { SelectOption } from '../../components/Select'
import type { FleetClient } from '../../transport/client'
import { type ModelOption, parseModels } from '../../transport/contracts'
import { useFleetClient, useResource } from '../../transport/hooks'
import type { Resource } from '../../transport/store'
import { getJson, perClient } from './get'

export const STANDARD_MODELS: readonly ModelOption[] = [
  { value: '', displayName: 'Fleet default' },
  { value: 'opus', displayName: 'Opus' },
  { value: 'sonnet', displayName: 'Sonnet' },
  { value: 'haiku', displayName: 'Haiku' },
  { value: 'auto-jev', displayName: 'Auto · Jev' },
]

export const AUTO_JEV = 'auto-jev'

export const modelsResource = perClient(
  (client: FleetClient): Resource<readonly ModelOption[]> => ({
    key: 'models',
    load: async ({ signal }) => ({ data: await getJson(client, '/api/models', parseModels, signal) }),
  }),
)

/** Options for a picker holding `current`: a value the list lacks is kept as its own option. */
export function modelOptions(list: readonly ModelOption[], current: string): SelectOption[] {
  const choices = list.some(m => m.value === current) ? list : [...list, { value: current, displayName: current }]
  return choices.map(m => ({
    value: m.value,
    label: m.displayName || m.value || 'Default',
    ...(m.description ? { description: m.description } : {}),
  }))
}

export interface LaunchModels {
  readonly list: readonly ModelOption[]
  /** A refresh started by this dialog is running. */
  readonly refreshing: boolean
  /** The last attempt failed; the list is the last good one or the standard choices. */
  readonly failed: boolean
}

/** The model list, refreshed once each time the calling dialog mounts. */
export function useLaunchModels(): LaunchModels {
  const client = useFleetClient()
  const resource = modelsResource(client)
  const state = useResource(resource)
  const [refreshing, setRefreshing] = useState(true)
  useEffect(() => {
    let alive = true
    setRefreshing(true)
    void client.store.refresh(resource).finally(() => {
      if (alive) setRefreshing(false)
    })
    return () => {
      alive = false
    }
  }, [client, resource])
  return { list: state.data ?? STANDARD_MODELS, refreshing, failed: state.status === 'error' }
}
