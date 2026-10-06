// Placeholder (shell slot): everything in aside#detail for the Sessions view, that is
// the control panel (conversation and composer) and the inspector. Replace this file
// with the inspector feature, which keeps composing features/conversation into it.
//
// Read the selection with useSelection('sessions'). useInspector().open says whether
// the inspector (#detail-content) is shown; the top bar's toggle controls it.
import { useSelection } from '../../app/AppStore'
import { selectionKey } from '../../app/state'
import { EmptyState } from '../../components/EmptyState'
import { useToast } from '../../components/Toast'
import { Conversation } from '../conversation'

// The conversation needs a flex column with a set height; the detail column is a
// scrolling block until the inspector feature ports its `.detail:has(#composer)` layout.
const CONSOLE_STYLE = { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } as const

export function SessionDetail() {
  const selection = useSelection('sessions')
  const toast = useToast()
  if (selection && (selection.kind === 'managed' || selection.kind === 'external')) {
    const key = selectionKey(selection)
    return (
      <section id="control-panel" aria-label="Agent controls" style={CONSOLE_STYLE}>
        {/* Keyed: switching sessions starts a fresh log, with its own read position. */}
        <Conversation key={key} sessionKey={key} onNotice={toast} />
      </section>
    )
  }
  return (
    <div id="detail-content">
      <EmptyState title="The full picture." text="Select a session to inspect it." />
    </div>
  )
}
