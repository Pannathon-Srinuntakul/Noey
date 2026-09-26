/**
 * The zips a finished project hands over.
 *
 * Contents match `dub_render.build_dub_bundle_zip` and
 * `render_common.build_capcut_bundle`, because someone downloads these and
 * opens them somewhere else — the file names ARE the interface.
 *
 * Streamed, not `zipSync`: that call wanted every member as a `Uint8Array` at
 * once — final.mp4, every per-scene clip AND the finished archive — so a
 * bundle briefly held three copies of the render in memory. Video members
 * are STORED (they are already H.264; deflating them costs CPU for nothing),
 * text members are deflated, and the archive goes out to OPFS a slice at a
 * time through the same staged write every encode uses.
 */

import { Zip, ZipDeflate, ZipPassThrough } from 'fflate'
import {
  listDir,
  listProjectDir,
  openStagedWrite,
  projectFilePath,
  writeFileAtomic
} from '../platform/fs'
import { blobForPath } from './jobs/probe'

/** One member: a name and where its bytes come from. */
export type ZipMember = { name: string } & ({ blob: Blob } | { text: string })

/** Blobs are read in slices of this size, so the archive never holds a whole video. */
const ZIP_SLICE = 4 * 1024 * 1024

/**
 * Write `members` as a zip at `outPath`, in order, one at a time.
 *
 * fflate's streaming `Zip` emits archive bytes through a callback as members
 * are pushed; those are forwarded to the staged writable in sequence, and
 * each blob slice waits for the previous chunk to land so back-pressure holds.
 */
export async function writeZip(outPath: string, members: ZipMember[]): Promise<void> {
  const staged = await openStagedWrite(outPath)
  const writer = staged.writable.getWriter()
  let position = 0
  let pending: Promise<void> = Promise.resolve()
  let failure: Error | null = null

  const zip = new Zip((err, chunk) => {
    if (err) {
      failure ??= err
      return
    }
    // Copy: fflate reuses its output buffers between callbacks.
    const data = chunk.slice()
    const at = position
    position += data.byteLength
    // `pending` never rejects — a failed write is parked in `failure` and
    // re-thrown by the loop at its next await, so nothing is left as an
    // unhandled rejection between the callback and that await.
    pending = pending
      .then(() => writer.write({ type: 'write', data, position: at }))
      .catch((e: unknown) => {
        failure ??= e instanceof Error ? e : new Error(String(e))
      })
  })

  try {
    for (const member of members) {
      const file: ZipDeflate | ZipPassThrough =
        'text' in member
          ? new ZipDeflate(member.name, { level: 6 })
          : new ZipPassThrough(member.name)
      zip.add(file)
      if ('text' in member) {
        file.push(new TextEncoder().encode(member.text), true)
      } else {
        const blob = member.blob
        if (blob.size === 0) {
          file.push(new Uint8Array(0), true)
        } else {
          for (let at = 0; at < blob.size; at += ZIP_SLICE) {
            const end = Math.min(blob.size, at + ZIP_SLICE)
            const slice = new Uint8Array(await blob.slice(at, end).arrayBuffer())
            file.push(slice, end === blob.size)
            if (failure) throw failure
            await pending
          }
        }
      }
      if (failure) throw failure
      await pending
    }
    zip.end()
    if (failure) throw failure
    await pending
    await writer.close()
    writer.releaseLock()
    await staged.publish()
  } catch (err) {
    zip.terminate()
    await writer.abort().catch(() => undefined)
    writer.releaseLock()
    await staged.discard().catch(() => undefined)
    throw err
  }
}

/**
 * Every `clips/clip_NNN.mp4` this project has, in order.
 *
 * The listing covers the server as well as the local store, and each file is
 * read through `blobForPath` — otherwise a bundle built on a project opened in
 * a second browser came out with no per-scene clips in it at all, and said
 * nothing about it.
 */
