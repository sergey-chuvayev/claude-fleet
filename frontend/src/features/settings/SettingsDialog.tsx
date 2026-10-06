// Placeholder (shell slot): the Settings dialog. Replace this file with the settings
// feature; the head below is the legacy one. Clear any password field on close.
import type { ModalProps } from '../../app/modals'
import { MODAL_IDS } from '../../app/modals'
import { Dialog, DialogHead } from '../../components/Dialog'
import { EmptyState } from '../../components/EmptyState'

export function SettingsDialog({ onClose }: ModalProps<'settings'>) {
  return (
    <Dialog id={MODAL_IDS.settings} className="modal modal-settings" labelledBy="settings-title" onClose={onClose} initialFocus=".modal-close">
      <DialogHead
        titleId="settings-title"
        spark={'⚙︎'}
        eyebrow="FLEET SETTINGS"
        title="How Fleet runs."
        lead="How many agents run at once, when Fleet starts, and the key for automatic model selection."
        closeLabel="Close settings"
      />
      <div className="modal-body">
        <EmptyState title="Settings are on their way." text="The queue, startup and gateway settings will appear here." />
      </div>
    </Dialog>
  )
}
