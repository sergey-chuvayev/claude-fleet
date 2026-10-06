// The update pill (F25), presentation only: what the button says in each state.
// Hidden unless the server reports a newer Fleet. Accent-tinted so it reads as an offer
// next to Refresh, never as an error.
import type { UpdateStatus } from '../../transport/contracts'

/** Where an install is: nothing under way, installing, waiting for the new server, or failed. */
export type UpdatePhase = 'idle' | 'installing' | 'restarting' | 'error'

export interface UpdatePillProps {
  readonly update: UpdateStatus | null
  readonly phase: UpdatePhase
  /** Why the last install failed; shown as the pill's title. */
  readonly error?: string | null | undefined
  readonly onInstall: () => void
}

/** The title (tooltip) for an available update that is not being installed. */
export function offerTitle(update: UpdateStatus): string {
  if (update.canInstall) return `Claude Fleet v${update.latest} is available. Click to install it and reload.`
  return update.channel === 'source'
    ? `v${update.latest} is published. This Fleet runs from a git checkout — update it with git pull.`
    : `v${update.latest} is published. This Fleet was not installed with npm, so it cannot update itself.`
}

export function UpdatePill({ update, phase, error, onInstall }: UpdatePillProps) {
  if (!update?.available) return null
  const working = phase === 'installing' || phase === 'restarting'
  const label = phase === 'restarting' ? 'Restarting…' : phase === 'installing' ? 'Installing…' : `↑ v${update.latest}`
  const title = working
    ? 'Fleet will reload itself when this finishes.'
    : phase === 'error' && error
      ? `${error} Click to try again.`
      : offerTitle(update)
  return (
    <button
      id="update-pill"
      type="button"
      className="button update-pill"
      data-phase={phase}
      disabled={working || !update.canInstall}
      title={title}
      onClick={onInstall}
    >
      {label}
    </button>
  )
}
