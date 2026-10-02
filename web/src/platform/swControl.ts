/**
 * Getting the page under the media service worker's control.
 *
 * Every `/media/<uid>/<rel>` URL only exists inside `public/media-sw.js`. A
 * page the worker does not control sends those requests to the app origin,
 * which answers 404 — and every card reads that as "ไม่พบไฟล์คลิป".
 *
 * A HARD reload (Cmd+Shift+R / Ctrl+F5) is exactly that page: the browser
 * loads it bypassing the worker, `ready` still resolves (the worker is
 * active), and nothing ever claims the page, because the worker's own
 * `clients.claim()` runs once, on activate. So:
 *
 *   1. ask the active worker to claim this page (`sw:claim`), and wait for
 *      `controllerchange`;
 *   2. if that does not happen, reload ONCE — an ordinary reload is always
 *      controlled — guarded by a sessionStorage flag so it can never loop;
 *   3. still nothing after that reload: carry on uncontrolled rather than
 *      hold the app hostage (media then fails the way it always did).
 */

export const RELOAD_FLAG = 'noey:sw-control-reload'

export type ControlOutcome = 'controlled' | 'reloading' | 'uncontrolled'

export interface ControlDeps {
  isControlled: () => boolean
  /** The active worker of the page's registration, if any. */
  activeWorker: () => { postMessage: (msg: unknown) => void } | null
  onControllerChange: (cb: () => void) => () => void
  getFlag: () => string | null
  setFlag: (v: string) => void
  clearFlag: () => void
  reload: () => void
  timeoutMs: number
}

export async function ensureControlled(deps: ControlDeps): Promise<ControlOutcome> {
  if (deps.isControlled()) {
    deps.clearFlag()
    return 'controlled'
  }

  await new Promise<void>((resolve) => {
    let settled = false
    let unsubscribe = (): void => undefined
    const done = (): void => {
      if (settled) return
      settled = true
      unsubscribe()
      resolve()
    }
    unsubscribe = deps.onControllerChange(done)
    // A worker installing for the first time claims on activate by itself;
    // an already-active one (the hard-reload case) only does when asked.
    try {
      deps.activeWorker()?.postMessage({ type: 'sw:claim' })
    } catch {
      // No worker to ask: the timeout settles it.
    }
    setTimeout(done, deps.timeoutMs)
  })

  if (deps.isControlled()) {
    deps.clearFlag()
    return 'controlled'
  }
  if (deps.getFlag()) return 'uncontrolled'
  deps.setFlag(String(Date.now()))
  // A flag that did not stick (storage full or refused) would let the next
  // page reload again, and the one after that: no flag, no reload.
  if (!deps.getFlag()) return 'uncontrolled'
  deps.reload()
  return 'reloading'
}

/** The browser's own implementation of `ControlDeps`, for the registration
 * `navigator.serviceWorker.ready` resolved with. */
export function browserControlDeps(
  registration: ServiceWorkerRegistration,
  timeoutMs = 3000
): ControlDeps {
  const sw = navigator.serviceWorker
  const session = (): Storage | null => {
    try {
      return window.sessionStorage
    } catch {
      return null
    }
  }
  return {
    isControlled: () => !!sw.controller,
    activeWorker: () => registration.active,
    onControllerChange: (cb) => {
      sw.addEventListener('controllerchange', cb)
      return () => sw.removeEventListener('controllerchange', cb)
    },
    getFlag: () => {
      // Storage that cannot be read or written must not become a reload
      // loop: it reports "already reloaded" and the page carries on.
      try {
        const store = session()
        return store ? store.getItem(RELOAD_FLAG) : 'blocked'
      } catch {
        return 'blocked'
      }
    },
    setFlag: (v) => {
      try {
        session()?.setItem(RELOAD_FLAG, v)
      } catch {
        // see getFlag
      }
    },
    clearFlag: () => {
      try {
        session()?.removeItem(RELOAD_FLAG)
      } catch {
        // nothing to clear
      }
    },
    reload: () => window.location.reload(),
    timeoutMs
  }
}
