import { resolve } from 'path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/** The API this build talks to. Baked in — users never see or set it. */
const BACKEND_URL = process.env.VITE_BACKEND_URL ?? 'https://noey-api-production.up.railway.app'
/**
 * Where presigned uploads go (lib/directUpload.ts): the bucket's own origin,
 * `https://<bucket>.<endpoint host>` — `scripts/set_bucket_cors.py` prints it.
 * Empty means no direct uploads: the CSP names no bucket, the browser's PUT is
 * blocked, and the client falls back to the API route. Set it on the deploy
 * that has a bucket; it is a build-time value like the API URL.
 */
const UPLOAD_ORIGIN = (process.env.VITE_UPLOAD_ORIGIN ?? '').trim()
/**
 * Error monitoring (src/lib/monitoring.ts) — optional, build-time. The browser
 * SDK POSTs events to the host inside the DSN, so connect-src must name that
 * origin; with no DSN the CSP names nothing and the SDK is never loaded. A
 * DSN is public by design (it can submit events, never read them).
 */
const SENTRY_DSN = (process.env.VITE_SENTRY_DSN ?? '').trim()
const SENTRY_ENVIRONMENT = (process.env.VITE_SENTRY_ENVIRONMENT ?? '').trim()
const SENTRY_RELEASE = (process.env.VITE_SENTRY_RELEASE ?? '').trim()
/**
 * Cloudflare Turnstile (src/lib/turnstile.ts) — optional, build-time, public.
 * Set, the login screen can show the bot check a Google sign-UP needs while
 * the API has TURNSTILE_SECRET_KEY, and the CSP allows Cloudflare's script and
 * iframe. Unset, the CSP names no third party and no widget ever appears.
 */
const TURNSTILE_SITE_KEY = (process.env.VITE_TURNSTILE_SITE_KEY ?? '').trim()
const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com'

/** The DSN's ingest origin (`https://o<org>.ingest.<region>.sentry.io`), or ''. */
function sentryIngestOrigin(dsn: string): string {
  if (!dsn) return ''
  try {
    const u = new URL(dsn)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return ''
    return u.origin
  } catch {
    // A malformed DSN must not break the build; monitoring.ts refuses it too.
    return ''
  }
}

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
/**
 * A local API for `vite dev` only. These used to be baked into every build,
 * so the production page's own policy allowed connections to whatever was
 * listening on the viewer's port 8000 — an origin nothing in production ever
 * needs, and one that widens what an injected script could talk to.
 */
const DEV_ORIGINS = 'http://127.0.0.1:8000 http://localhost:8000'

function cspBackendOrigin(): Plugin {
  let serving = false
  return {
    name: 'noey-csp-backend-origin',
    configResolved(config) {
      serving = config.command === 'serve'
    },
    transformIndexHtml(html) {
      return html
        .replaceAll('%BACKEND_ORIGIN%', new URL(BACKEND_URL).origin)
        .replaceAll('%UPLOAD_ORIGIN%', UPLOAD_ORIGIN ? new URL(UPLOAD_ORIGIN).origin : '')
        .replaceAll('%DEV_ORIGINS%', serving ? DEV_ORIGINS : '')
        .replaceAll('%SENTRY_ORIGIN%', sentryIngestOrigin(SENTRY_DSN))
        .replaceAll('%TURNSTILE_ORIGIN%', TURNSTILE_SITE_KEY ? TURNSTILE_ORIGIN : '')
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
  define: {
    'import.meta.env.VITE_BACKEND_URL': JSON.stringify(BACKEND_URL),
    'import.meta.env.VITE_SENTRY_DSN': JSON.stringify(SENTRY_DSN),
    'import.meta.env.VITE_SENTRY_ENVIRONMENT': JSON.stringify(SENTRY_ENVIRONMENT),
    'import.meta.env.VITE_SENTRY_RELEASE': JSON.stringify(SENTRY_RELEASE),
    'import.meta.env.VITE_TURNSTILE_SITE_KEY': JSON.stringify(TURNSTILE_SITE_KEY)
  },
  server: { port: 5174 },
  worker: { format: 'es' }
})
