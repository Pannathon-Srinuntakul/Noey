import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

// A file dropped anywhere but a drop zone must not become a navigation: the
// window would load the file in place of the app. Drop zones handle their own
// events first (and preventDefault themselves); this only catches the rest.
// Main also refuses the navigation (will-navigate) — this keeps it from being
// attempted at all.
for (const type of ['dragover', 'drop'] as const) {
  document.addEventListener(type, (e) => e.preventDefault())
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
