// Settings, Notifications (F23, F32): the macOS notification when an agent reports back
// and the soft chimes. Both are this browser's choice (`fleet.notify`, `fleet.sounds`).
import { useState } from 'react'
import { type SoundName, sounds } from '../sounds/sounds'
import { notificationPermission, notifyEnabled, setNotifyEnabled } from './notifications'

const SAMPLES: ReadonlyArray<{ name: SoundName; label: string }> = [
  { name: 'done', label: 'Agent finished' },
  { name: 'ask', label: 'Needs you' },
  { name: 'report', label: 'Reported back' },
]

export function NotificationsSection() {
  const [notify, setNotify] = useState(notifyEnabled)
  const [permission, setPermission] = useState(notificationPermission)
  const [soundsOn, setSoundsOn] = useState(sounds.enabled)

  const onNotify = async (wanted: boolean) => {
    setNotify(await setNotifyEnabled(wanted))
    setPermission(notificationPermission())
  }
  const status =
    permission === 'unsupported'
      ? 'This browser has no desktop notifications.'
      : permission === 'denied'
        ? 'Notifications are blocked for this page. Allow them in the browser settings.'
        : ''

  return (
    <section className="settings-section" aria-labelledby="notify-title">
      <h3 id="notify-title">Notifications</h3>
      <p className="note">
        When an agent you launched from Today finishes or stops, it reports on its item and the item waits on you. Fleet always shows a note on
        the page; this adds one from macOS too.
      </p>
      <div className="settings-row">
        <label className="settings-toggle">
          <input type="checkbox" id="notify-enabled" checked={notify} onChange={event => void onNotify(event.target.checked)} /> Desktop
          notification when an agent reports back
        </label>
      </div>
      <p className="note" id="notify-status" role="status">
        {status}
      </p>
      <div className="settings-row">
        <label className="settings-toggle">
          <input
            type="checkbox"
            id="sounds-enabled"
            checked={soundsOn}
            onChange={event => {
              sounds.setEnabled(event.target.checked)
              setSoundsOn(sounds.enabled())
            }}
          />{' '}
          Play sounds
        </label>
        <span className="settings-sounds">
          {SAMPLES.map(sample => (
            <button key={sample.name} type="button" className="button" data-sound-sample={sample.name} onClick={() => sounds.play(sample.name, { force: true })}>
              {sample.label}
            </button>
          ))}
        </span>
      </div>
      <p className="note">
        A soft chime when an agent finishes its turn, when something needs your approval or answer, and when an agent reports back on Today.
        Press one to hear it.
      </p>
    </section>
  )
}
