/**
 * One tab per project while it is being edited or run.
 *
 * WEB ONLY. The desktop has one window; a browser has as many tabs as the
 * user opens, all on the same OPFS store. Two tabs on one project each held
 * their own in-memory pipeline, each wrote `project.json` (the per-tab write
 * lock in platform/projects.ts serialises writes within a tab only), and each
 * polled the same server job — so the second tab's poll finished the run a
 * second time, and a draft saved in one tab was overwritten by the other's
 * stale copy on its next patch.
 *
 * `navigator.locks` is the browser's own cross-tab mutex: held for the life
 * of the editor or the run, released when that ends, and released by the
 * browser itself if the tab dies. `ifAvailable` means the second tab is told
 * "no" at once instead of queueing behind the first for an hour.
 *
 * Within ONE tab the lock is ref-counted: the editor opening while a job is
 * running is the same holder asking twice, not a conflict.
 */

export interface ProjectLock {
  /** Give the lock back. Idempotent. */
  release: () => void
}

/** Thai message for the refusal — the toast and the OPFS error map share it. */
export const PROJECT_LOCKED_MESSAGE = 'โปรเจกต์นี้เปิดอยู่ในแท็บอื่น'

interface Held {
  count: number
  /** Resolving this ends the browser lock's callback and releases it. */
  release: () => void
}

const held = new Map<string, Held>()
/** Requests not yet answered by the browser, by uid — see acquireProjectLock. */
const requesting = new Map<string, Promise<ProjectLock | null>>()

function lockName(uid: string): string {
  return `project:${uid}`
}

/**
 * Take the project's lock, or learn that another tab has it.
 *
 * Resolves with a handle when this tab now holds (or already held) the lock,
 * and `null` when another tab does. Resolves with a no-op handle where the
 * Web Locks API is missing (an insecure context, an old WebView): nothing
 * can be guarded there, and refusing every action would be worse than the
 * race.
 */
export function acquireProjectLock(uid: string): Promise<ProjectLock | null> {
  const already = held.get(uid)
  if (already) {
    already.count += 1
    return Promise.resolve(handleFor(uid))
  }
  // Two hooks in THIS tab asking at once (the project list's host and the
  // detail page's, both booting the same project): the first request is
  // still being granted when the second arrives, so the second saw the lock
  // as taken and reported "another tab" about its own. They share the one
  // request and each get a counted handle.
  const inFlight = requesting.get(uid)
  if (inFlight) {
    return inFlight.then((lock) => {
      if (!lock) return null
      const entry = held.get(uid)
      if (entry) entry.count += 1
      return handleFor(uid)
    })
  }

  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (!locks) return Promise.resolve({ release: () => undefined })

  const request = new Promise<ProjectLock | null>((resolve) => {
    let release: () => void = () => undefined
    const untilReleased = new Promise<void>((r) => {
      release = r
    })
    locks
      .request(lockName(uid), { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(null)
          return undefined
        }
        held.set(uid, { count: 1, release })
        resolve(handleFor(uid))
        return untilReleased
      })
      .catch(() => {
        // The request itself failed (a SecurityError in a sandboxed frame).
        // Same answer as no API at all.
        held.delete(uid)
        resolve({ release: () => undefined })
      })
  })
  requesting.set(uid, request)
  void request.finally(() => requesting.delete(uid))
  return request
}

function handleFor(uid: string): ProjectLock {
  let released = false
  return {
    release: () => {
      if (released) return
      released = true
      const entry = held.get(uid)
      if (!entry) return
      entry.count -= 1
      if (entry.count > 0) return
      held.delete(uid)
      entry.release()
    }
  }
}

/** Whether THIS tab currently holds the project's lock. */
export function holdsProjectLock(uid: string): boolean {
  return held.has(uid)
}

/**
 * OPFS raises this when another tab holds a writable handle on the file
 * (`createWritable` / `createSyncAccessHandle`). It is the same situation the
 * lock guards against, surfacing a level lower, and deserves the same words.
 */
export function isCrossTabStorageError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name
  return name === 'NoModificationAllowedError'
}

/** Test hook. */
export function resetProjectLocks(): void {
  for (const entry of held.values()) entry.release()
  held.clear()
  requesting.clear()
}
