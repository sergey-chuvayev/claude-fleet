import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppProviders } from './app/AppProviders'
import { AppShell } from './app/AppShell'
import { AppStore } from './app/AppStore'
import { PreferenceStore } from './app/preferences'
import { Notifier } from './components/Toast'
import { FleetClient } from './transport/client'
import './styles/tokens.css'
import './styles/shell.css'
import './styles/components.css'

// One of each per page, created outside React so StrictMode's double mount cannot
// open a second event stream or read preferences twice.
const client = new FleetClient({
  fetch: (input, init) => window.fetch(input, init),
  eventSource: typeof EventSource === 'function' ? url => new EventSource(url) : null,
  visibility: document,
})
client.start()
const store = new AppStore(new PreferenceStore())
const notifier = new Notifier()

const root = document.getElementById('root')
if (!root) throw new Error('Fleet: #root is missing from index.html.')
createRoot(root).render(
  <StrictMode>
    <AppProviders client={client} store={store} notifier={notifier}>
      <AppShell />
    </AppProviders>
  </StrictMode>,
)
