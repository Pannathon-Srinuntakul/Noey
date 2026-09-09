/**
 * `filmstrip` — the timeline editor's thumbnail lanes.
 *
 * Same manifest contract as `desktop/sidecar/sidecar/filmstrip.py`, because
 * `useFilmstripStrips` reads it field for field and rebuilds the tile URLs
 * itself as `t_%05d.jpg`:
 *
 *   filmstrip/<clipId>/t_00001.jpg …
 *   filmstrip/<clipId>/manifest.json   { v, durationSec, count, tileSec,
 *                                        tileWidth, tileHeight, file, fileSize }
 *
 * The manifest is written LAST, so its presence means the strip is complete.
 *
 * Three behaviours carried over from the day that file was written, each of
 * which came from a real failure:
 *   - a very short clip must still yield a frame (a 0.1 s stub at 2 fps asks
 *     for 0.2 frames, and the encoder never opens);
 *   - one bad clip must not take the others down with it;
 *   - a matching manifest is reused, so re-opening the editor is nearly free.
 *
 * Two behaviours added 2026-09-09, both from "thumbnail ตรง timeline มันไม่แสดง
 * ต้องรอซักพัก":
 *   - the manifest check runs BEFORE the source is opened. It used to sit
 *     behind `blobForPath` + `probeSource`, so a fully cached strip still paid
 *     a container walk per clip — and on a project restored from the server,
 *     a download of the whole source video just to compare a duration. The
 *     clip files are immutable after ingest (`normalized/norm_NNN.mp4` is
 *     written once), so path + size identity is a sound key without a probe.
 *   - each clip's manifest is EMITTED as it completes, so the editor paints
 *     lane 1 while lane 4 is still extracting instead of holding everything
 *     until the last clip resolves.
 */

import {
  deleteDir,
  fileSize,
  listDir,
  projectFilePath,
  readJson,
  writeFileAtomic
} from '../../platform/fs'
import type { SidecarEvent } from '../../platform/types'
import { openVideo, probeSource } from '../media'
import { registerJob, type ProgressCallback } from '../index'
import { signalOf, throwIfAborted } from '../abort'
import { blobForPath } from './probe'

// v2: manifests carry the source's path + byte size so a warm reopen can trust
// them without opening the source at all. v1 manifests regenerate once.
const MANIFEST_VERSION = 2
const DEFAULT_TILE_HEIGHT = 96
const DEFAULT_TILES_PER_SEC = 2
const DEFAULT_MAX_TILES = 900
const MAX_SAMPLE_FPS = 30
const JPEG_QUALITY = 0.7

interface StripManifest {
  id: string
  v: number
  durationSec: number
  count: number
  tileSec: number
  tileWidth: number
  tileHeight: number
  /** The source this strip was cut from — the cache key that avoids a probe. */
  file: string
  /** Byte size of that source when the strip was made; null = not local then. */
  fileSize: number | null
}

