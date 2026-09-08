/**
 * The small corners of the bridge: auth store, preferences, logging,
 * notifications, the unsaved-work guard, and the taste log.
 *
 * Nothing here is interesting on its own; what matters is that every function
 * returns the SAME SHAPE the desktop one does. Two of them in particular are
 * load-bearing:
 *
 *   - `app.onCloseRequested` and `notify.onActivated` must return a real
 *     unsubscribe. `unsavedGuard.tsx` uses the return value directly as an
 *     effect cleanup, so handing back `undefined` crashes every editor screen.
 *   - `auth.load` must resolve to `null` (not throw) on a first visit.
 */

import type { Prefs, StoredAuth, TasteEvent } from './types'

// ── auth ─────────────────────────────────────────────────────────────────────
// The desktop encrypts this with the OS keychain. A browser has no equivalent;
// localStorage is the honest option, and the tokens are short-lived (30 min
// access, 14 day refresh) and scoped to this origin.
const AUTH_KEY = 'noey.auth'

export const auth = {
  save: async (value: StoredAuth): Promise<void> => {
    localStorage.setItem(AUTH_KEY, JSON.stringify(value))
  },
  load: async (): Promise<StoredAuth | null> => {
    const raw = localStorage.getItem(AUTH_KEY)
    if (!raw) return null
    try {
      return JSON.parse(raw) as StoredAuth
    } catch {
      return null
    }
  },
  clear: async (): Promise<void> => {
    localStorage.removeItem(AUTH_KEY)
  }
}

// ── prefs ────────────────────────────────────────────────────────────────────
const PREFS_KEY = 'noey.prefs'

const PREFS_DEFAULT: Prefs = {
  projectsDir: null,
  defaultMode: 'silence',
  defaultDuration: '',
  defaultCaptions: true,
  notifications: true
}

function loadPrefs(): Prefs {
  const raw = localStorage.getItem(PREFS_KEY)
  if (!raw) return { ...PREFS_DEFAULT }
  try {
    // Merge rather than replace, so a key added later gets its default.
    return { ...PREFS_DEFAULT, ...(JSON.parse(raw) as Partial<Prefs>) }
  } catch {
    return { ...PREFS_DEFAULT }
  }
}

export const prefs = {
  get: async (): Promise<Prefs> => loadPrefs(),
  set: async (patch: Partial<Prefs>): Promise<Prefs> => {
    const next = { ...loadPrefs(), ...patch }
    localStorage.setItem(PREFS_KEY, JSON.stringify(next))
    return next
  }
}

// ── log ──────────────────────────────────────────────────────────────────────
// The desktop writes to userData/logs/app.log. Here it goes to the console plus
// a small ring buffer, so a bug report can still carry recent history.
const LOG_MAX = 500
const ring: string[] = []

export const log = {
  write: async (scope: string, message: string): Promise<void> => {
    const line = `${new Date().toISOString()} [${scope}] ${message}`
    ring.push(line)
    if (ring.length > LOG_MAX) ring.shift()

    console.debug(line)
  },
  openFolder: async (): Promise<void> => {
    // No folder to open. Dump what we have so it can be copied out.

    console.log(ring.join('\n'))
  }
}

/** Recent log lines, for a diagnostics view. */
export function recentLogLines(): string[] {
  return [...ring]
}

// ── notifications ────────────────────────────────────────────────────────────
type NotifyHandler = (projectUid: string) => void
const notifyHandlers = new Set<NotifyHandler>()

export const notify = {
  show: async (opts: { title: string; body: string; projectUid?: string }): Promise<boolean> => {
    if (!loadPrefs().notifications) return false
    if (document.visibilityState === 'visible') return false
    if (!('Notification' in window)) return false
    let permission = Notification.permission
    if (permission === 'default') permission = await Notification.requestPermission()
    if (permission !== 'granted') return false
    const n = new Notification(opts.title, { body: opts.body })
    n.onclick = () => {
      window.focus()
      if (opts.projectUid) for (const h of notifyHandlers) h(opts.projectUid)
      n.close()
    }
    return true
  },
  onActivated: (cb: NotifyHandler): (() => void) => {
    notifyHandlers.add(cb)
    return () => notifyHandlers.delete(cb)
  }
}

// ── unsaved-work guard ───────────────────────────────────────────────────────
// Desktop asks the main process to intercept the window close and then calls
// back. A browser can only ask `beforeunload` to show its own generic prompt,
// which is enough: the point is that closing mid-render is not silent.
let unsavedReason: string | null = null

function beforeUnload(e: BeforeUnloadEvent): void {
  if (!unsavedReason) return
  e.preventDefault()
  e.returnValue = ''
}

export const app = {
  setUnsaved: async (reason: string | null): Promise<void> => {
    const had = unsavedReason !== null
    unsavedReason = reason
    if (reason && !had) window.addEventListener('beforeunload', beforeUnload)
    if (!reason && had) window.removeEventListener('beforeunload', beforeUnload)
  },
  /**
   * Never fires here — the browser owns the close prompt — but it MUST return a
   * working unsubscribe, because the caller uses it as an effect cleanup.
   */
  onCloseRequested: (_cb: (why: string) => void): (() => void) => {
    return () => undefined
  },
  allowClose: async (): Promise<void> => {
    unsavedReason = null
    window.removeEventListener('beforeunload', beforeUnload)
  },
  cancelClose: async (): Promise<void> => undefined
}

// ── taste log ────────────────────────────────────────────────────────────────
// Collection-only on desktop, never fed to a prompt. Kept local here too.
const TASTE_KEY = 'noey.taste'

export const taste = {
  append: async (event: TasteEvent): Promise<void> => {
    try {
      const raw = localStorage.getItem(TASTE_KEY)
      const rows: unknown[] = raw ? JSON.parse(raw) : []
      rows.push({ v: 1, at: new Date().toISOString(), ...event })
      localStorage.setItem(TASTE_KEY, JSON.stringify(rows.slice(-500)))
    } catch {
      // Failures are silent by design — this must never interrupt an edit.
    }
  }
}
