/**
 * Storage quota: ask before a big write, and explain when one fails anyway.
 *
 * OPFS lives inside the origin's quota, and a write that crosses it fails
 * with a `QuotaExceededError` — from the browser, with the browser's words,
 * halfway through an import or a render. Two things make that survivable:
 *
 *   - `ensureRoomFor` is asked BEFORE the bytes move, with the size the caller
 *     already knows (the picked file's), so the refusal comes as a sentence
 *     at the start rather than a stack trace at the end;
 *   - `describeStorageError` turns the browser's error into the same kind of
 *     sentence when the estimate was wrong or nobody asked.
 *
 * `navigator.storage.estimate()` is an ESTIMATE: Chrome rounds it, Safari
 * caps it per-site far below the disk, and Firefox counts differently. The
 * check keeps a margin (twice the bytes) rather than trusting it to the byte.
 */

export class StorageFullError extends Error {
  readonly name = 'StorageFullError'
  constructor(
    message: string,
    readonly usage: number,
    readonly quota: number,
    readonly needed: number
  ) {
    super(message)
  }
}

/** How much headroom a write needs beyond its own size (staged copy + output). */
const MARGIN = 2

const GB = 1024 ** 3

/** `1.5 GB` / `640 MB`, for a sentence. */
export function fmtBytes(n: number): string {
  if (n >= GB) return `${(n / GB).toFixed(1)} GB`
  return `${Math.max(1, Math.round(n / 1024 ** 2))} MB`
}

/** What the user can do about it. Shared by both messages so they read the same. */
const WHAT_TO_DO = 'ลบโปรเจกต์เก่าในหน้าโปรเจกต์ หรือกด "ล้างสำเนา" ในตั้งค่า แล้วลองใหม่'

/**
 * The browser's current figures, or null where it will not say (an old
 * Safari, a private window, a blocked API). Never throws: this is a
 * pre-flight, and an unanswerable question must not stop the work itself.
 */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const est = await navigator.storage?.estimate?.()
    if (!est || typeof est.quota !== 'number' || est.quota <= 0) return null
    return { usage: est.usage ?? 0, quota: est.quota }
  } catch {
    return null
  }
}

/**
 * Throw `StorageFullError` when `bytes` (with margin) will not fit.
 *
 * Silent when the browser gives no estimate — a refusal on a guess would
 * block imports on exactly the browsers that report nothing.
 */
export async function ensureRoomFor(bytes: number): Promise<void> {
  if (!(bytes > 0)) return
  const est = await storageEstimate()
  if (!est) return
  const needed = bytes * MARGIN
  if (est.usage + needed <= est.quota) return
  const free = Math.max(0, est.quota - est.usage)
  throw new StorageFullError(
    `พื้นที่เก็บไฟล์ของเบราว์เซอร์ไม่พอ — ต้องการอีกประมาณ ${fmtBytes(needed)} ` +
      `แต่เหลือ ${fmtBytes(free)} (ใช้ไป ${fmtBytes(est.usage)} จาก ${fmtBytes(est.quota)}) — ${WHAT_TO_DO}`,
    est.usage,
    est.quota,
    needed
  )
}

/**
 * Is this the browser saying the store is full?
 *
 * Chrome and Firefox throw a `DOMException` named `QuotaExceededError`. Safari
 * has used that name, the legacy `QUOTA_EXCEEDED_ERR` code (22), and — from a
 * sync access handle in the worker — a plain error whose text names the
 * quota. The worker client re-throws its errors as `Error(message)`, so the
 * name is lost by then and the text is what is left to match on.
 */
export function isStorageFullError(err: unknown): boolean {
  if (err instanceof StorageFullError) return true
  if (!err || typeof err !== 'object') return false
  const e = err as { name?: unknown; code?: unknown; message?: unknown }
  if (e.name === 'QuotaExceededError' || e.name === 'QUOTA_EXCEEDED_ERR') return true
  if (typeof DOMException !== 'undefined' && err instanceof DOMException && e.code === 22)
    return true
  const text = typeof e.message === 'string' ? e.message : ''
  return /quota[_ ]?exceeded|QuotaExceededError|exceeded the quota|not enough space/i.test(text)
}

/**
 * A Thai sentence for a storage failure, or null when `err` is something
 * else. The pipeline's error path shows whatever this returns in place of the
 * raw message.
 */
export function describeStorageError(err: unknown): string | null {
  if (err instanceof StorageFullError) return err.message
  if (!isStorageFullError(err)) return null
  return `พื้นที่เก็บไฟล์ของเบราว์เซอร์เต็ม บันทึกไฟล์ต่อไม่ได้ — ${WHAT_TO_DO}`
}
