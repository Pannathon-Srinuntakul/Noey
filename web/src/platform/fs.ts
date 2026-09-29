/**
 * The web build's filesystem: OPFS (Origin Private File System).
 *
 * The desktop app hands the UI real OS paths (`C:\Users\...\projects\<uid>\...`)
 * and serves them back through a privileged `media://` protocol. A browser has
 * neither, so this module provides the same two things on top of
 * `navigator.storage.getDirectory()`:
 *
 *   - a VIRTUAL path scheme, `noeyfs://projects/<uid>/<relative/path>`, that the
 *     copied UI can carry around exactly where it used to carry an OS path, and
 *   - read/write/delete/list primitives the render engine and the service worker
 *     both use.
 *
 * The virtual scheme matters more than it looks: the UI persists some of these
 * strings into `project.json` (`voiceoverPath`, most notably) and later hands
 * them straight back to `probe` and to the render jobs. Making them opaque
 * strings that only this module can interpret keeps every one of those call
 * sites working untouched.
 *
 * OPFS is a real filesystem per origin: private to this site, not visible to
 * the user's file manager, and not uploaded anywhere. Source video therefore
 * stays on the viewer's machine, which is the same promise the desktop app
 * makes.
 */

import type { MuxChunk } from './opfsWrite'

/** Scheme for a file inside the project store. */
export const FS_SCHEME = 'noeyfs://'

const PROJECTS_ROOT = 'projects'

/** Files the picker handed us that are not in the store yet — see picked.ts. */
export const PICKED_SCHEME = 'picked://'

export function isFsPath(p: string): boolean {
  return p.startsWith(FS_SCHEME)
}

export function isPickedPath(p: string): boolean {
  return p.startsWith(PICKED_SCHEME)
}

/** `noeyfs://projects/<uid>` — what `projects.dir(uid)` returns. */
export function projectDirPath(uid: string): string {
  return `${FS_SCHEME}${PROJECTS_ROOT}/${uid}`
}

/** `noeyfs://projects/<uid>/<rel>` — what `projects.resolvePath` returns. */
export function projectFilePath(uid: string, rel: string): string {
  return `${projectDirPath(uid)}/${normalizeRel(rel)}`
}

/**
 * Split a virtual path into OPFS directory segments plus a file name.
 *
 * Throws on anything that escapes the store. The desktop side does the same
 * check (`resolveProjectPath` asserts containment); here it also stops a
 * `..` in a project-relative path from reaching another project's directory.
 */
export function splitFsPath(path: string): { segments: string[]; name: string } {
  if (!isFsPath(path)) throw new Error(`not a project path: ${path}`)
  const parts = path
    .slice(FS_SCHEME.length)
    .split('/')
    .filter((s) => s.length > 0)
  if (parts.some((s) => s === '.' || s === '..')) {
    throw new Error(`path escapes the project store: ${path}`)
  }
  if (parts.length < 2) throw new Error(`path has no file: ${path}`)
  const name = parts.pop() as string
  return { segments: parts, name }
}

/** Strip leading slashes and collapse backslashes — callers pass either. */
export function normalizeRel(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/^\/+/, '')
}

async function root(): Promise<FileSystemDirectoryHandle> {
  if (!navigator.storage?.getDirectory) {
    throw new Error('เบราว์เซอร์นี้ไม่รองรับที่เก็บไฟล์ของเว็บ (OPFS)')
  }
  return navigator.storage.getDirectory()
}

async function dirFor(
  segments: string[],
  { create }: { create: boolean }
): Promise<FileSystemDirectoryHandle | null> {
  let dir = await root()
  for (const seg of segments) {
    try {
      dir = await dir.getDirectoryHandle(seg, { create })
    } catch {
      return null
    }
  }
  return dir
}

/** The handle for a file, or null when it (or a parent) does not exist. */
export async function fileHandle(
  path: string,
  { create = false } = {}
): Promise<FileSystemFileHandle | null> {
  const { segments, name } = splitFsPath(path)
  const dir = await dirFor(segments, { create })
  if (!dir) return null
  try {
    return await dir.getFileHandle(name, { create })
  } catch {
    return null
  }
}

export async function readFile(path: string): Promise<File | null> {
  const handle = await fileHandle(path)
  if (!handle) return null
  try {
    return await handle.getFile()
  } catch {
    return null
  }
}

