import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { preloadThaiFonts } from './lib/preloadThaiFonts'

// Start TTF fetch/register before any effects Player mounts so layoutText
// measures Noey* faces at weight 800 (same as Remotion bake), not system sans.
void preloadThaiFonts().catch((err) => {
  console.error('[thai-fonts] preload failed', err)
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
