// Placeholder (shell slot): the Search dialog (Cmd/Ctrl+K, the Search button).
// Replace this file with the search feature; the head below is the legacy one.
import type { ModalProps } from '../../app/modals'
import { MODAL_IDS } from '../../app/modals'
import { Dialog, DialogFoot, DialogHead } from '../../components/Dialog'
import { EmptyState } from '../../components/EmptyState'

export function SearchDialog({ onClose }: ModalProps<'search'>) {
  return (
    <Dialog id={MODAL_IDS.search} className="modal modal-ask" labelledBy="ask-title" onClose={onClose}>
      <DialogHead
        titleId="ask-title"
        spark="✳"
        eyebrow="A LITTLE HELP REMEMBERING"
        title="Find the thread."
        lead="Good ideas are somewhere in your sessions. Let’s find them."
        closeLabel="Close search"
      />
      <div className="modal-body">
        <EmptyState title="Search is on its way." text="Questions across every session will be asked here." />
      </div>
      <DialogFoot>
        <span>
          <span className="modal-status-dot" aria-hidden="true" />
          Your sessions, a little easier to find.
        </span>
        <span>
          <kbd>Esc</kbd> close
        </span>
      </DialogFoot>
    </Dialog>
  )
}
