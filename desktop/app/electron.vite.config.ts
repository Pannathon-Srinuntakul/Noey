import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * A local API for `electron-vite dev` only. These used to sit in the renderer
 * CSP of every build, so the packaged app's own policy allowed connections to
 * whatever was listening on the user's port 8000 — an origin nothing in
 * production needs. Mirrors `cspBackendOrigin` in web/vite.config.ts.
 */
export const DEV_ORIGINS = 'http://127.0.0.1:8000 http://localhost:8000'

export function cspDevOrigins(): Plugin {
  let serving = false
  return {
    name: 'noey-csp-dev-origins',
    configResolved(config) {
      serving = config.command === 'serve'
    },
    transformIndexHtml(html) {
      return html.replaceAll('%DEV_ORIGINS%', serving ? DEV_ORIGINS : '')
    }
  }
}

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss(), cspDevOrigins()]
  }
})
