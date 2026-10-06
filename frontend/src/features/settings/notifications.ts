// Desktop notifications are this browser's choice, so they live in this browser
// (`fleet.notify`, "1" when wanted) next to the permission the browser itself holds.
export const NOTIFY_KEY = 'fleet.notify'

interface NotificationApi {
  readonly permission: NotificationPermission
  requestPermission(): Promise<NotificationPermission>
}

const api = (): NotificationApi | null => {
  const candidate = (globalThis as { Notification?: NotificationApi }).Notification
  return candidate ?? null
}

export const notificationsSupported = (): boolean => api() !== null
export const notificationPermission = (): NotificationPermission | 'unsupported' => api()?.permission ?? 'unsupported'

/** Wanted by the operator and allowed by the browser. */
export function notifyEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(NOTIFY_KEY) === '1' && api()?.permission === 'granted'
  } catch {
    return false
  }
}

/** Turn it on (asking the browser when it has not been asked) or off. Returns the resulting state. */
export async function setNotifyEnabled(wanted: boolean): Promise<boolean> {
  const notification = api()
  if (wanted && notification?.permission === 'default') await notification.requestPermission().catch(() => {})
  const on = wanted && notification?.permission === 'granted'
  try {
    globalThis.localStorage?.setItem(NOTIFY_KEY, on ? '1' : '0')
  } catch {
    // Storage blocked: the choice lasts until the page closes.
  }
  return on
}
