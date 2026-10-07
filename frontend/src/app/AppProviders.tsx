// Everything the app reads from context, in one place: the transport client, the app
// store (state and preferences), the toast and announcer, and the clock. The objects
// are created once outside React (main.tsx, or a test), so StrictMode's double mount
// cannot create a second of anything.
import type { ReactNode } from 'react'
import { ClockProvider, type Clock } from '../components/clock'
import { NotificationsProvider, type Notifier } from '../components/Toast'
import type { FleetClient } from '../transport/client'
import { FleetClientProvider } from '../transport/hooks'
import { type AppStore, AppStoreProvider } from './AppStore'

export interface AppProvidersProps {
  readonly client: FleetClient
  readonly store: AppStore
  readonly notifier: Notifier
  readonly clock?: Clock
  readonly children: ReactNode
}

export function AppProviders({ client, store, notifier, clock, children }: AppProvidersProps) {
  const tree = (
    <FleetClientProvider client={client}>
      <AppStoreProvider store={store}>
        <NotificationsProvider notifier={notifier}>{children}</NotificationsProvider>
      </AppStoreProvider>
    </FleetClientProvider>
  )
  return clock ? <ClockProvider value={clock}>{tree}</ClockProvider> : tree
}
