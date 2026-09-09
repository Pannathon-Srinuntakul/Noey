/*
 * Plain JS on purpose, and in `public/` on purpose.
 *
 * A service worker can only control paths at or below its own URL. Served from
 * `/src/sw/media-sw.ts` it could only ever control `/src/sw/`, which is useless
 * — every `/media/...` request would go to the network and 404. Files in
 * `public/` are copied to the site root verbatim by both `vite dev` and
 * `vite build`, so this lands at `/media-sw.js` and can claim `/`.
 *
 * It has no imports, which is what makes that possible.
 */
/**
 * Serves project files out of OPFS at `/media/<uid>/<relative/path>`.
 *
 * This is the browser's stand-in for the desktop's `media://` protocol, and it
 * has to honour the same three things that file learned the hard way:
 *
 *   1. REAL RANGE SUPPORT. A `<video>` cannot seek against a plain 200; the
 *      desktop comment records that `net.fetch` on `file://` ignoring Range
 *      silently broke seeking. So a Range request gets a 206 with
 *      `Content-Range`.
 *   2. NO CACHING. A project file's URL is stable but its BYTES are not — every
 *      re-render rewrites `final.mp4` under the same name. Cached, the player
 *      happily replays the previous render and no remount key can undo it.
 *   3. A REAL 404 for a missing file. `usePreviewFile.exists()` probes with
 *      `Range: bytes=0-0` and decides purely on the status code, so a throw or
 *      an opaque response would read as "the file is there".
 *
 * `skipWaiting` + `clients.claim` are here so the very first page load is
 * already controlled; otherwise the first `<video>` of a fresh install 404s.
 */

const MEDIA_PREFIX = '/media/'

/** Same table as `main/media.ts`. `<audio>` needs an explicit type or it will
 * silently refuse to play; `.json` is here because the pipeline fetches
 * `proxy_manifest.json` through this route. */
const MIME_BY_EXT = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.srt': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.zip': 'application/zip',
  '.json': 'application/json'
}

const NO_STORE = 'no-store, no-cache, must-revalidate'

function mimeFor(name) {
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : ''
  return MIME_BY_EXT[ext] || 'application/octet-stream'
}

function parseRange(header, size) {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const [, startStr, endStr] = m
  let start = startStr ? parseInt(startStr, 10) : NaN
  let end = endStr ? parseInt(endStr, 10) : size - 1
  if (Number.isNaN(start)) {
    // Suffix form, `bytes=-500`.
    const suffix = endStr ? parseInt(endStr, 10) : 0
    start = Math.max(size - suffix, 0)
    end = size - 1
  }
  end = Math.min(end, size - 1)
  if (start > end || start < 0) return null
  return { start, end }
}

async function fileFor(pathname) {
  const rel = decodeURIComponent(pathname.slice(MEDIA_PREFIX.length))
  const parts = rel.split('/').filter(Boolean)
  // Reject traversal outright rather than resolving it.
  if (parts.length < 2 || parts.some((p) => p === '.' || p === '..')) return null
  const name = parts.pop()
  try {
    let dir = await navigator.storage.getDirectory()
    dir = await dir.getDirectoryHandle('projects')
    for (const seg of parts) dir = await dir.getDirectoryHandle(seg)
    const handle = await dir.getFileHandle(name)
    return await handle.getFile()
  } catch {
    return null
  }
}

/**
 * Where to look when a file is not in this browser's storage.
 *
 * Kept in OPFS, not in a variable. A service worker is TERMINATED whenever it
 * has been idle for a while and restarted on the next request with a blank
 * module scope — so anything the page posted in is gone, and gone silently.
 * The first fallback after that would fail with no error anywhere, which is
 * the worst kind of bug to own. A file the worker can read on demand survives
 * every restart.
 */
const STATE_FILE = 'sw-state.json'

async function readState() {
  try {
    const root = await navigator.storage.getDirectory()
    const handle = await root.getFileHandle(STATE_FILE)
    return JSON.parse(await (await handle.getFile()).text())
  } catch {
    return null
  }
}

async function writeState(state) {
  try {
    const root = await navigator.storage.getDirectory()
    const handle = await root.getFileHandle(STATE_FILE, { create: true })
    const w = await handle.createWritable()
    await w.write(new Blob([JSON.stringify(state)]))
    await w.close()
  } catch {
    // A state write that fails costs the fallback, not correctness.
  }
}

