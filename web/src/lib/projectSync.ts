/**
 * Keeping a web project's files on the server.
 *
 * WEB ONLY — the desktop build owns a real folder and has no counterpart.
 *
 * Browser storage is per PROFILE: a project made in one browser does not exist
 * in another, and Safari discards it after seven unused days. Nothing on the
 * client can fix that, so the server holds the bytes and OPFS becomes a cache
 * in front of them.
 *
 * What this is NOT: moving the work. Cutting, captions, the mix and the render
 * all still happen on the user's machine. The server stores files and converts
 * codecs; it does not edit.
 *
 * Uploads are best-effort and never fail a render. A project whose files did
 * not reach the server still works perfectly on the machine that made it —
 * losing the sync means losing portability, not the work.
 */

import {
  listProjectUids,
  readFile,
  listDir,
  projectDirPath,
  projectFilePath,
  readJson,
  writeFileAtomic,
  SERVER_MANIFEST
} from '../platform/fs'
import { ApiError } from './api'
import { authedFetch, serverMessage } from './authedFetch'
import type { ApiSession } from './videosLocalApi'

/** Mirrors `_WEB_FILE_ROOTS` / `_WEB_FILE_NAMES` in `videos_local.py`. */
const SYNC_ROOTS = ['normalized', 'clips', 'highlights', 'captions', 'voiceover', 'music', 'fx']
const SYNC_NAMES = [
  'project.json',
  'final.mp4',
  'final_silent.mp4',
  'final_silent_music.mp4',
  'final_fx.mp4',
  'script.txt',
  'dub_bundle.zip',
  'final_bundle.zip',
  'capcut_bundle.zip',
  'manifest.json',
  // The ingest's record of which normalized file each source clip became.
  // `extract-proxy` reads it, so without it here 'ให้ AI ตัดใหม่' failed with
  // "ยังไม่ได้นำเข้าคลิป" on any project opened in a second browser.
  'upload_sources.json',
  'edit_script.json',
  'timeline.json',
  'effects.json'
]

export interface ServerFile {
  path: string
  bytes: number
}

/**
 * What the server already holds for this project.
 *
 * The answer is CACHED into the local store as `.server_manifest.json`. The
 * engine has no session and cannot ask the server anything, but several jobs
 * need to know what a project contains — and on a project opened in a second
 * browser, a listing of the local store answers "nothing". `listProjectDir`
 * reads this cache, which is why it is written on every successful call.
 */
export async function serverManifest(
  session: ApiSession,
  remoteUid: string,
  localUid?: string
): Promise<ServerFile[]> {
  const res = await authedFetch(session, `/videos/${remoteUid}/files`)
  if (!res.ok) throw new ApiError(res.status, 'อ่านรายการไฟล์บนเซิร์ฟเวอร์ไม่ได้')
  const files = (await res.json()) as ServerFile[]
  if (localUid) {
    try {
      await writeFileAtomic(
        projectFilePath(localUid, SERVER_MANIFEST),
        new TextEncoder().encode(JSON.stringify(files))
      )
    } catch {
      // A cache write that fails costs a listing, not correctness.
    }
  }
  return files
}

/** Every syncable file currently in the local store, with its size. */
export async function localFiles(uid: string): Promise<ServerFile[]> {
  const out: ServerFile[] = []

  const push = async (rel: string): Promise<void> => {
    const file = await readFile(projectFilePath(uid, rel))
    if (file) out.push({ path: rel, bytes: file.size })
  }

  for (const name of SYNC_NAMES) await push(name)
  for (const root of SYNC_ROOTS) {
    for (const entry of await listDir(projectFilePath(uid, root))) {
      if (entry.kind === 'file') await push(`${root}/${entry.name}`)
    }
  }
  return out
}

export interface SyncProgress {
  done: number
  total: number
  path: string
  bytes: number
}

/**
 * Files rewritten IN PLACE, which the size match below cannot see change.
 * `project.json` is rewritten by every patch, and a same-length edit (music
 * volume 0.25 → 0.35, a retyped word of the same length) kept its size — the
 * server copy another browser restores from silently stayed on the old value.
 * It is a few KB, so it is simply always sent.
 */
const REWRITTEN_IN_PLACE = new Set(['project.json'])

/**
 * Send everything the server does not already have, byte-size matched.
 *
 * Size is the whole comparison on purpose: these files are written once by an
 * atomic rename and never edited in place, so a name plus a length identifies
 * them. A checksum would mean reading every byte of every clip on every sync.
 * The exception is REWRITTEN_IN_PLACE, sent every time.
 */
