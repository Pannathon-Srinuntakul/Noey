/**
 * `render-final` — the cut with the voiceover on it.
 *
 * Mirrors `desktop/sidecar/sidecar/dub.py:run_render_final`. Two differences,
 * both because there is no ffmpeg:
 *
 *   - The desktop cuts silent clips, concatenates them, then muxes the audio
 *     over the join. Here the audio is mixed first and handed to the encoder
 *     with the frames, so there is no intermediate `final_noaudio.mp4`.
 *   - Captions are drawn onto the frame instead of burned in a second pass.
 *     The desktop burns AFTER the mux specifically so the stream-copied audio
 *     survives; drawing them in the one pass makes that ordering moot.
 *
 * `clipDurationsSec` is re-reported because this pass re-cut `clips/` from its
 * OWN cut list: the array the silent render stored describes a video that no
 * longer exists, and the effects layer clamps zoom windows against it.
 */

import { projectFilePath, deleteFile, readText } from '../../platform/fs'
import type { SidecarEvent } from '../../platform/types'
import type { CaptionLine } from '../../lib/captionLines'
import type { CaptionStyle } from '../../lib/captionStyle'
import type { CaptionWord } from '../captions'
import { OUTPUT_FPS, renderCutList, type CutSpec } from '../cutRender'
import { decodeBlob, decodeStored, renderMix } from '../audio'
import { buildFinalBundle } from '../bundle'
import { blobForPath } from './probe'
import { registerJob, type ProgressCallback } from '../index'

interface TimelineCut {
  type?: string
  in: number
  out: number
  source?: string
}

registerJob('render-final', async (job, emit: ProgressCallback): Promise<SidecarEvent> => {
  const uid = String(job.projectDir ?? '')
    .split('/')
    .pop() as string

  const timeline = (job.timeline ?? {}) as { timeline?: TimelineCut[] }
  const cuts: CutSpec[] = (timeline.timeline ?? [])
    .filter((c) => c.type === 'cut')
    .map((c) => ({
      sourceClip: String(c.source ?? 'clip0'),
      sourceIn: Number(c.in),
      sourceOut: Number(c.out)
    }))
  if (cuts.length === 0) throw new Error('ไทม์ไลน์ไม่มีฉากให้เรนเดอร์ — ลองวางแผนใหม่อีกครั้ง')

  const voiceoverPath = String(job.voiceoverPath ?? '')
  if (!voiceoverPath) throw new Error('ไม่พบไฟล์เสียงพากย์ — อัดเสียงพากย์ก่อนเรนเดอร์')
  // `voiceover/` is a synced root, so on a re-render in another browser the
  // recording is on the server and not in this store. blobForPath's own error
  // is kept: it already distinguishes an expired session from a missing file,
  // and flattening both into an English string with an internal noeyfs:// path
  // sent users hunting for a recording that was intact on the server.
  const voiceoverFile = await blobForPath(voiceoverPath)

  // The mix has to be built before the frame loop starts, so its length is
  // computed from the cut list rather than measured off the finished video —
  // and it has to be computed the SAME way. `renderCutList` rounds each cut to
  // a whole number of frames independently (cutRender.ts), so summing the raw
  // durations gave the audio a different length from the picture by the
  // accumulated rounding of every cut. `renderTimeline` already does it this
  // way; this call site did not.
  const quantise = (sec: number): number => Math.max(1, Math.round(sec * OUTPUT_FPS)) / OUTPUT_FPS
  const nominalSec = cuts.reduce((n, c) => n + quantise(Math.max(0, c.sourceOut - c.sourceIn)), 0)

  const musicPath = job.musicPath ? String(job.musicPath) : ''
  const audio = await renderMix({
    durationSec: nominalSec,
    voice: await decodeBlob(voiceoverFile),
    music: musicPath ? await decodeStored(musicPath) : null,
    musicVolume: Number(job.musicVolume ?? 0.25),
    musicOffsetSec: Number(job.musicOffsetSec ?? 0),
    musicTrimInSec: Number(job.musicTrimInSec ?? 0),
    musicTrimOutSec: job.musicTrimOutSec == null ? null : Number(job.musicTrimOutSec)
  })

  emit({ event: 'progress', stage: 'cut', step: 1, total: cuts.length })

  const out = await renderCutList({
    outPath: projectFilePath(uid, 'final.mp4'),
    uid,
    cuts,
    audio,
    captionStyle: job.captionStyle as CaptionStyle | undefined,
    captionLines: (job.captionLines as CaptionLine[] | undefined) ?? [],
    captionWords: (job.captionWords as CaptionWord[] | undefined) ?? [],
    signal: job.signal as AbortSignal | undefined,
    onSegment: (step, total) => emit({ event: 'progress', stage: 'cut', step, total }),
    onFrame: (done, total) =>
      emit({
        event: 'progress',
        stage: 'mux',
        step: done,
        total,
        message: `${Math.round((done / total) * 100)}%`
      })
  })

  emit({ event: 'progress', stage: 'bundle', step: cuts.length, total: cuts.length })
  await buildFinalBundle(uid, {
    final: out.video,
    scriptTxt: await readText(projectFilePath(uid, 'script.txt'))
  })

  // A bake made from the silent pre-VO cut must not outrank the voiced final.
  await deleteFile(projectFilePath(uid, 'final_fx.mp4'))

  return {
    event: 'done',
    final: projectFilePath(uid, 'final.mp4'),
    bundle: projectFilePath(uid, 'final_bundle.zip'),
    durationSec: out.durationSec,
    cuts: cuts.length,
    clipDurationsSec: out.clipDurationsSec
  }
})
