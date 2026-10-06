// Placeholder (feature slot): the read-only detail of a delegated agent (F05): assignment,
// steps, input/output/report, duration, model, usage; no composer. The sessions/inspector
// feature replaces this file; SessionDetail mounts it for a 'delegation' selection.
import type { Selection } from '../../app/state'

export interface DelegationDetailProps {
  readonly selection: Extract<Selection, { kind: 'delegation' }>
}

export function DelegationDetail(_props: DelegationDetailProps) {
  return <div id="detail-content" />
}
