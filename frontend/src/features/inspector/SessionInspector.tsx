// Placeholder (feature slot): the inspector column (#detail-content) for a managed or
// external session: latest request/response, context, activity, linked work, environment,
// identity, resume command (F04, F31). The sessions/inspector feature replaces this file;
// SessionDetail mounts it beside the control panel when useInspector().open is true.
import type { Selection } from '../../app/state'

export interface SessionInspectorProps {
  readonly selection: Extract<Selection, { kind: 'managed' | 'external' }>
}

export function SessionInspector(_props: SessionInspectorProps) {
  return <div id="detail-content" />
}
