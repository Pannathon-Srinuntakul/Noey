/**
 * Page-lifecycle trace — what the browser did to this tab, on the record.
 *
 * A render that "stops" on a phone has three possible causes and they are
 * indistinguishable from the outside:
 *
 *   1. iOS suspended or DISCARDED the tab (memory pressure, switching apps,
 *      the screen locking). JavaScript stops mid-instruction, and the page is
 *      re-created from scratch when you come back.
 *   2. The job threw and the error went somewhere quiet.
 *   3. The job is still nominally running and simply stopped making progress —
 *      a stalled decoder, a promise that never settles.
 *
 * The log distinguishes them, but only if the browser's own actions are IN it,
 * and only if it survives the page (see `platform/misc.ts`, which persists it):
 *
 *   boot        the page started. A boot line in the middle of a render is
 *               case 1 — nothing else re-creates the page.
 *   hidden      the tab went to the background. On iOS this is where a render
 *               is throttled to a stop; it is normal, not a defect.
 *   frozen      the browser froze the page outright.
 *   pagehide    the last thing iOS delivers before suspending or discarding.
 *   resumed     the page came back from frozen/bfcache.
 *
 * None of this changes behaviour — it only records. Installed once from
 * `main.tsx`, before the app mounts, so a crash during the first render is
 * still bracketed by a boot line.
 */

/** Milliseconds the tab spent hidden, so "gone for 3 minutes" is legible. */
let hiddenAt: number | null = null

function write(message: string): void {
  void window.noey.log.write('lifecycle', message)
}

export function installLifecycleTrace(): void {
  // Every boot, with enough to tell one device's session from another's.
  write(
    `boot · ${navigator.userAgent} · ${window.innerWidth}x${window.innerHeight} · ` +
      // Standalone means it was launched from the home screen. Worth recording
      // because the two modes get different treatment from iOS.
      `standalone=${window.matchMedia('(display-mode: standalone)').matches}`
  )

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now()
      write('hidden')
    } else {
      const away = hiddenAt ? Math.round((Date.now() - hiddenAt) / 1000) : null
      hiddenAt = null
      write(`visible${away === null ? '' : ` · away ${away}s`}`)
    }
  })

  // `pagehide` fires where `beforeunload`/`unload` do not on iOS. `persisted`
  // says whether the page went into the back/forward cache (recoverable) or is
  // being torn down (not).
  window.addEventListener('pagehide', (e) => {
    write(`pagehide · persisted=${e.persisted}`)
  })

  // Chromium-only today, but free to listen for and unambiguous when it fires.
  window.addEventListener('freeze', () => write('frozen'))
  window.addEventListener('resume', () => write('resumed'))
}
