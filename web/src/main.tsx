// Installs window.noey. FIRST import on purpose: the UI reaches for the bridge
// during module evaluation in places, so it has to exist before anything else
// is pulled in.
import './platform/noey-web'

import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { WebGate } from './platform/WebGate'
import { installLifecycleTrace } from './lib/lifecycleTrace'

/**
 * Register the media service worker before rendering.
 *
 * Nothing plays until it is controlling the page: every `<video>` in the app
 * points at `/media/...`, which only exists because of the worker. Waiting here
 * rather than racing it is what stops the first clip of a fresh visit from
 * 404ing.
 */
async function boot(): Promise<void> {
  // Before the first render: a boot line appearing in the middle of a render is
  // how we learn iOS threw the page away rather than the job failing.
  installLifecycleTrace()
  const root = createRoot(document.getElementById('root')!)

  // `/transfer/<token>` — the page a PHONE lands on after scanning the
  // รับจากมือถือ QR. It renders before (and without) everything else on
  // purpose: no login, no WebGate — the gate blocks phones, and a phone is
  // exactly who this page is for. Lazy so the phone downloads only what one
  // file input needs, not the whole editor.
  const transfer = /^\/transfer\/([a-f0-9]{32})$/.exec(window.location.pathname)
  if (transfer) {
    const { default: TransferUploadPage } = await import('./pages/TransferUploadPage')
    root.render(
      <StrictMode>
        <TransferUploadPage token={transfer[1]} />
      </StrictMode>
    )
    return
  }

  root.render(
    <StrictMode>
      <WebGate>
        <App />
      </WebGate>
    </StrictMode>
  )
}

void boot()