export async function pushProjectFiles(
  session: ApiSession,
  uid: string,
  remoteUid: string,
  onProgress?: (p: SyncProgress) => void,
  signal?: AbortSignal
): Promise<{ uploaded: number; bytes: number; removed: number }> {
  const [local, remote] = await Promise.all([
    localFiles(uid),
    serverManifest(session, remoteUid, uid).catch(() => [] as ServerFile[])
  ])
  const have = new Map(remote.map((f) => [f.path, f.bytes]))
  const missing = local.filter(
    (f) => REWRITTEN_IN_PLACE.has(f.path) || have.get(f.path) !== f.bytes
  )

  let uploaded = 0
  let bytes = 0
  for (const entry of missing) {
    if (signal?.aborted) break
    const file = await readFile(projectFilePath(uid, entry.path))
    if (!file) continue
    const form = new FormData()
    form.append('file', file, entry.path.split('/').pop() ?? 'file')
    const res = await authedFetch(session, `/videos/${remoteUid}/files/${encodePath(entry.path)}`, {
      method: 'PUT',
      body: form,
      signal
    })
    if (!res.ok) {
      // The server's own message, not a status code. 507 is "พื้นที่เก็บเต็ม"
      // and names the numbers; 413 names the size limit. Both used to be
      // swallowed into a generic failure the caller then ignored, so a project
      // stopped halfway through syncing with nothing on screen to say so.
      throw new ApiError(res.status, await serverMessage(res, `อัปโหลด ${entry.path} ไม่สำเร็จ`))
    }
    uploaded += 1
    bytes += entry.bytes
    onProgress?.({ done: uploaded, total: missing.length, path: entry.path, bytes: entry.bytes })
  }

  const removed = await dropStaleFiles(session, remoteUid, local, remote, signal)
  return { uploaded, bytes, removed }
}

/**
 * Delete server files a re-render has orphaned.
 *
 * A cut with five scenes leaves `clips/clip_001..005.mp4`. Re-cut to three and
 * the render writes 001–003 — 004 and 005 are now stale, and an upload-only
 * sync would keep paying for them forever.
 *
 * The rule is narrow ON PURPOSE. Only per-render directories are swept, and
 * only when the local store HAS files under that directory: on a project
 * restored from the server the local store is nearly empty, and a plain mirror
 * would read that as "delete everything". Absence of a local copy is not
 * evidence that a file is stale.
 */
// Every per-render/per-edit root. Roots that were synced but never swept
// (music, voiceover, captions, fx) accumulated on the server forever -- a
// music track swap changes the filename, so the old object never matched a
// local file again, was never deleted, and kept counting against the plan
// quota with no UI able to reach it. The `localHere.size === 0` guard below
// keeps a restored project from reading its empty cache as "delete it all".
const SWEEPABLE_ROOTS = ['clips', 'highlights', 'captions', 'voiceover', 'music', 'fx']

async function dropStaleFiles(
  session: ApiSession,
  remoteUid: string,
  local: ServerFile[],
  remote: ServerFile[],
  signal?: AbortSignal
): Promise<number> {
  let removed = 0
  for (const root of SWEEPABLE_ROOTS) {
    const localHere = new Set(local.filter((f) => f.path.startsWith(`${root}/`)).map((f) => f.path))
    if (localHere.size === 0) continue
    const stale = remote.filter((f) => f.path.startsWith(`${root}/`) && !localHere.has(f.path))
    for (const f of stale) {
      if (signal?.aborted) break
      const res = await authedFetch(session, `/videos/${remoteUid}/files/${encodePath(f.path)}`, {
        method: 'DELETE',
        signal
      })
      if (res.ok) removed += 1
    }
  }
  return removed
}

/** Delete one server-side file explicitly (top-level names are never swept). */
export async function deleteProjectFile(
  session: ApiSession,
  remoteUid: string,
  rel: string
): Promise<void> {
  const res = await authedFetch(session, `/videos/${remoteUid}/files/${encodePath(rel)}`, {
    method: 'DELETE'
  })
  if (!res.ok && res.status !== 404) {
    throw new ApiError(res.status, `ลบ ${rel} บนเซิร์ฟเวอร์ไม่สำเร็จ`)
  }
}

/**
 * Upload projects this browser holds that the server does not.
 *
 * The push points are all pipeline TRANSITIONS, which is right for a project
 * being worked on and useless for one that is already resting: a project that
 * reached `waiting_vo` or `done` before its transition learned to sync sits
 * there for good, complete on one machine and absent everywhere else. That is
 * exactly the state every project made before 2026-09-08 is in.
 *
 * `project.json` is the marker, because it is the file `restoreMissingProjects`
 * needs and the one every sync writes first. Its absence on the server means
 * this project has never been synced at all.
 *
 * Runs once per session, after the restore. Best-effort and serialised: a
 * back-fill is a bulk upload, and doing several at once would saturate the
 * connection the user is trying to work over.
 */
export async function backfillUnsyncedProjects(
  session: ApiSession,
  onProgress?: (name: string, done: number, total: number) => void
): Promise<number> {
  const uids = await listProjectUids()
  const pending: { uid: string; remoteUid: string }[] = []

  for (const uid of uids) {
    const project = await readJson<{ remote?: { uid?: string }; step?: string }>(
      projectFilePath(uid, 'project.json')
    )
    const remoteUid = project?.remote?.uid
    if (!remoteUid) continue
    try {
      const remote = await serverManifest(session, remoteUid, uid)
      if (!remote.some((f) => f.path === 'project.json')) {
        pending.push({ uid, remoteUid })
      }
    } catch {
      // A project whose manifest cannot be read is left alone.
    }
  }

  let done = 0
  for (const entry of pending) {
    try {
      await pushProjectFiles(session, entry.uid, entry.remoteUid)
      done += 1
      onProgress?.(entry.uid, done, pending.length)
    } catch {
      // One project that cannot be uploaded must not stop the rest.
    }
  }
  return done
}