async function perSceneClips(uid: string): Promise<ZipMember[]> {
  const out: ZipMember[] = []
  // LOCAL first: a bundle is built right after a render, and the render just
  // wrote this browser's clips/. The merged listing exists for the restored
  // project whose clips live only on the server -- but merging it here too let
  // a STALE cached manifest (from before the re-cut) add the previous run's
  // extra scenes into the zip.
  const localOnly = (await listDir(projectFilePath(uid, 'clips'))).filter(
    (e) => e.kind === 'file' && e.name.endsWith('.mp4')
  )
  const entries = (localOnly.length > 0 ? localOnly : await listProjectDir(uid, 'clips'))
    .filter((e) => e.kind === 'file' && e.name.endsWith('.mp4'))
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const e of entries) {
    const blob = await blobForPath(projectFilePath(uid, `clips/${e.name}`)).catch(() => null)
    if (blob) out.push({ name: `clips/${e.name}`, blob })
  }
  return out
}

export async function buildDubBundle(
  uid: string,
  parts: { finalSilent: Blob; scriptTxt: string; musicMixed: Blob | null }
): Promise<void> {
  const members: ZipMember[] = [
    { name: 'final_silent.mp4', blob: parts.finalSilent },
    { name: 'script.txt', text: parts.scriptTxt },
    ...(await perSceneClips(uid))
  ]
  if (parts.musicMixed) members.push({ name: 'final_with_music.mp4', blob: parts.musicMixed })
  await writeZip(projectFilePath(uid, 'dub_bundle.zip'), members)
}

export async function buildFinalBundle(
  uid: string,
  parts: { final: Blob; scriptTxt?: string | null }
): Promise<void> {
  const members: ZipMember[] = [{ name: 'final.mp4', blob: parts.final }]
  if (parts.scriptTxt) members.push({ name: 'script.txt', text: parts.scriptTxt })
  await writeZip(projectFilePath(uid, 'final_bundle.zip'), members)
}

export interface CapCutManifest {
  project_uid: string
  mode: string
  output: string
  clips: { file: string; label: string }[]
  captions: string
  captions_ass: string | null
}

const CAPCUT_README = `CapCut Import Guide

1. Open CapCut and create a new project.
2. Import every file from clips/ — they are already in order.
3. Import captions/subtitles.srt as a subtitle track.
4. final.mp4 is the finished cut, if you only want that.
`

/**
 * The "edit this somewhere else" bundle: the finished video, the per-scene
 * clips, the subtitles, and a manifest naming them.
 */
export async function buildCapCutBundle(
  uid: string,
  parts: { final: Blob; srt: string; mode: string; outputName: string }
): Promise<void> {
  const clips = await perSceneClips(uid)
  const manifest: CapCutManifest = {
    project_uid: uid,
    mode: parts.mode,
    output: parts.outputName,
    clips: clips.map((m, i) => ({ file: m.name, label: `Scene ${i + 1}` })),
    captions: 'captions/subtitles.srt',
    captions_ass: null
  }
  const manifestJson = JSON.stringify(manifest, null, 2)

  await writeFileAtomic(
    projectFilePath(uid, 'manifest.json'),
    new TextEncoder().encode(manifestJson)
  )
  await writeFileAtomic(
    projectFilePath(uid, 'captions/subtitles.srt'),
    new TextEncoder().encode(parts.srt)
  )

  await writeZip(projectFilePath(uid, 'capcut_bundle.zip'), [
    { name: parts.outputName, blob: parts.final },
    ...clips,
    { name: 'captions/subtitles.srt', text: parts.srt },
    { name: 'manifest.json', text: manifestJson },
    { name: 'README.txt', text: CAPCUT_README }
  ])
}

/** `HH:MM:SS,mmm` — SubRip's timestamp. Mirrors `render_common.write_srt`. */
function srtTime(seconds: number): string {
  const s = Math.max(0, seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  const ms = Math.round((s - Math.floor(s)) * 1000)
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${pad(h)}:${pad(m)}:${pad(sec)},${pad(ms, 3)}`
}

export function buildSrt(captions: { start: number; end: number; text: string }[]): string {
  const out: string[] = []
  captions.forEach((c, i) => {
    out.push(String(i + 1))
    out.push(`${srtTime(c.start)} --> ${srtTime(c.end)}`)
    out.push(c.text)
    out.push('')
  })
  return out.join('\n')
}
