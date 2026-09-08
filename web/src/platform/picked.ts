/**
 * Files the user just picked, before they belong to a project.
 *
 * The desktop build turns a dropped `File` into a real OS path with
 * `webUtils.getPathForFile` and passes that string around. A browser has no
 * such path, so a pick is registered here and addressed as `picked://<id>`.
 *
 * THE RULE THAT MATTERS: a `picked://` id lives in memory only, so it dies on
 * reload. The wizard persists its file list into `project.json`
 * (`pendingSources`, `pendingMusic`) and the pipeline reads it back later —
 * possibly after a restart, which the desktop design explicitly supports. A
 * `picked://` id must therefore NEVER be written to a project: call
 * `stageIntoStore` at submit time and persist the `noeyfs://` path it returns.
 *
 * Staging also gets the bytes into OPFS, where the render worker can open them
 * directly instead of having a `File` posted across to it.
 */

import { PICKED_SCHEME, writeFileAtomic, FS_SCHEME } from './fs'

const picked = new Map<string, File>()

let counter = 0

/** Register a picked file and return the id the UI will carry. */
export function registerPicked(file: File | Blob, name?: string): string {
  counter += 1
  const fileName = name ?? (file instanceof File ? file.name : 'clip.mp4')
  // A Blob from the server's converter is wrapped so everything downstream
  // still sees a File with a name — the name is what picks the stored
  // extension, and `norm_000.mov` for an MP4 would be a lie on disk.
  const asFile =
    file instanceof File && !name ? file : new File([file], fileName, { type: file.type })
  const id = `${PICKED_SCHEME}${counter}-${fileName}`
  picked.set(id, asFile)
  return id
}

export function getPicked(id: string): File | null {
  return picked.get(id) ?? null
}

export function forgetPicked(id: string): void {
  picked.delete(id)
}

/**
 * Copy a picked file into the store so it survives a reload.
 *
 * Staged files land under `noeyfs://staging/<uid>/<n>/<name>`; ingest moves
 * them into the project's `normalized/` and deletes that project's staging
 * directory. Anything already in the store (a `noeyfs://` path) is returned
 * untouched, so callers can pass a mixed list without checking.
 *
 * The `uid` in the path is what makes the wizard's "one project per file" mode
 * safe: staging used to be one flat root and every ingest ended by deleting
 * ALL of it, so the first project to finish pulled the sources out from under
 * every other import still running.
 */
export function stagingDir(uid: string): string {
  return `${FS_SCHEME}staging/${uid}`
}

export async function stageIntoStore(pathOrId: string, uid: string): Promise<string> {
  if (pathOrId.startsWith(FS_SCHEME)) return pathOrId
  const file = getPicked(pathOrId)
  if (!file) {
    throw new Error('ไฟล์ที่เลือกไว้หายไปแล้ว กรุณาเลือกไฟล์อีกครั้ง')
  }
  counter += 1
  const dest = `${stagingDir(uid)}/${counter}/${file.name}`
  await writeFileAtomic(dest, file)
  forgetPicked(pathOrId)
  return dest
}

/** Stage a whole list, preserving order. */
export async function stageAll(paths: string[], uid: string): Promise<string[]> {
  const out: string[] = []
  for (const p of paths) out.push(await stageIntoStore(p, uid))
  return out
}
