import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve } from 'path'
import { isSafeUid } from './uid'

/**
 * Checks the main process applies to what the renderer asks it to do.
 *
 * The renderer is the least trusted process in the app: it renders remote
 * data, and anything that ever gets script into it can call every IPC handler
 * the preload exposes. The main process has no CSP and full disk access, so
 * each privileged handler narrows its input here instead of trusting the
 * caller. (electron-free so it can be unit-tested)
 */

/** Same fallback the renderer bakes in (`App.tsx` BACKEND_URL). */
export const DEFAULT_BACKEND_URL = 'https://noey-api-production.up.railway.app'

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

/**
 * `api:fetch` may only talk to the API this build was made for. `allowLocalDev`
 * (an unpackaged dev run) also admits a plain-http API on the loopback host.
 */
export function isAllowedApiUrl(url: string, backendUrl: string, allowLocalDev: boolean): boolean {
  const target = parse(url)
  const backend = parse(backendUrl)
  if (!target || !backend) return false
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return false
  if (target.username || target.password) return false
  if (target.origin === backend.origin) return true
  return (
    allowLocalDev &&
    target.protocol === 'http:' &&
    (target.hostname === 'localhost' || target.hostname === '127.0.0.1')
  )
}

/** Hosts `window.open` may hand to the OS: the payment pages the backend
 * returns for a top-up or plan change. */
export const EXTERNAL_HOSTS: ReadonlySet<string> = new Set([
  'checkout.stripe.com',
  'billing.stripe.com'
])

/** True only for an https URL on an allow-listed host — never `file:`, a UNC
 * path or an OS protocol handler (`ms-msdt:`, `search-ms:` …). */
export function isAllowedExternalUrl(url: string): boolean {
  const u = parse(url)
  if (!u || u.protocol !== 'https:' || u.username || u.password) return false
  return EXTERNAL_HOSTS.has(u.hostname.toLowerCase())
}

/**
 * Whether the main window may navigate to `target`. Only the app's own page
 * is allowed: a dropped `.html` file (or a link) would otherwise replace the
 * app in the same webContents, and the preload bridge attaches to it.
 *
 * A `file:` app URL admits exactly that file (any hash/query — in-app routes);
 * an http dev-server URL admits its own origin (HMR reloads).
 */
export function isAppNavigation(target: string, appUrl: string): boolean {
  const t = parse(target)
  const app = parse(appUrl)
  if (!t || !app) return false
  if (app.protocol === 'file:') {
    return t.protocol === 'file:' && t.host === app.host && t.pathname === app.pathname
  }
  return t.origin === app.origin
}

/** Path-case-insensitive filesystems (Windows) compare paths case-folded. */
function key(p: string, caseInsensitive: boolean): string {
  const n = normalize(resolve(p))
  return caseInsensitive ? n.toLowerCase() : n
}

/** `target` resolves strictly inside `dir` (not `dir` itself). */
export function isInside(dir: string, target: string, caseInsensitive = false): boolean {
  const rel = relative(key(dir, caseInsensitive), key(target, caseInsensitive))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Files the user handed the app on purpose (file input / drop, resolved via
 * `webUtils.getPathForFile` in the preload). A path the renderer merely names
 * is not in here. Insertion-ordered and capped so a persisted copy stays small.
 */
export class FileGrants {
  private readonly paths: Map<string, string> = new Map()

  constructor(
    private readonly caseInsensitive = false,
    private readonly max = 500
  ) {}

  add(path: string): boolean {
    if (!path || !isAbsolute(path)) return false
    const k = key(path, this.caseInsensitive)
    this.paths.delete(k)
    this.paths.set(k, normalize(resolve(path)))
    while (this.paths.size > this.max) {
      const oldest = this.paths.keys().next().value as string
      this.paths.delete(oldest)
    }
    return true
  }

  has(path: string): boolean {
    return !!path && this.paths.has(key(path, this.caseInsensitive))
  }

  list(): string[] {
    return [...this.paths.values()]
  }
}

/**
 * A local file `api:fetch` may read and upload: inside one of `roots` (the
 * projects library, the LAN inbox) or explicitly granted by the user.
 * Returns the resolved path, or throws.
 */
export function checkReadablePath(
  path: string,
  roots: ReadonlyArray<string | null | undefined>,
  grants: FileGrants,
  caseInsensitive = false
): string {
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw new Error(`refused: not an absolute path: ${JSON.stringify(path)}`)
  }
  if (grants.has(path)) return normalize(resolve(path))
  for (const root of roots) {
    if (root && isInside(root, path, caseInsensitive)) return normalize(resolve(path))
  }
  throw new Error(`refused: path is outside the project library: ${path}`)
}

