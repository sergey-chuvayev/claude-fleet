// The confirmation before clearing a worktree (F29): everything that will go, and what
// is deliberately left. The page only names the path; the server re-derives the verdict
// from git when this is confirmed and refuses when the checkout is no longer merged,
// clean and pushed. A refusal is shown here, and the list catches up with what changed.
import { useState } from 'react'
import type { ModalProps } from '../../app/modals'
import { MODAL_IDS } from '../../app/modals'
import { Dialog, DialogFoot, DialogHead } from '../../components/Dialog'
import { useToast } from '../../components/Toast'
import type { Checkout } from '../../transport/contracts'
import { useFleetClient, useResource } from '../../transport/hooks'
import { worktreeMutationInvalidates, worktreesResource } from '../../transport/resources'
import './worktrees.css'

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

function Plan({ checkout: c }: { checkout: Checkout }) {
  const trunk = c.trunk || 'the trunk'
  const tip = (c.tip ?? '').slice(0, 7)
  const branch = c.branch ?? ''
  const why = c.mergedBy === 'pr' ? `pull request #${c.pr?.number} merged at this commit, so the work is on GitHub` : `every commit is already in ${trunk}`
  return (
    <>
      <p className="worktree-lead">
        Fleet checked just now: <strong>{branch}</strong> is merged, has nothing uncommitted and nothing unpushed. It checks again when you confirm,
        and git refuses if anything has changed.
      </p>
      <h4 className="ui-label">Will be removed</h4>
      <ul className="worktree-plan">
        <li>
          <strong>The folder</strong>
          <code>{c.path}</code>
          <small>Clean: no uncommitted or untracked files.</small>
        </li>
        <li>
          <strong>The local branch</strong>
          <span>
            <code>{branch}</code> at <code>{tip}</code>
          </span>
          <small>
            Kept in history because {why}. To get it back: <code>git branch {branch} {tip}</code>
          </small>
        </li>
      </ul>
      <h4 className="ui-label">Left alone</h4>
      <ul className="worktree-plan">
        <li>
          <strong>The main checkout</strong>
          <code>{c.repo.root}</code>
        </li>
        <li>
          <strong>The remote branch and its pull request</strong>
        </li>
        <li>
          <strong>Every other worktree and branch</strong>
        </li>
        <li>
          <strong>{plural(c.sessions.length, 'session')} that used this folder</strong>
          <small>Their transcripts stay readable. Resuming one needs the folder back.</small>
        </li>
      </ul>
    </>
  )
}

export function ClearWorktreeDialog({ modal, onClose }: ModalProps<'clear-worktree'>) {
  const client = useFleetClient()
  const toast = useToast()
  const state = useResource(worktreesResource)
  const checkout = state.data?.value.checkouts.find(c => c.path === modal.path)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The plan is drawn from the live list. If the checkout stopped being clearable while
  // this was open, say so rather than offering a removal the server would refuse.
  const ready = !!checkout?.clearable && !!checkout.branch && !!checkout.tip

  const remove = async () => {
    if (busy || !ready) return
    setBusy(true)
    setError(null)
    try {
      const answer = (await client.post('/api/worktrees/clear', { path: modal.path }, { invalidate: worktreeMutationInvalidates() })) as {
        cleared?: { branchDeleted?: boolean }
      }
      onClose()
      toast(answer.cleared?.branchDeleted ? 'Worktree and branch removed' : 'Worktree removed. The branch could not be deleted and is still there.')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Fleet could not remove the worktree.')
      void client.store.refresh(worktreesResource)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      id={MODAL_IDS['clear-worktree']}
      className="modal modal-worktree"
      labelledBy="worktree-title"
      initialFocus="[data-worktree-cancel]"
      onClose={onClose}
    >
      <DialogHead titleId="worktree-title" spark="⑂" eyebrow="CLEAR A WORKTREE" title="Remove this worktree?" closeLabel="Close" />
      <div className="modal-body">
        <div id="worktree-plan">
          {checkout && ready ? (
            <Plan checkout={checkout} />
          ) : checkout ? (
            <p className="worktree-lead">This checkout can no longer be cleared: it is not merged, clean and pushed any more. The list has been refreshed.</p>
          ) : state.data ? (
            <p className="worktree-lead">This checkout is not listed any more. The list has been refreshed.</p>
          ) : (
            <p className="worktree-lead">Reading the checkout…</p>
          )}
        </div>
        <p id="worktree-error" className="form-error" role="alert" hidden={!error}>
          {error}
        </p>
        <div className="worktree-actions">
          <button type="button" className="button" data-close-modal data-worktree-cancel>
            Cancel
          </button>
          <button type="button" className="button resume" id="worktree-go" disabled={busy || !ready} onClick={() => void remove()}>
            {busy ? 'Removing…' : 'Remove worktree'}
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
