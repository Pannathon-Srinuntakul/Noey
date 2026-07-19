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

/**
 * Resolve a media://library/<relative/path> URL to an absolute path under the
 * effects-library root, or null when malformed or attempting traversal.
 * Serves the global asset library (sticker files, generated-component preview
 * clips) to the renderer — same containment rules as the project variant.
 */
export function libraryPathForUrl(url: string, libraryRoot: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'media:' || parsed.host !== 'library') return null
  const rel = decodeURIComponent(parsed.pathname).replace(/^\/+/, '')
  if (!rel) return null
  const abs = normalize(join(libraryRoot, rel))
  const rootWithSep = normalize(libraryRoot) + sep
  if (!abs.startsWith(rootWithSep)) return null
  return abs
}
