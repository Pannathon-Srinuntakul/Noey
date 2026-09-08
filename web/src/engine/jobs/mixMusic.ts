/**
 * `mix-music` — put a music bed under a cut that already exists.
 *
 * Mirrors `desktop/sidecar/sidecar/dub.py:MixMusicJob`: idempotent, always
 * rebuilt from what is on disk right now, so attaching, re-trimming, muting or
 * removing a track all go through the same call. No music means the mixed file
 * is DELETED rather than left behind — the preview prefers
 * `final_silent_music.mp4` and would otherwise keep playing a track the editor
 * no longer shows.
 */

import { projectFilePath, writeFileAtomic, deleteFile } from '../../platform/fs'
import type { SidecarEvent } from '../../platform/types'
import { OUTPUT_FPS } from '../cutRender'
import { mixMusicOnto } from '../audio'
import { probeSource } from '../media'
import { buildDubBundle } from '../bundle'
import { blobForPath } from './probe'
import { signalOf } from '../abort'
import { registerJob, type ProgressCallback } from '../index'

registerJob('mix-music', async (job, emit: ProgressCallback): Promise<SidecarEvent> => {
  const uid = String(job.projectDir ?? '')
    .split('/')
    .pop() as string

  const silentPath = projectFilePath(uid, 'final_silent.mp4')
  // Through `blobForPath`: a project restored from the server has only
  // project.json locally, and a bare store read reported the finished cut as
  // missing — a failure useProjectPipeline swallows, so picking music simply
  // did nothing.
  const silent = await blobForPath(silentPath).catch(() => null)
  if (!silent) throw new Error('ยังไม่มีคลิปให้ใส่เพลง')

  // Through the server-aware path: on a restored project script.txt lives on
  // the server, and a bare read rebuilt dub_bundle.zip with an EMPTY script.
  const scriptTxt = await blobForPath(projectFilePath(uid, 'script.txt'))
    .then((b) => b.text())
    .catch(() => '')

  const musicPath = job.musicPath ? String(job.musicPath) : ''
  const mixedPath = projectFilePath(uid, 'final_silent_music.mp4')

  let musicMixed: Blob | null = null
  if (musicPath) {
    emit({ event: 'progress', stage: 'music', step: 1, total: 1 })
    const info = await probeSource(silent)
    musicMixed = await mixMusicOnto(
      silent,
      {
        musicPath,
        volume: Number(job.musicVolume ?? 0.25),
        offsetSec: Number(job.musicOffsetSec ?? 0),
        trimInSec: Number(job.musicTrimInSec ?? 0),
        trimOutSec: job.musicTrimOutSec == null ? null : Number(job.musicTrimOutSec),
        width: info.width,
        height: info.height,
        fps: OUTPUT_FPS
      },
      signalOf(job)
    )
    await writeFileAtomic(mixedPath, musicMixed)
  } else {
    await deleteFile(mixedPath)
  }

  emit({ event: 'progress', stage: 'bundle', step: 1, total: 1 })
  await buildDubBundle(uid, { finalSilent: silent, scriptTxt, musicMixed })

  return { event: 'done', mixed: musicMixed ? mixedPath : null }
})
