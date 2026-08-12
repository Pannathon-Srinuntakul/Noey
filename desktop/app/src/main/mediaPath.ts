import { join, normalize, sep } from 'path'

/**
 * Resolve a media:// URL to an absolute path under `root`, or null when the
 * URL is malformed, outside the scheme, or attempts path traversal.
 *
 * URL shape: media://project/<uid>/<relative/path/inside/project>
 * (electron-free so it can be unit-tested)
 */
export function mediaPathForUrl(url: string, root: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'media:' || parsed.host !== 'project') return null
  const rel = decodeURIComponent(parsed.pathname).replace(/^\/+/, '')
  const [uid, ...rest] = rel.split('/')
  if (!uid || uid === '.' || uid === '..' || rest.length === 0) return null
  const abs = normalize(join(root, uid, rest.join('/')))
  // Must stay inside the project's own directory (blocks encoded traversal).
  const projectRootWithSep = normalize(join(root, uid)) + sep
  if (!abs.startsWith(projectRootWithSep)) return null
  return abs
}