/** Extensions a music source may have — audio, or a video to take audio from. */
const MEDIA_EXTS = new Set([
  '.mp3',
  '.wav',
  '.m4a',
  '.aac',
  '.ogg',
  '.oga',
  '.opus',
  '.flac',
  '.wma',
  '.aif',
  '.aiff',
  '.mp4',
  '.m4v',
  '.mov',
  '.webm',
  '.mkv',
  '.avi',
  '.3gp'
])

export function hasMediaExtension(path: string): boolean {
  return MEDIA_EXTS.has(extname(path).toLowerCase())
}

/**
 * What `projects:openFolder` should do with `relPath` inside `dir`:
 * `'.'`/empty is the project root. A directory is opened; anything else is
 * only ever revealed in its folder — `shell.openPath` on a file EXECUTES it
 * on Windows (a `.bat` written through `projects:writeFile` would run).
 */
export function openFolderTarget(
  dir: string,
  relPath: unknown,
  isDirectory: (abs: string) => boolean
): { action: 'open' | 'reveal'; path: string } {
  const rel = typeof relPath === 'string' && relPath.trim() !== '' ? relPath : '.'
  const abs = normalize(join(dir, rel))
  if (abs !== normalize(dir) && !isInside(dir, abs)) {
    throw new Error(`path escapes project dir: ${rel}`)
  }
  return isDirectory(abs) ? { action: 'open', path: abs } : { action: 'reveal', path: abs }
}

/**
 * Narrow a sidecar job before it reaches the Python process, which trusts
 * every path it is given:
 *   - `projectDir`, when present, must be a real project directory: a safe uid
 *     directly under the projects root;
 *   - `output` (the generic render) must land inside that project, or inside
 *     the projects root when the job names no project;
 *   - `outName` (timeline render) must be a relative path inside the project.
 * Throws on anything else.
 */
export function checkSidecarJob(job: unknown, root: string, caseInsensitive = false): void {
  if (!job || typeof job !== 'object') return
  const j = job as Record<string, unknown>
  let projectDir: string | null = null
  if (j.projectDir !== undefined) {
    const pd = j.projectDir
    if (
      typeof pd !== 'string' ||
      !isAbsolute(pd) ||
      !isSafeUid(basename(normalize(pd))) ||
      key(dirname(normalize(pd)), caseInsensitive) !== key(root, caseInsensitive)
    ) {
      throw new Error(`refused: projectDir is not a project: ${JSON.stringify(pd)}`)
    }
    projectDir = normalize(pd)
  }
  if (j.output !== undefined) {
    const out = j.output
    const within = projectDir ?? root
    if (typeof out !== 'string' || !isAbsolute(out) || !isInside(within, out, caseInsensitive)) {
      throw new Error(`refused: output outside the project: ${JSON.stringify(out)}`)
    }
  }
  if (j.outName !== undefined) {
    const name = j.outName
    if (
      typeof name !== 'string' ||
      !projectDir ||
      isAbsolute(name) ||
      name.includes('\\') ||
      !isInside(projectDir, join(projectDir, name), caseInsensitive)
    ) {
      throw new Error(`refused: outName outside the project: ${JSON.stringify(name)}`)
    }
  }
}

export interface ApiFetchJobShape {
  url: string
  formFiles?: { field: string; path: string; filename?: string }[]
}

/**
 * Vet an `api:fetch` job: the URL must be the build's API, and every uploaded
 * file must be one the app owns or the user granted. `realpath` resolves
 * symlinks so a link inside the library cannot point the read elsewhere.
 * Throws on refusal; resolves with nothing when the job may run.
 */
export async function vetApiFetchJob(
  job: ApiFetchJobShape,
  opts: {
    backendUrl: string
    allowLocalDev: boolean
    roots: ReadonlyArray<string | null | undefined>
    grants: FileGrants
    realpath: (p: string) => Promise<string>
    caseInsensitive?: boolean
  }
): Promise<void> {
  if (!job || typeof job.url !== 'string') throw new Error('refused: api:fetch without a url')
  if (!isAllowedApiUrl(job.url, opts.backendUrl, opts.allowLocalDev)) {
    throw new Error(`refused: api:fetch to a host other than the API: ${job.url}`)
  }
  const ci = opts.caseInsensitive ?? false
  const realRoots = await Promise.all(
    opts.roots.filter((r): r is string => !!r).map((r) => opts.realpath(r).catch(() => r))
  )
  for (const file of job.formFiles ?? []) {
    const p = file?.path
    if (typeof p !== 'string' || !isAbsolute(p)) {
      throw new Error(`refused: not an absolute path: ${JSON.stringify(p)}`)
    }
    if (opts.grants.has(p)) continue
    const real = await opts.realpath(p)
    checkReadablePath(real, realRoots, new FileGrants(ci), ci)
  }
}
