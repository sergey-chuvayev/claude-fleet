// Placeholder (shell slot): the confirmation before clearing a worktree
// (modal.path). Replace this file with the Worktrees feature.
import type { ModalProps } from '../../app/modals'
import { MODAL_IDS } from '../../app/modals'
import { Dialog, DialogFoot, DialogHead } from '../../components/Dialog'

export function ClearWorktreeDialog({ modal, onClose }: ModalProps<'clear-worktree'>) {
  return (
    <Dialog id={MODAL_IDS['clear-worktree']} className="modal modal-worktree" labelledBy="worktree-title" onClose={onClose}>
      <DialogHead titleId="worktree-title" spark="⑂" eyebrow="CLEAR A WORKTREE" title="Remove this worktree?" closeLabel="Close" />
      <div className="modal-body">
        <p className="note">{modal.path}</p>
        <div className="ui-actions">
          <button type="button" className="button" data-close-modal>
            Cancel
          </button>
        </div>
      </div>
      <DialogFoot>
        <span>Nothing is removed until you confirm.</span>
        <span>
          <kbd>Esc</kbd> close
        </span>
      </DialogFoot>
    </Dialog>
  )
}
