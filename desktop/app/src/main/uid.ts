/** True only for a plain single-segment project id (UUID-like): letters,
 *  digits, dash, underscore, 1–128 chars. Everything else — "", "..", "/",
 *  "\", "C:\...", spaces, path traversal — is rejected, so a bad/hostile uid
 *  can never make a project path resolve outside the projects root.
 *  (electron-free so it can be unit-tested) */
export function isSafeUid(uid: unknown): uid is string {
  return (
    typeof uid === 'string' && uid.length > 0 && uid.length <= 128 && /^[A-Za-z0-9_-]+$/.test(uid)
  )
}
