// Placeholder (shell slot): the Worktrees tab, full width (no detail column, no
// inspector toggle). Replace this file with the Worktrees feature. Open the clear
// confirmation with useActions().openModal({ kind: 'clear-worktree', path }).
import { EmptyState } from '../../components/EmptyState'

export function WorktreesPage() {
  return <EmptyState title="Your worktrees." text="Every checkout a session worked in will appear here." />
}
