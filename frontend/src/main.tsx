import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppShell } from './app/AppShell'
import { FleetClient } from './transport/client'
import { FleetClientProvider } from './transport/hooks'
import './styles/tokens.css'
import './styles/shell.css'

// One client per page, started outside React so StrictMode's double mount cannot
// open a second event stream.
const client = new FleetClient({
  fetch: (input, init) => window.fetch(input, init),
  eventSource: typeof EventSource === 'function' ? url => new EventSource(url) : null,
  visibility: document,
})
client.start()

const root = document.getElementById('root')
if (!root) throw new Error('Fleet: #root is missing from index.html.')
createRoot(root).render(
  <StrictMode>
    <FleetClientProvider client={client}>
      <AppShell />
    </FleetClientProvider>
  </StrictMode>,
)
