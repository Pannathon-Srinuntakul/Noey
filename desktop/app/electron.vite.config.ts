import { cpSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { join, resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/** Mirror node-sidecar Thai TTFs into the RENDERER public dir.
 * electron-vite's renderer root is `src/renderer`, so static files must live at
 * `src/renderer/public/fonts` — NOT `app/public/fonts` (that path is ignored and
 * `/fonts/*.ttf` falls through to index.html, which broke live ≠ bake metrics). */
function syncFxFonts(): void {
  const src = resolve('../node-sidecar/public/fonts')
  const dest = resolve('src/renderer/public/fonts')
  if (!existsSync(src)) return
  mkdirSync(dest, { recursive: true })
  for (const name of readdirSync(src)) {
    if (!name.endsWith('.ttf') && !name.endsWith('.txt')) continue
    cpSync(join(src, name), join(dest, name))
  }
}
syncFxFonts()

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        // Real Remotion overlay registry (node-sidecar owns the implementations;
        // the renderer imports them for the live <Player> preview + catalog).
        '@fx': resolve('../node-sidecar/src/compositions'),
        // Bundled TTFs for ?url imports (primary live-preview font source).
        '@fx-fonts': resolve('../node-sidecar/public/fonts')
      },
      // The @fx files live outside the app root, so their remotion/react
      // imports would otherwise resolve from node-sidecar/node_modules — a
      // SECOND React copy at runtime, which kills every hook inside the
      // Player ("Invalid hook call", blank overlay). Force one copy.
      dedupe: [
        'react',
        'react-dom',
        'remotion',
        '@remotion/player',
        '@remotion/shapes',
        '@remotion/lottie',
        '@remotion/light-leaks',
        '@remotion/layout-utils',
        '@remotion/fonts'
      ]
    },
    server: {
      fs: {
        // Allow dev-server reads outside the app root (the node-sidecar sources).
        allow: [resolve('..')]
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
