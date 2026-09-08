// Installs window.noey. FIRST import on purpose: the UI reaches for the bridge
// during module evaluation in places, so it has to exist before anything else
// is pulled in.
import './platform/noey-web'

import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { WebGate } from './platform/WebGate'

/**
 * Register the media service worker before rendering.
 *
 * Nothing plays until it is controlling the page: every `<video>` in the app
 * points at `/media/...`, which only exists because of the worker. Waiting here
 * rather than racing it is what stops the first clip of a fresh visit from
 * 404ing.
 */
async function boot(): Promise<void> {
  const root = createRoot(document.getElementById('root')!)
  root.render(
    <StrictMode>
      <WebGate>
        <App />
      </WebGate>
    </StrictMode>
  )
}

void boot()