/**
 * Updates run one at a time.
 *
 * Every update is a read-modify-write of one file, and the page posts one
 * message per project in a loop. Run concurrently they all read the same old
 * state and the last write wins — measured 2026-09-08 with two projects, of
 * which exactly one survived, and the other's media then 404'd with nothing to
 * show why. Chaining them is the whole fix.
 */
let stateQueue = Promise.resolve()

function updateState(mutate) {
  stateQueue = stateQueue
    .catch(() => undefined)
    .then(async () => {
      const state = (await readState()) || { projects: {} }
      mutate(state)
      await writeState(state)
    })
  return stateQueue
}

self.addEventListener('message', (event) => {
  const data = event.data
  if (!data) return
  if (data.type === 'sw:origin') {
    event.waitUntil(
      updateState((state) => {
        state.baseUrl = data.baseUrl || null
        state.token = data.token || null
      })
    )
  } else if (data.type === 'sw:project') {
    event.waitUntil(
      updateState((state) => {
        state.projects = state.projects || {}
        if (data.remoteUid) state.projects[data.uid] = data.remoteUid
        else delete state.projects[data.uid]
      })
    )
  } else if (data.type === 'sw:projects') {
    // The page's full current list, REPLACING the stored map. Per-entry merges
    // kept an entry for every project ever deleted, forever.
    event.waitUntil(
      updateState((state) => {
        const next = {}
        for (const p of data.projects || []) {
          if (p && p.uid && p.remoteUid) next[p.uid] = p.remoteUid
        }
        state.projects = next
      })
    )
  }
})

/**
 * Ask the server for the same file, passing the Range straight through.
 *
 * Forwarding the header is the whole point: a 300 MB clip opened in a fresh
 * browser must be seekable immediately, not after a full download.
 */
async function serveFromServer(pathname, request) {
  const state = await readState()
  if (!state || !state.baseUrl || !state.token) return null

  const parts = pathname.slice(MEDIA_PREFIX.length).split('/').filter(Boolean)
  if (parts.length < 2) return null
  const [uid, ...rest] = parts
  const remoteUid = (state.projects || {})[uid]
  if (!remoteUid) return null

  const headers = { Authorization: `Bearer ${state.token}` }
  const range = request.headers.get('range')
  if (range) headers.Range = range

  try {
    const res = await fetch(
      `${state.baseUrl}/videos/${remoteUid}/files/${rest.map(encodeURIComponent).join('/')}`,
      { headers }
    )
    // A lapsed session is NOT a missing file. Returning null here made the
    // caller answer 404, and every reader of a 404 in this app says "ไม่พบไฟล์"
    // — so a token that expired half an hour into a tab's life presented as a
    // clip that had disappeared. The status is passed through so the page can
    // tell the two apart.
    if (res.status === 401 || res.status === 403) {
      return new Response('session expired', {
        status: res.status,
        headers: { 'Cache-Control': NO_STORE }
      })
    }
    if (!res.ok && res.status !== 206) return null
    // The body streams; only the caching promise is re-stated, because a
    // re-render replaces these bytes under the same URL.
    const out = new Headers(res.headers)
    out.set('Cache-Control', NO_STORE)
    out.set('Content-Type', mimeFor(pathname))
    return new Response(res.body, { status: res.status, headers: out })
  } catch {
    return null
  }
}

async function serve(request) {
  const url = new URL(request.url)
  const file = await fileFor(url.pathname)
  if (!file) {
    const fromServer = await serveFromServer(url.pathname, request)
    if (fromServer) return fromServer
    return new Response('not found', { status: 404 })
  }

  // A zero-byte file is a write that never finished (the atomic rename means
  // this should not happen, but the answer must still not be "yes, it
  // exists") — a 200 here made the preview probe trust an empty clip.
  if (file.size === 0) {
    return new Response('not found', { status: 404 })
  }

  const contentType = mimeFor(url.pathname)
  const range = parseRange(request.headers.get('range'), file.size)

  if (!range) {
    return new Response(file, {
      status: 200,
      headers: {
        'Content-Length': String(file.size),
        'Accept-Ranges': 'bytes',
        'Cache-Control': NO_STORE,
        'Content-Type': contentType
      }
    })
  }

  const { start, end } = range
  return new Response(file.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Range': `bytes ${start}-${end}/${file.size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
      'Cache-Control': NO_STORE,
      'Content-Type': contentType
    }
  })
}

self.addEventListener('install', () => {
  void self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin) return
  if (!url.pathname.startsWith(MEDIA_PREFIX)) return
  event.respondWith(serve(event.request))
})