registerJob('filmstrip', async (job, emit: ProgressCallback): Promise<SidecarEvent> => {
  const projectDir = String(job.projectDir ?? '')
  const uid = projectDir.split('/').pop() as string
  const clips = (job.clips as { id: string; file: string }[]) ?? []
  const tileHeight = Number(job.tileHeight ?? DEFAULT_TILE_HEIGHT)
  const tilesPerSec = Number(job.tilesPerSec ?? DEFAULT_TILES_PER_SEC)
  const maxTiles = Number(job.maxTiles ?? DEFAULT_MAX_TILES)
  const force = Boolean(job.force)
  const signal = signalOf(job)

  const results: (StripManifest & { cached: boolean })[] = []

  /** Progressive delivery — see the header note. */
  const emitStrip = (strip: StripManifest & { cached: boolean }, i: number): void => {
    emit({
      event: 'progress',
      stage: 'filmstrip',
      step: i + 1,
      total: clips.length,
      strip
    })
  }

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]
    const dir = projectFilePath(uid, `filmstrip/${clip.id}`)
    const manifestPath = `${dir}/manifest.json`

    emit({
      event: 'progress',
      stage: 'filmstrip',
      step: i + 1,
      total: clips.length,
      message: clip.file.split('/').pop() ?? clip.file
    })

    try {
      throwIfAborted(signal)

      // FAST PATH — no source open. A v2 manifest for the same file (and the
      // same byte size, when the file is local to compare against) is trusted
      // outright; the manifest is written last, so its presence already means
      // every tile before it landed.
      if (!force) {
        const existing = await readJson<StripManifest>(manifestPath)
        if (
          existing &&
          existing.v === MANIFEST_VERSION &&
          existing.tileHeight === tileHeight &&
          existing.count > 0 &&
          existing.file === clip.file
        ) {
          const localSize = await fileSize(projectFilePath(uid, clip.file))
          if (localSize === null || existing.fileSize === null || localSize === existing.fileSize) {
            const row = { ...existing, cached: true }
            results.push(row)
            emitStrip(row, i)
            continue
          }
        }
      }

      const blob = await blobForPath(projectFilePath(uid, clip.file))
      const info = await probeSource(blob)
      if (info.durationSec <= 0) throw new Error('ไม่มีความยาว')

      // Rate: capped so a long clip gets a sparser strip rather than a
      // truncated one, and floored so a very short clip still yields a frame.
      let rate = Math.min(tilesPerSec, maxTiles / info.durationSec)
      rate = Math.max(rate, 0.05)
      if (info.durationSec * rate < 1) rate = Math.min(MAX_SAMPLE_FPS, 1.5 / info.durationSec)

      const count = Math.max(1, Math.floor(info.durationSec * rate))
      const ratio = info.width && info.height ? info.width / info.height : 9 / 16
      const tileWidth = Math.max(1, Math.round(tileHeight * ratio))

      // A shorter re-extract must not leave the tail of a previous run behind.
      await deleteDir(dir)

      const reader = await openVideo(blob)
      const canvas = new OffscreenCanvas(tileWidth, tileHeight)
      const ctx = canvas.getContext('2d', { alpha: false })
      if (!ctx) throw new Error('เปิดพื้นที่วาดภาพไม่ได้')

      // One sequential pass over the tile timestamps. `frameAt` re-seeks and
      // re-walks the GOP for every tile, which on a long source is the
      // difference between a strip that appears and an editor that looks
      // frozen — the same fix `transcode` and `cutRender` already carry.
      const stamps: number[] = []
      for (let t = 0; t < count; t++) {
        stamps.push(Math.min((t + 0.5) / rate, info.durationSec - 0.01))
      }
      const pass = reader.framesAt(stamps)
      try {
        for (let t = 0; t < count; t++) {
          throwIfAborted(signal)
          const frame = (await pass.next()).value ?? null
          if (!frame) break
          ctx.drawImage(frame, 0, 0, tileWidth, tileHeight)
          const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY })
          await writeFileAtomic(`${dir}/t_${String(t + 1).padStart(5, '0')}.jpg`, jpeg)
        }
      } finally {
        await pass.return(undefined).catch(() => undefined)
        reader.close()
      }

      const written = (await listDir(dir)).filter((e) => e.name.endsWith('.jpg')).length
      if (written === 0) throw new Error('ไม่ได้ภาพสักเฟรม')

      const manifest: StripManifest = {
        id: clip.id,
        v: MANIFEST_VERSION,
        durationSec: Math.round(info.durationSec * 1000) / 1000,
        count: written,
        tileSec: Math.round((1 / rate) * 1e6) / 1e6,
        tileWidth,
        tileHeight,
        file: clip.file,
        fileSize: await fileSize(projectFilePath(uid, clip.file))
      }
      // Written last: its presence is the readiness signal.
      await writeFileAtomic(
        manifestPath,
        new TextEncoder().encode(JSON.stringify(manifest, null, 2))
      )
      const row = { ...manifest, cached: false }
      results.push(row)
      emitStrip(row, i)
    } catch (err) {
      // An abort is a command, not a per-clip hiccup: swallowing it made
      // หยุดงาน a no-op here and the job still resolved 'done'.
      if (err instanceof Error && err.name === 'AbortError') throw err
      // One clip must never take the others down. An empty lane is a lane with
      // no picture; the editor is fully usable either way.
      emit({
        event: 'warning',
        stage: 'filmstrip',
        message: `ทำภาพตัวอย่างของ ${clip.file} ไม่สำเร็จ: ${
          err instanceof Error ? err.message : String(err)
        }`
      })
    }
  }

  return { event: 'done', filmstrips: results, count: results.length }
})
