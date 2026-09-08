import { resolve } from 'path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/** The API this build talks to. Baked in — users never see or set it. */
const BACKEND_URL = process.env.VITE_BACKEND_URL ?? 'https://noey-api-production.up.railway.app'

/**
 * Put the backend's ORIGIN into the page's CSP.
 *
 * The connect-src list has to name the API explicitly (the browser talks to it
 * directly, with no main process in between), and Vite does not substitute env
 * into index.html. So the origin was hard-coded — and pointing the build at any
 * other API produced a page that was blocked by its own policy before a request
 * left it, with nothing in the UI to say why. VITE_BACKEND_URL now moves both
 * at once, which is the only way the two can stay in agreement.
 */
function cspBackendOrigin(): Plugin {
  return {
    name: 'noey-csp-backend-origin',
    transformIndexHtml(html) {
      return html.replaceAll('%BACKEND_ORIGIN%', new URL(BACKEND_URL).origin)
    }
  }
}

/**
 * Mirrors the `renderer` section of `desktop/app/electron.vite.config.ts` — same
 * alias, same two plugins — so the copied UI builds here without edits.
 */
export default defineConfig({
  resolve: { alias: { '@renderer': resolve(__dirname, 'src') } },
  plugins: [react(), tailwindcss(), cspBackendOrigin()],
  define: { 'import.meta.env.VITE_BACKEND_URL': JSON.stringify(BACKEND_URL) },
  server: { port: 5174 },
  worker: { format: 'es' }
})
