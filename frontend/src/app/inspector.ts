// The inspector (#detail-content) beside a conversation. Wide screens show it,
// smaller ones start with it closed, unless the operator chose otherwise
// (fleet:minimal-details-open). With no console in the detail column (no managed
// session selected) there is nothing to toggle against, so it is always shown and
// the top bar hides the toggle, as legacy syncDetails did.
import { WIDE_QUERY, useMediaQuery } from '../components/layers'
import { useInspectorChoice, useSelection, useView } from './AppStore'

export interface InspectorState {
  /** The toggle applies: the Sessions view with a managed session selected. */
  readonly available: boolean
  readonly open: boolean
}

export function useInspector(): InspectorState {
  const view = useView()
  const selection = useSelection('sessions')
  const choice = useInspectorChoice()
  const wide = useMediaQuery(WIDE_QUERY)
  const available = view === 'sessions' && selection?.kind === 'managed'
  return { available, open: !available || (choice ?? wide) }
}
