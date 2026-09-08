/**
 * The zips a finished project hands over.
 *
 * Contents match `dub_render.build_dub_bundle_zip` and
 * `render_common.build_capcut_bundle`, because someone downloads these and
 * opens them somewhere else — the file names ARE the interface.
 */

import { zipSync } from 'fflate'
import { listDir, listProjectDir, projectFilePath, writeFileAtomic } from '../platform/fs'
import { blobForPath } from './jobs/probe'

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}

/**
 * Every `clips/clip_NNN.mp4` this project has, in order.
 *
 * The listing covers the server as well as the local store, and each file is
 * read through `blobForPath` — otherwise a bundle built on a project opened in
 * a second browser came out with no per-scene clips in it at all, and said
 * nothing about it.
 */
async function perSceneClips(uid: string): Promise<Record<string, Uint8Array>> {
  const out: Record<string, Uint8Array> = {}
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
    if (blob) out[`clips/${e.name}`] = new Uint8Array(await blob.arrayBuffer())
  }
  return out
}

export async function buildDubBundle(
  uid: string,
  parts: { finalSilent: Blob; scriptTxt: string; musicMixed: Blob | null }
): Promise<void> {
  const entries: Record<string, Uint8Array> = {
    'final_silent.mp4': await bytesOf(parts.finalSilent),
    'script.txt': new TextEncoder().encode(parts.scriptTxt),
    ...(await perSceneClips(uid))
  }
  if (parts.musicMixed) entries['final_with_music.mp4'] = await bytesOf(parts.musicMixed)
  await writeFileAtomic(projectFilePath(uid, 'dub_bundle.zip'), zipSync(entries))
}

export async function buildFinalBundle(
  uid: string,
  parts: { final: Blob; scriptTxt?: string | null }
): Promise<void> {
  const entries: Record<string, Uint8Array> = { 'final.mp4': await bytesOf(parts.final) }
  if (parts.scriptTxt) entries['script.txt'] = new TextEncoder().encode(parts.scriptTxt)
  await writeFileAtomic(projectFilePath(uid, 'final_bundle.zip'), zipSync(entries))
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
    clips: Object.keys(clips).map((file, i) => ({ file, label: `Scene ${i + 1}` })),
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

  await writeFileAtomic(
    projectFilePath(uid, 'capcut_bundle.zip'),
    zipSync({
      [parts.outputName]: await bytesOf(parts.final),
      ...clips,
      'captions/subtitles.srt': new TextEncoder().encode(parts.srt),
      'manifest.json': new TextEncoder().encode(manifestJson),
      'README.txt': new TextEncoder().encode(CAPCUT_README)
    })
  )
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
