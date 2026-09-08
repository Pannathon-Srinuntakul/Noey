/**
 * Keep the screen awake while a render is running.
 *
 * WEB ONLY. A desktop app owns its process; a browser tab does not. On a phone
 * the screen dimming is the first step towards the tab being suspended, and a
 * suspended tab stops encoding — the render simply stops, halfway, with no
 * error to show for it.
 *
 * `navigator.wakeLock` is the only lever a page has here. It is not a promise
 * that the work survives: switching apps still suspends the tab, and nothing
 * client-side changes that. What it does buy is the common case — someone
 * watching the progress bar while their phone would otherwise have locked.
 *
 * The lock is dropped the moment the work ends, and re-taken when the page
 * comes back to the foreground, because the browser releases it on hide.
 */

type WakeLockSentinel = { released: boolean; release(): Promise<void> }

let sentinel: WakeLockSentinel | null = null
let holders = 0

async function take(): Promise<void> {
  const api = (navigator as { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinel> } })
    .wakeLock
  if (!api) {
    void window.noey.log.write('wakeLock', 'not supported by this browser')
    return
  }
  if (sentinel) return
  try {
    sentinel = await api.request('screen')
    void window.noey.log.write('wakeLock', 'held')
  } catch (err) {
    // Denied, or the tab is already hidden. Not an error worth surfacing to the
    // user: the render carries on either way. It goes in the log because "did
    // the screen actually stay awake on that phone" is otherwise unanswerable.
    void window.noey.log.write('wakeLock', `refused: ${String(err)}`)
  }
}

function onVisibility(): void {
  if (document.visibilityState === 'visible' && holders > 0 && (!sentinel || sentinel.released)) {
    sentinel = null
    void take()
  }
}

/**
 * Hold the screen awake until the returned function is called.
 *
 * Reference counted: two renders at once take one lock, and it is released
 * when the last of them finishes. Always call the release — `finally` is the
 * right home for it.
 */
export function holdScreenAwake(): () => void {
  holders += 1
  if (holders === 1) {
    document.addEventListener('visibilitychange', onVisibility)
    void take()
  }
  let released = false
  return () => {
    if (released) return
    released = true
    holders -= 1
    if (holders === 0) {
      document.removeEventListener('visibilitychange', onVisibility)
      const held = sentinel
      sentinel = null
      void held?.release().catch(() => undefined)
    }
  }
}

/** Whether this browser offers the lock at all — for the storage/settings copy. */
export function wakeLockSupported(): boolean {
  return !!(navigator as { wakeLock?: unknown }).wakeLock
}