export async function readText(path: string): Promise<string | null> {
  const file = await readFile(path)
  return file ? file.text() : null
}

export async function readJson<T>(path: string): Promise<T | null> {
  const text = await readText(path)
  if (text === null) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

export async function exists(path: string): Promise<boolean> {
  return (await fileHandle(path)) !== null
}

export async function fileSize(path: string): Promise<number | null> {
  const file = await readFile(path)
  return file ? file.size : null
}

/**
 * Write bytes so that the file EXISTS only once it is COMPLETE.
 *
 * Same contract the desktop's `atomic.py` gives every render output. Readers
 * here are the service worker (a `<video>` that opens a half-written file
 * plays a few seconds and stalls) and the UI's own "is it rendered yet"
 * probes, so the guarantee has to survive the port.
 *
 * On the main-thread path that is what `createWritable()` already does: the
 * stream writes a swap file and the destination is replaced on `close()`, so
 * `abort()` — or a tab killed mid-write — leaves the old file untouched. This
 * used to write a `.part` and then COPY it over the destination, every file
 * twice, for a guarantee the API was already giving. The worker path
 * (`createSyncAccessHandle`) has no swap file, so it still stages and then
 * renames — see `opfsWriteWorker.ts:publish`.
 */
export async function writeFileAtomic(
  path: string,
  data: Uint8Array | Blob | ReadableStream<Uint8Array>
): Promise<string> {
  // Safari has OPFS but no `createWritable` on the main thread, so every write
  // in the app threw `createWritable is not a function` there. The worker path
  // uses `createSyncAccessHandle` and keeps the same atomic contract.
  const { workerWriteFile, writeCapability } = await import('./opfsWrite')
  if ((await writeCapability()) === 'worker') {
    await workerWriteFile(path, data)
    return path
  }

  const { segments, name } = splitFsPath(path)
  const dir = await dirFor(segments, { create: true })
  if (!dir) throw new Error(`cannot create directory for ${path}`)

  // A writable's swap file makes a REPLACEMENT atomic: readers see the old
  // bytes until close. A NEW file is different — `getFileHandle(create)`
  // makes an empty entry at once, so for the whole write a reader (the
  // server sync, the service worker) finds a file that exists and is empty,
  // then changes under it (measured live: the sync's PUT of a fresh
  // project.json died with net::ERR_UPLOAD_FILE_CHANGED). A new file is
  // therefore staged under a dot-name and renamed in.
  let exists = true
  try {
    await dir.getFileHandle(name)
  } catch {
    exists = false
  }
  const stagedName = exists ? name : `.${name}.part`
  const target = await dir.getFileHandle(stagedName, { create: true })
  const writable = await target.createWritable()
  try {
    if (data instanceof ReadableStream) {
      await data.pipeTo(writable, { preventClose: true })
      await writable.close()
    } else {
      await writable.write(data as FileSystemWriteChunkType)
      await writable.close()
    }
  } catch (err) {
    await writable.abort().catch(() => undefined)
    if (!exists) await dir.removeEntry(stagedName).catch(() => undefined)
    throw err
  }
  if (!exists) await publishStaged(dir, target, name)
  return path
}

/** What `openStagedWrite` hands out; the encoder streams into `writable`. */
export interface StagedWrite {
  // Both paths accept the muxer's `{type,data,position}` chunks: an OPFS
  // `FileSystemWritableFileStream` understands them natively, and the worker
  // fallback translates them into positional sync writes.
  writable: WritableStream<MuxChunk>
  publish: () => Promise<string>
  discard: () => Promise<void>
}

/**
 * Rename `from` to `name` inside `dir` where the browser can, or copy it.
 *
 * `FileSystemFileHandle.move()` is Chromium's OPFS rename: one directory
 * entry changes, no bytes move, and the destination is never observable
 * half-written. Firefox and Safari have no `move`, so there the destination
 * is written through its own (swap-file) writable — one copy, still atomic
 * on the main thread. `false` means the copy path was taken.
 */
export async function publishStaged(
  dir: FileSystemDirectoryHandle,
  from: FileSystemFileHandle,
  name: string
): Promise<boolean> {
  const movable = from as FileSystemFileHandle & { move?: (name: string) => Promise<void> }
  if (typeof movable.move === 'function') {
    try {
      // Chromium refuses to move onto an existing entry; the old file goes
      // first. Between the two calls the destination is ABSENT, never
      // partial, which the contract allows.
      await dir.removeEntry(name).catch(() => undefined)
      await movable.move(name)
      return true
    } catch {
      // fall through to the copy
    }
  }
  const staged = await from.getFile()
  const dest = await dir.getFileHandle(name, { create: true })
  const out = await dest.createWritable()
  try {
    await out.write(staged)
    await out.close()
  } catch (err) {
    await out.abort().catch(() => undefined)
    throw err
  }
  await dir.removeEntry(from.name).catch(() => undefined)
  return false
}

/**
 * A writable for the encoder's streamed output, published only when the
 * caller says so.
 *
 * Why this is not `writeFileAtomic` with a stream: mediabunny's `StreamTarget`
 * CLOSES the writable on `output.cancel()` as well as on `finalize()`, and a
 * closed swap-file writable commits. A writable opened straight on the
 * destination would therefore publish a truncated MP4 on every failed
 * render. So the bytes go to `.<name>.part`, and `publish` renames it into
 * place (or copies, where the browser has no rename — `publishStaged`).
 */
export async function openStagedWrite(path: string): Promise<StagedWrite> {
  const { workerStagedWrite, writeCapability } = await import('./opfsWrite')
  if ((await writeCapability()) === 'worker') return workerStagedWrite(path)

  const { segments, name } = splitFsPath(path)
  const dir = await dirFor(segments, { create: true })
  if (!dir) throw new Error(`cannot create directory for ${path}`)
  const stagingName = `.${name}.part`
  const staging = await dir.getFileHandle(stagingName, { create: true })
  const writable = await staging.createWritable()

  return {
    writable,
    publish: async () => {
      await publishStaged(dir, staging, name)
      return path
    },
    discard: async () => {
      await writable.abort().catch(() => undefined)
      await dir.removeEntry(stagingName).catch(() => undefined)
    }
  }
}

export async function deleteFile(path: string): Promise<void> {
  const { segments, name } = splitFsPath(path)
  const dir = await dirFor(segments, { create: false })
  if (!dir) return
  await dir.removeEntry(name, { recursive: true }).catch(() => undefined)
}

/** Delete a directory and everything under it. `path` addresses the directory. */
export async function deleteDir(path: string): Promise<void> {
  if (!isFsPath(path)) throw new Error(`not a project path: ${path}`)
  const parts = path.slice(FS_SCHEME.length).split('/').filter(Boolean)
  const name = parts.pop()
  if (!name) return
  const dir = await dirFor(parts, { create: false })
  if (!dir) return
  await dir.removeEntry(name, { recursive: true }).catch(() => undefined)
}

/** Immediate children of a directory. Empty when it does not exist. */
export async function listDir(
  path: string
): Promise<{ name: string; kind: 'file' | 'directory' }[]> {
  if (!isFsPath(path)) throw new Error(`not a project path: ${path}`)
  const parts = path.slice(FS_SCHEME.length).split('/').filter(Boolean)
  const dir = await dirFor(parts, { create: false })
  if (!dir) return []
  const out: { name: string; kind: 'file' | 'directory' }[] = []
  // `entries()` is async-iterable but not in every lib.dom yet.
  for await (const [name, handle] of (
    dir as unknown as {
      entries: () => AsyncIterable<[string, FileSystemHandle]>
    }
  ).entries()) {
    out.push({ name, kind: handle.kind as 'file' | 'directory' })
  }
  return out
}

/**
 * Where a project's server manifest is cached.
 *
 * The leading dot keeps it out of every allow-list the sync uses, which is
 * intentional: it describes what the SERVER holds and must never be uploaded
 * to it.
 */
export const SERVER_MANIFEST = '.server_manifest.json'

/**
 * A project directory's contents — this browser's store PLUS what the server
 * holds.
 *
 * `listDir` alone answers "what is cached here", and several jobs asked it
 * "what does this project have". On a project opened in a second browser the
 * two differ completely: the store holds project.json and nothing else while
 * every clip sits on the server, so a plain listing reported a finished
 * project as never imported. Reading a file from either place already works —
 * `blobForPath` falls back to the server — so only the listing was missing.
 *
 * Names are merged and de-duplicated; a file present in both is listed once.
 */
export async function listProjectDir(
  uid: string,
  root: string
): Promise<{ name: string; kind: 'file' | 'directory' }[]> {
  const local = await listDir(projectFilePath(uid, root))
  const names = new Set(local.map((e) => e.name))
  const manifest = await readJson<{ path: string; bytes: number }[]>(
    projectFilePath(uid, SERVER_MANIFEST)
  )
  const out = [...local]
  for (const entry of manifest ?? []) {
    const prefix = `${root}/`
    if (!entry.path.startsWith(prefix)) continue
    const name = entry.path.slice(prefix.length)
    if (!name || name.includes('/') || names.has(name)) continue
    names.add(name)
    out.push({ name, kind: 'file' })
  }
  return out
}

/** Project uids currently in the store. */
export async function listProjectUids(): Promise<string[]> {
  const entries = await listDir(`${FS_SCHEME}${PROJECTS_ROOT}`)
  return entries.filter((e) => e.kind === 'directory').map((e) => e.name)
}

export async function ensureProjectsRoot(): Promise<void> {
  const r = await root()
  await r.getDirectoryHandle(PROJECTS_ROOT, { create: true })
}

/**
 * Turn a virtual path into the URL the service worker serves it at.
 *
 * `media.urlFor` in the UI builds these directly; this exists for the few
 * places that hold a virtual path instead of a (uid, relPath) pair.
 */
export function mediaUrlForFsPath(path: string): string {
  const { segments, name } = splitFsPath(path)
  // segments[0] is 'projects'; the rest plus the name is what the SW routes on.
  const rest = [...segments.slice(1), name].map(encodeURIComponent).join('/')
  return `/media/${rest}`
}

/** Names the sweeper recognises as leftovers, per the writers that make them. */
const STALE_PART = /^\..+\.part$/
const STALE_VIDEOONLY = /\.videoonly\.mp4$/
const STALE_CLIPS_STAGING = '.clips_next'
const STALE_PROBE = '.opfs-write-probe'
const SWEEP_MAX_AGE_MS = 60 * 60 * 1000
const STAGING_ROOT = 'staging'
const PROJECT_JSON = 'project.json'

/**
 * Remove what a killed tab leaves behind.
 *
 * Every writer here cleans up after itself on the paths it can see — a
 * thrown render discards its `.part`, a failed conversion drops its
 * `.videoonly.mp4` — but none of them runs when the tab is closed or the
 * browser discards it mid-job, and OPFS is not visible to the user, so those
 * files simply accumulate against the quota. Once per boot, before any job
 * can start, this removes:
 *
 *   staging/<uid>      when no project row exists for `uid` (the wizard was
 *                      interrupted between staging and writing the row), or
 *                      the row has no `pendingSources` left (ingest finished
 *                      but its delete did not). A row STILL pointing at its
 *                      staged files keeps them, whatever their age — that is
 *                      what "ลองใหม่" on a failed import reads.
 *   .<name>.part       a staged write nobody published
 *   .clips_next/       a render's per-scene clips that were never swapped in
 *   *.videoonly.mp4    a conversion's silent intermediate
 *
 * The last three only when older than an hour, so a job that IS running
 * (the sweep is meant for boot, but a caller could be late) keeps its files.
 * Ages come from `File.lastModified`; the walk is depth-limited to a
 * project's immediate subdirectories, which is where every writer puts them.
 */
export async function sweepStaleFiles(
  opts: { maxAgeMs?: number; now?: number } = {}
): Promise<{ removed: string[] }> {
  const maxAge = opts.maxAgeMs ?? SWEEP_MAX_AGE_MS
  const now = opts.now ?? Date.now()
  const removed: string[] = []
  const r = await root()

  const olderThan = async (dir: FileSystemDirectoryHandle, name: string): Promise<boolean> => {
    try {
      const file = await (await dir.getFileHandle(name)).getFile()
      return now - file.lastModified > maxAge
    } catch {
      return false
    }
  }
  const dirIsStale = async (dir: FileSystemDirectoryHandle): Promise<boolean> => {
    // A directory is as fresh as its newest file; an empty one is stale.
    for await (const [name, handle] of entriesOf(dir)) {
      if (handle.kind !== 'file') continue
      if (!(await olderThan(dir, name))) return false
    }
    return true
  }
  // Listings are taken whole before anything is removed: deleting entries
  // out from under a live `entries()` iterator is unspecified behaviour.
  const listed = async (dir: FileSystemDirectoryHandle): Promise<[string, FileSystemHandle][]> => {
    const out: [string, FileSystemHandle][] = []
    for await (const e of entriesOf(dir)) out.push(e)
    return out
  }
  const sweepDir = async (dir: FileSystemDirectoryHandle, label: string): Promise<void> => {
    for (const [name, handle] of await listed(dir)) {
      if (handle.kind === 'file') {
        if (STALE_PART.test(name) || STALE_VIDEOONLY.test(name) || name === STALE_PROBE) {
          if (await olderThan(dir, name)) {
            await dir.removeEntry(name).catch(() => undefined)
            removed.push(`${label}/${name}`)
          }
        }
      } else if (name === STALE_CLIPS_STAGING) {
        if (await dirIsStale(handle as FileSystemDirectoryHandle)) {
          await dir.removeEntry(name, { recursive: true }).catch(() => undefined)
          removed.push(`${label}/${name}`)
        }
      }
    }
  }
  type Row = { pendingSources?: unknown[] }
  const rowFor = (uid: string): Promise<Row | null> =>
    readJson<Row>(projectFilePath(uid, PROJECT_JSON))

  // Projects: the project directory and one level of subdirectories.
  const projects = await dirFor([PROJECTS_ROOT], { create: false })
  if (projects) {
    for (const [uid, handle] of await listed(projects)) {
      if (handle.kind !== 'directory') continue
      const pdir = handle as FileSystemDirectoryHandle
      await sweepDir(pdir, uid)
      for (const [sub, subHandle] of await listed(pdir)) {
        if (subHandle.kind !== 'directory' || sub === STALE_CLIPS_STAGING) continue
        await sweepDir(subHandle as FileSystemDirectoryHandle, `${uid}/${sub}`)
      }
    }
  }

  // Staging: per project uid, kept only while a row still points at it.
  const staging = await dirFor([STAGING_ROOT], { create: false })
  if (staging) {
    for (const [uid, handle] of await listed(staging)) {
      if (handle.kind !== 'directory') continue
      const row = await rowFor(uid)
      const referenced = Array.isArray(row?.pendingSources) && row.pendingSources.length > 0
      if (referenced) continue
      await staging.removeEntry(uid, { recursive: true }).catch(() => undefined)
      removed.push(`${STAGING_ROOT}/${uid}`)
    }
  }

  // The worker's write probe, at the root.
  if (await olderThan(r, STALE_PROBE)) {
    await r.removeEntry(STALE_PROBE).catch(() => undefined)
    removed.push(STALE_PROBE)
  }

  return { removed }
}

/** `entries()` is async-iterable but not in every lib.dom yet. */
function entriesOf(dir: FileSystemDirectoryHandle): AsyncIterable<[string, FileSystemHandle]> {
  return (dir as unknown as { entries: () => AsyncIterable<[string, FileSystemHandle]> }).entries()
}

/** Bytes used by the whole store, for the settings screen. */
export async function storageUsage(): Promise<{ usage: number; quota: number }> {
  const est = await navigator.storage?.estimate?.()
  return { usage: est?.usage ?? 0, quota: est?.quota ?? 0 }
}

/**
 * Ask the browser to stop treating this store as disposable.
 *
 * Without this, an origin's storage is "best-effort": the browser may evict
 * the whole thing when the disk gets tight, and for this app that store holds
 * the ONLY copy of the user's projects — their source video never went
 * anywhere else. Persisted storage is only cleared when the user clears it.
 *
 * Chrome grants it silently on a site the user has engaged with (installed,
 * bookmarked, or used repeatedly) and simply declines otherwise; Firefox
 * prompts. Declining is not an error — it is the state to report, which is
 * why this returns it rather than throwing.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false
    if (await navigator.storage.persisted?.()) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}

/** Whether the browser has promised not to evict the store. */
export async function storageIsPersisted(): Promise<boolean> {
  try {
    return (await navigator.storage?.persisted?.()) ?? false
  } catch {
    return false
  }
}
