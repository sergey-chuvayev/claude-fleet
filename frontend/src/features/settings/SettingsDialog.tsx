// The Settings dialog (F23): how Fleet runs. The agent queue and approval default, the
// background service, notifications and sounds, and the AI Gateway key. Each section
// owns its own requests; closing the dialog unmounts them all, which drops late answers
// and clears the gateway key field.
import type { ModalProps } from '../../app/modals'
import { MODAL_IDS } from '../../app/modals'
import { Dialog, DialogFoot, DialogHead } from '../../components/Dialog'
import '../../styles/settings.css'
import { AgentsSection } from './AgentsSection'
import { GatewaySection } from './GatewaySection'
import { NotificationsSection } from './NotificationsSection'
import { StartupSection } from './StartupSection'

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
        <AgentsSection />
        <StartupSection />
        <NotificationsSection />
        <GatewaySection />
      </div>
      <DialogFoot>
        <span>No restart needed.</span>
        <span>
          <kbd>Esc</kbd> close
        </span>
      </DialogFoot>
    </Dialog>
  )
}
