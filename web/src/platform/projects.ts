/**
 * The project registry, on OPFS.
 *
 * A port of `desktop/app/src/main/projects.ts`. Same layout — one directory per
 * project holding `project.json` — and the same three behaviours the UI depends
 * on, each of which exists because of a bug the desktop side already hit:
 *
 *   - a per-uid write lock, because unlocked concurrent writes produced
 *     concatenated JSON on disk (see that file's comment);
 *   - `createProject` copying only a fixed subset of its input, which is why
 *     the wizard does `create()` then `update()`;
 *   - `stashRender` / `restoreRender` moving the WHOLE render artifact set,
 *     because restoring only the playable mp4 leaves the editor opening last
 *     round's per-scene clips against this round's edit script.
 */

import type { LocalProject } from './types'
import {
  deleteDir,
  deleteFile,
  ensureProjectsRoot,
  exists,
  fileSize,
  listDir,
  listProjectDir,
  listProjectUids,
  projectDirPath,
  projectFilePath,
  readFile,
  readJson,
  SERVER_MANIFEST,
  writeFileAtomic
} from './fs'
import { stageIntoStore, stagingDir } from './picked'

const PROJECT_FILE = 'project.json'

/** Same set, same order, same reasoning as main/projects.ts:120. */
const RENDER_ARTIFACTS = [
  'final.mp4',
  'final_fx.mp4',
  'final_silent.mp4',
  'final_silent_music.mp4',
  'dub_bundle.zip',
  'script.txt',
  'concat_silent.txt',
  'clips'
] as const

const PREVIOUS_DIR = 'previous'

// ── change notification ──────────────────────────────────────────────────────
// `projects.onChanged` exists on desktop for ONE case: the phone remote
// creating a row behind the UI's back. Nothing does that here, so this never
// fires — but `jobs.tsx` subscribes and uses the return value as an effect
// cleanup, so it must still hand back a real unsubscribe.
//
// It deliberately does NOT fire on create. Announcing there made the job host
// pick a project up between `create()` and the `update()` that follows it, so
// the pipeline booted on a row with `step: 'imported'` and no clips and went
// straight to the AI call — "clips: List should have at least 1 item"
// (2026-09-08). The wizard navigates once the row is complete; that is what
// puts it on screen.
const changed = new EventTarget()

export function onChanged(cb: () => void): () => void {
  const handler = (): void => cb()
  changed.addEventListener('changed', handler)
  return () => changed.removeEventListener('changed', handler)
}

/** Tells the project list to re-read the store. */
export function announceProjectsChanged(): void {
  changed.dispatchEvent(new Event('changed'))
}

// ── write lock ───────────────────────────────────────────────────────────────
const writeLocks = new Map<string, Promise<unknown>>()

function withWriteLock<T>(uid: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(uid) ?? Promise.resolve()
  const next = prev.catch(() => undefined).then(fn)
  writeLocks.set(
    uid,
    next.catch(() => undefined)
  )
  return next
}

// ── read / write ─────────────────────────────────────────────────────────────

export function dir(uid: string): string {
  return projectDirPath(uid)
}

export function resolvePath(uid: string, rel: string): string {
  return projectFilePath(uid, rel)
}

export async function get(uid: string): Promise<LocalProject | null> {
  return readJson<LocalProject>(projectFilePath(uid, PROJECT_FILE))
}

async function write(project: LocalProject): Promise<LocalProject> {
  const stamped = { ...project, updatedAt: new Date().toISOString() }
  await writeFileAtomic(
    projectFilePath(stamped.uid, PROJECT_FILE),
    new TextEncoder().encode(JSON.stringify(stamped, null, 2))
  )
  return stamped
}

export async function list(): Promise<LocalProject[]> {
  await ensureProjectsRoot()
  const uids = await listProjectUids()
  const rows: LocalProject[] = []
  for (const uid of uids) {
    const p = await get(uid)
    if (p) rows.push(p)
  }
  rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  return rows
}

/**
 * Only the fields listed here survive `create` — same subset as the desktop's
 * `createProject`, which is why callers follow it with `update`.
 */
export async function create(
  init: Partial<LocalProject> & { name: string }
): Promise<LocalProject> {
  const uid = init.uid ?? crypto.randomUUID()
  const now = new Date().toISOString()
  const project: LocalProject = {
    uid,
    name: init.name,
    mode: init.mode ?? 'dub_first',
    step: init.step ?? 'imported',
    createdAt: now,
    updatedAt: now,
    clips: init.clips ?? [],
    ...(init.brief ? { brief: init.brief } : {}),
    ...(init.userScript ? { userScript: init.userScript } : {}),
    ...(init.targetDurationSec ? { targetDurationSec: init.targetDurationSec } : {}),
    ...(init.remote ? { remote: init.remote } : {})
  } as LocalProject
  return withWriteLock(uid, () => write(project))
}

