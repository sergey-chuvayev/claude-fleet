// Placeholder (shell slot): everything in aside#detail for the Sessions view, that is
// the control panel (conversation and composer) and the inspector. Replace this file
// with the inspector feature, which composes features/conversation into it.
//
// Read the selection with useSelection('sessions'). useInspector().open says whether
// the inspector (#detail-content) is shown; the top bar's toggle controls it.
import { EmptyState } from '../../components/EmptyState'

export function SessionDetail() {
  return (
    <div id="detail-content">
      <EmptyState title="The full picture." text="Select a session to inspect it." />
    </div>
  )
}
