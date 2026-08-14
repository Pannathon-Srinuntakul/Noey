import { join, normalize, sep } from 'path'

/**
 * Resolve a media:// URL to an absolute path, or null when the URL is
 * malformed, outside the scheme, or attempts path traversal.
 *
 * Two hosts:
 *   media://project/<uid>/<relative/path/inside/project>  → under `root`
 *   media://inbox/<file>                                  → under `inboxDir`
 *
 * The inbox host exists so the wizard can draw a thumbnail for a clip that
 * arrived over LAN: those have no `File` object (they were never picked
 * through an input), and without a URL the renderer cannot decode a frame at
 * all. Names there are server-generated (`<uuid>.<ext>`, see lanReceive), so a
 * single path segment is all that is ever needed — and all that is allowed.
 *
 * (electron-free so it can be unit-tested)
 */
export function mediaPathForUrl(url: string, root: string, inboxDir?: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'media:') return null
  const rel = decodeURIComponent(parsed.pathname).replace(/^\/+/, '')

  if (parsed.host === 'inbox') {
    if (!inboxDir || !rel || rel.includes('/') || rel.includes('\\')) return null
    return contained(inboxDir, join(inboxDir, rel))
  }

  if (parsed.host !== 'project') return null
  const [uid, ...rest] = rel.split('/')
  if (!uid || uid === '.' || uid === '..' || rest.length === 0) return null
  return contained(join(root, uid), join(root, uid, rest.join('/')))
}

/** `abs` normalized, or null when it escapes `dir` (blocks encoded traversal). */
function contained(dir: string, abs: string): string | null {
  const normalized = normalize(abs)
  const dirWithSep = normalize(dir) + sep
  return normalized.startsWith(dirWithSep) ? normalized : null
}