export async function update(uid: string, patch: Partial<LocalProject>): Promise<LocalProject> {
  return withWriteLock(uid, async () => {
    const current = await get(uid)
    if (!current) throw new Error(`ไม่พบโปรเจกต์ ${uid}`)
    // uid and createdAt are force-preserved, same as the desktop.
    const merged = { ...current, ...patch, uid: current.uid, createdAt: current.createdAt }
    return write(merged)
  })
}

export async function remove(uid: string): Promise<void> {
  if (!(await exists(projectFilePath(uid, PROJECT_FILE)))) return
  await deleteDir(projectDirPath(uid))
  // The project's staged sources too: an import that failed or was abandoned
  // left full-size clips under staging/<uid> that NO in-app action could
  // reclaim -- not this delete, not "ล้างสำเนา".
  await deleteDir(stagingDir(uid)).catch(() => undefined)
}

/**
 * Delete every project in the store.
 *
 * The desktop can point someone at a folder they can empty themselves; a
 * browser store has no such door — the only alternative is Chrome's own
 * "clear site data", which is buried and also takes the login with it. The
 * count is returned so the confirmation can say what actually went.
 */
export async function removeAll(): Promise<number> {
  const uids = await listProjectUids()
  for (const uid of uids) await deleteDir(projectDirPath(uid))
  // The whole staging root: entries can outlive their project row (a failed
  // import before the row existed), so per-uid deletes are not enough here.
  await deleteDir('noeyfs://staging').catch(() => undefined)
  announceProjectsChanged()
  return uids.length
}

// ── files inside a project ───────────────────────────────────────────────────

export async function writeFile(
  uid: string,
  rel: string,
  data: Uint8Array | Blob
): Promise<string> {
  return writeFileAtomic(projectFilePath(uid, rel), data)
}

export async function removeFile(uid: string, rel: string): Promise<void> {
  await deleteFile(projectFilePath(uid, rel))
}

/**
 * Copy a picked audio file into `music/` under a name no other file there has.
 *
 * It used to clear the rest of the folder, and overwrite a file of the same
 * name. The editor's history still points at the track it replaced, so undoing
 * "เปลี่ยนเพลง" restored a path to a deleted (or overwritten) file: no
 * waveform, no sound, and a render that failed on the read. Replaced tracks
 * now stay until `pruneMusic` runs, once nothing can undo back to them.
 * Returns the PROJECT-RELATIVE path, which is what the UI persists.
 */
export async function importMusic(uid: string, src: string): Promise<string> {
  const staged = await stageIntoStore(src, uid)
  const file = await readFile(staged)
  if (!file) throw new Error('อ่านไฟล์เพลงไม่ได้')
  const rel = await freeMusicPath(uid, file.name)
  await writeFileAtomic(projectFilePath(uid, rel), file)
  return rel
}

/** `music/<name>`, or `music/<stem>-2.<ext>` (-3, …) when that is taken. */
async function freeMusicPath(uid: string, name: string): Promise<string> {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let rel = `music/${name}`
  for (let n = 2; await exists(projectFilePath(uid, rel)); n++) rel = `music/${stem}-${n}${ext}`
  return rel
}

/**
 * Delete every file in `music/` except `keep` (the attached track, and any a
 * kept undo history can still restore). Called once nothing else can point at
 * a replaced track — the editor closing, or an import that attaches a fresh
 * copy. Returns how many files went, so the caller knows whether the server
 * copy needs a sync.
 */
export async function pruneMusic(
  uid: string,
  keep: string | readonly string[] | undefined
): Promise<number> {
  const kept = new Set(typeof keep === 'string' ? [keep] : (keep ?? []))
  let removed = 0
  for (const entry of await listDir(projectFilePath(uid, 'music'))) {
    if (entry.kind !== 'file' || kept.has(`music/${entry.name}`)) continue
    await deleteFile(projectFilePath(uid, `music/${entry.name}`))
    removed++
  }
  return removed
}

// ── stash / restore (the R12 undo mechanism) ─────────────────────────────────

export async function stashRender(uid: string): Promise<string[]> {
  await deleteDir(projectFilePath(uid, PREVIOUS_DIR))
  const moved: string[] = []
  for (const name of RENDER_ARTIFACTS) {
    const from = projectFilePath(uid, name)
    const to = projectFilePath(uid, `${PREVIOUS_DIR}/${name}`)
    if (name === 'clips') {
      const entries = await listDir(from)
      if (entries.length === 0) continue
      for (const e of entries) {
        if (e.kind !== 'file') continue
        const bytes = await readFile(projectFilePath(uid, `clips/${e.name}`))
        if (bytes) await writeFileAtomic(`${to}/${e.name}`, bytes)
      }
      await deleteDir(from)
      moved.push(`${PREVIOUS_DIR}/${name}`)
      continue
    }
    const file = await readFile(from)
    if (!file) continue
    await writeFileAtomic(to, file)
    await deleteFile(from)
    moved.push(`${PREVIOUS_DIR}/${name}`)
  }
  return moved
}

