// Placeholder (shell slot): the Connections dialog. Opened from the top bar
// (modal.managedId null) or from a managed session (modal.managedId set). Replace
// this file with the connections feature; the head below is the legacy one.
import type { ModalProps } from '../../app/modals'
import { MODAL_IDS } from '../../app/modals'
import { Dialog, DialogFoot, DialogHead } from '../../components/Dialog'
import { EmptyState } from '../../components/EmptyState'

export function ConnectionsDialog({ onClose }: ModalProps<'connections'>) {
  return (
    <Dialog id={MODAL_IDS.connections} className="modal modal-connections" labelledBy="connections-title" onClose={onClose}>
      <DialogHead
        titleId="connections-title"
        spark="⌘"
        eyebrow="TOOLS WITHIN REACH"
        title="Your connections."
        lead="Check what’s available. Get a blocked connection moving."
        closeLabel="Close connections"
      />
      <div className="modal-body">
        <EmptyState title="Connections are on their way." text="Your configured MCP servers will appear here." />
      </div>
      <DialogFoot>
        <span>Connection changes never resend a task.</span>
        <span>
          <kbd>Esc</kbd> close
        </span>
      </DialogFoot>
    </Dialog>
  )
}
