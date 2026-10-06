// Placeholder (shell slot): the New agent dialog (Cmd/Ctrl+N, the New agent button).
// Replace this file with the launch feature. Keep the backdrop id (MODAL_IDS.launch)
// and call onClose for Escape, the close button and Discard; opening must not change
// the selection, and a successful launch selects the new session with
// useActions().select(...).
import type { ModalProps } from '../../app/modals'
import { MODAL_IDS } from '../../app/modals'
import { Dialog, DialogHead } from '../../components/Dialog'
import { EmptyState } from '../../components/EmptyState'

export function LaunchDialog({ onClose }: ModalProps<'launch'>) {
  return (
    <Dialog id={MODAL_IDS.launch} className="modal modal-launch" labelledBy="draft-title" onClose={onClose}>
      <DialogHead titleId="draft-title" spark="✳" eyebrow="NEW AGENT" title="What are we working on?" closeLabel="Close new agent" />
      <div className="modal-body">
        <EmptyState title="Nothing starts until you send." text="The launch form will appear here." />
      </div>
    </Dialog>
  )
}