export async function restoreRender(uid: string): Promise<void> {
  const prevDir = projectFilePath(uid, PREVIOUS_DIR)
  if ((await listDir(prevDir)).length === 0) return

  for (const name of RENDER_ARTIFACTS) {
    const kept = projectFilePath(uid, `${PREVIOUS_DIR}/${name}`)
    const live = projectFilePath(uid, name)

    if (name === 'clips') {
      const entries = await listDir(kept)
      await deleteDir(live)
      if (entries.length === 0) continue
      for (const e of entries) {
        if (e.kind !== 'file') continue
        const bytes = await readFile(`${kept}/${e.name}`)
        if (bytes) await writeFileAtomic(projectFilePath(uid, `clips/${e.name}`), bytes)
      }
      continue
    }

    const file = await readFile(kept)
    if (!file) {
      // Not in the kept set: delete the current one too, so a restore never
      // mixes two rounds together.
      await deleteFile(live)
      continue
    }
    await deleteFile(live)
    await writeFileAtomic(live, file)
  }
  await deleteDir(prevDir)
}

// ── artifacts (what the export screen lists) ─────────────────────────────────

/** Same preference order as `usePreviewFile` and the desktop's export list. */
const FINAL_CANDIDATES = [
  'final_fx.mp4',
  'final.mp4',
  'final_silent_music.mp4',
  'final_silent.mp4'
] as const

const BUNDLE_CANDIDATES = ['dub_bundle.zip', 'final_bundle.zip', 'capcut_bundle.zip'] as const

export interface Artifact {
  id: string
  path: string
  label: string
  name: string
  size: number
  kind: 'final' | 'subs' | 'scene' | 'bundle'
}

/**
 * Files in a per-render directory (`clips/`, `highlights/`). The local store
 * wins whenever it has any: a render rewrites the whole directory here, while
 * the cached server manifest can still list files an earlier, longer cut left
 * behind — a re-cut to 17 scenes exported as "18 ไฟล์" (live report
 * 2026-09-21). `engine/bundle.ts` follows the same rule for the zip. Only a
 * project whose renders all ran in another browser falls back to the server.
 */
async function renderDirEntries(uid: string, dir: string): ReturnType<typeof listProjectDir> {
  const local = (await listDir(projectFilePath(uid, dir))).filter((e) => e.kind === 'file')
  return local.length > 0 ? local : listProjectDir(uid, dir)
}

/**
 * What this project has that is worth exporting.
 *
 * `ExportVideoModal` calls this (on desktop it comes from the LAN module) and
 * shows a checklist, so the shapes and the ordering have to match.
 */
export async function artifacts(uid: string): Promise<Artifact[]> {
  const out: Artifact[] = []

  // What the server holds, cached locally by `projectSync.serverManifest`.
  // Without it this listing sees only the local store, so on a project opened
  // in a second browser the export checklist came up empty — "ยังไม่มีไฟล์ให้
  // ส่งออก" about a project the user is looking at a finished preview of. The
  // download half already worked; only the listing was blind.
  const remote = new Map<string, number>()
  for (const entry of (await readJson<{ path: string; bytes: number }[]>(
    projectFilePath(uid, SERVER_MANIFEST)
  )) ?? []) {
    remote.set(entry.path, entry.bytes)
  }

  const add = async (rel: string, label: string, kind: Artifact['kind']): Promise<void> => {
    const path = projectFilePath(uid, rel)
    const size = (await fileSize(path)) ?? remote.get(rel) ?? null
    if (size === null) return
    out.push({ id: rel, path, label, name: rel.split('/').pop() as string, size, kind })
  }

  // Highlights first — that mode has no single final video.
  for (const e of await renderDirEntries(uid, 'highlights')) {
    if (e.kind === 'file' && e.name.endsWith('.mp4')) {
      await add(`highlights/${e.name}`, `ไฮไลต์ ${e.name.replace('.mp4', '')}`, 'final')
    }
  }
  for (const name of FINAL_CANDIDATES) {
    await add(name, 'คลิปสำเร็จ', 'final')
    if (out.some((a) => a.id === name)) break
  }
  await add('captions/subtitles.srt', 'ไฟล์คำบรรยาย', 'subs')
  for (const e of await renderDirEntries(uid, 'clips')) {
    if (e.kind === 'file' && e.name.endsWith('.mp4')) {
      await add(`clips/${e.name}`, `ฉาก ${e.name.replace(/\D/g, '')}`, 'scene')
    }
  }
  for (const name of BUNDLE_CANDIDATES) await add(name, 'ชุดไฟล์สำหรับตัดต่อต่อ', 'bundle')
  return out
}