/** Fetch one file the local store does not have. */
export async function pullProjectFile(
  session: ApiSession,
  remoteUid: string,
  rel: string,
  signal?: AbortSignal
): Promise<Blob | null> {
  const res = await authedFetch(session, `/videos/${remoteUid}/files/${encodePath(rel)}`, {
    signal
  })
  if (res.status === 404) return null
  if (!res.ok) throw new ApiError(res.status, `ดาวน์โหลด ${rel} ไม่สำเร็จ`)
  return res.blob()
}

/** Path segments are encoded, the separators are not. */
function encodePath(rel: string): string {
  return rel.split('/').map(encodeURIComponent).join('/')
}

/** The project store path, for callers that write what `pullProjectFile` returned. */
export function localPathFor(uid: string, rel: string): string {
  return projectFilePath(uid, rel)
}

export { projectDirPath }

interface RemoteProject {
  uid: string
  origin?: string | null
}

/**
 * Bring back projects this browser has never seen.
 *
 * The server knows which projects belong to the user; each one's `project.json`
 * describes it in full. Pulling just that file is enough to make the project
 * appear, with its name, mode, clips and edit script intact — the media stays
 * on the server until something asks for it, and the service worker streams it
 * from there on demand. Opening a project therefore costs one small JSON, not
 * a 300 MB download.
 *
 * Returns how many were restored. Failure is silent by design: this runs at
 * startup, and a server that cannot be reached must not stop someone editing
 * the projects already on their machine.
 *
 * `onRestored` fires after EACH project lands, so the list can grow as they
 * arrive. It used to be one update at the very end: a fresh browser showed the
 * empty "welcome" page for the whole run — two requests per project, one after
 * another, many of them waiting on S3 — and people refreshed to see their work
 * (live report 2026-09-21, production).
 */
export async function restoreMissingProjects(
  session: ApiSession,
  onRestored?: () => void
): Promise<number> {
  const remote = await listRemoteProjects(session)
  if (remote.length === 0) return 0

  const localUids = new Set(await listProjectUids())
  // Projects this browser already has, by their SERVER uid: no need to fetch
  // their project.json again just to learn they are here (every focus of the
  // tab used to re-download all of them).
  const knownRemote = new Set(
    (await window.noey.projects.list().catch(() => []))
      .map((p) => p.remote?.uid)
      .filter((u): u is string => !!u)
  )
  const todo = remote.filter((row) => row.origin === 'local' && !knownRemote.has(row.uid))
  let restored = 0

  const restoreOne = async (row: RemoteProject): Promise<void> => {
    try {
      const blob = await pullProjectFile(session, row.uid, 'project.json')
      if (!blob) return
      const text = await blob.text()
      const parsed = JSON.parse(text) as { uid?: string }
      // The record keeps its ORIGINAL local uid: every stored path is built
      // from it, so a new one would orphan the media it points at.
      if (!parsed.uid || localUids.has(parsed.uid)) return
      localUids.add(parsed.uid)
      // The manifest first, the project.json second: a project is listed the
      // moment its project.json exists, and listed without its manifest every
      // engine listing reports it as empty.
      await serverManifest(session, row.uid, parsed.uid).catch(() => [])
      await writeFileAtomic(
        projectFilePath(parsed.uid, 'project.json'),
        new TextEncoder().encode(text)
      )
      restored += 1
      onRestored?.()
    } catch {
      // One project that cannot be restored must not stop the rest.
    }
  }

  // A few at a time instead of strictly one after another.
  const CONCURRENCY = 4
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, todo.length) }, async () => {
      while (next < todo.length) await restoreOne(todo[next++])
    })
  )
  return restored
}

/** The account's projects on the server, paged, with a short retry: a single
 * failed listing used to return 0 silently, and nothing asked again until the
 * tab regained focus a minute later. */
async function listRemoteProjects(session: ApiSession): Promise<RemoteProject[]> {
  const delaysMs = [0, 1500, 4000]
  for (const delay of delaysMs) {
    if (delay) await new Promise((r) => window.setTimeout(r, delay))
    try {
      // Paged: the server caps a single response, and reading only the first
      // page silently hid every older project from a fresh browser -- which
      // reads as data loss to the person looking for their work.
      const remote: RemoteProject[] = []
      const pageSize = 200
      for (let offset = 0; offset < 5000; offset += pageSize) {
        const res = await authedFetch(session, `/videos?limit=${pageSize}&offset=${offset}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const page = (await res.json()) as RemoteProject[]
        remote.push(...page)
        if (page.length < pageSize) break
      }
      return remote
    } catch {
      // try again after the next delay
    }
  }
  return []
}
