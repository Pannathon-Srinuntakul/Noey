/**
 * `render-silent` — the cut itself.
 *
 * The desktop trims every segment to its own file, then joins them with the
 * concat demuxer under `-c copy`. That is where the green-frame bug lived: two
 * sources of different size produced a file whose resolution changed
 * mid-stream while its header still advertised the first one.
 *
 * There is no concat here — see `engine/cutRender.ts`, which owns the frame
 * loop this and `render-final` share.
 *
 * Output contract, matching `desktop/sidecar/sidecar/dub.py:run_render_silent`:
 *
 *   clips/clip_NNN.mp4          one file per scene
 *   final_silent.mp4            the cut
 *   final_silent_music.mp4      the same cut with a music bed, when one exists
 *   script.txt                  the voiceover script, grouped by line
 *   dub_bundle.zip              both of the above plus the per-scene clips
 *
 * and the `done` event carries `clipDurationsSec`, the one field the UI reads:
 * it builds the effects cut points from MEASURED durations because summing the
 * nominal ones accumulates rounding error across segments.
 */

import { projectFilePath, writeFileAtomic, deleteFile } from '../../platform/fs'
import type { SidecarEvent } from '../../platform/types'
import type { CaptionLine } from '../../lib/captionLines'
import type { CaptionStyle } from '../../lib/captionStyle'
import type { CaptionWord } from '../captions'
import { renderCutList, OUTPUT_FPS, type CutSpec } from '../cutRender'
import { normalizeDubEditScript, buildScriptTxt, type DubEditScript } from '../editScript'
import { mixMusicOnto } from '../audio'
import { buildDubBundle } from '../bundle'
import { registerJob, type ProgressCallback } from '../index'

registerJob('render-silent', async (job, emit: ProgressCallback): Promise<SidecarEvent> => {
  const uid = String(job.projectDir ?? '')
    .split('/')
    .pop() as string

  const script = normalizeDubEditScript((job.editScript ?? {}) as DubEditScript)
  const segments = script.segments ?? []
  if (segments.length === 0) throw new Error('Edit script has no segments')

  const cuts: CutSpec[] = segments.map((seg) => ({
    sourceClip: String(seg.sourceClip ?? 'clip0'),
    sourceIn: Number(seg.sourceIn),
    sourceOut: Number(seg.sourceOut)
  }))

  emit({ event: 'progress', stage: 'cut', step: 1, total: cuts.length })

  const out = await renderCutList({
    uid,
    cuts,
    captionStyle: job.captionStyle as CaptionStyle | undefined,
    captionLines: (job.captionLines as CaptionLine[] | undefined) ?? [],
    captionWords: (job.captionWords as CaptionWord[] | undefined) ?? [],
    signal: job.signal as AbortSignal | undefined,
    onSegment: (step, total) => emit({ event: 'progress', stage: 'cut', step, total }),
    onFrame: (done, total) =>
      emit({
        event: 'progress',
        stage: 'concat',
        step: done,
        total,
        message: `${Math.round((done / total) * 100)}%`
      })
  })

  await writeFileAtomic(projectFilePath(uid, 'final_silent.mp4'), out.video)

  const scriptTxt = buildScriptTxt(segments, (job.brief as string) ?? null)
  await writeFileAtomic(projectFilePath(uid, 'script.txt'), new TextEncoder().encode(scriptTxt))

  // Music, when a track is attached. Same parameter meanings as
  // `dub_render.mix_audio_layers`: trim first, then offset, then volume.
  let musicMixed: Blob | null = null
  const musicPath = job.musicPath ? String(job.musicPath) : ''
  if (musicPath) {
    emit({ event: 'progress', stage: 'music', step: 1, total: 1 })
    musicMixed = await mixMusicOnto(out.video, {
      musicPath,
      volume: Number(job.musicVolume ?? 0.25),
      offsetSec: Number(job.musicOffsetSec ?? 0),
      trimInSec: Number(job.musicTrimInSec ?? 0),
      trimOutSec: job.musicTrimOutSec == null ? null : Number(job.musicTrimOutSec),
      width: out.width,
      height: out.height,
      fps: OUTPUT_FPS
    })
    await writeFileAtomic(projectFilePath(uid, 'final_silent_music.mp4'), musicMixed)
  } else {
    // A track that was removed must not leave its mix behind: the preview
    // prefers the music version and would keep playing the old one.
    await deleteFile(projectFilePath(uid, 'final_silent_music.mp4'))
  }

  emit({ event: 'progress', stage: 'bundle', step: 1, total: 1 })
  await buildDubBundle(uid, { finalSilent: out.video, scriptTxt, musicMixed })

  // The cut changed, so a zoom bake made from the previous one is a lie.
  await deleteFile(projectFilePath(uid, 'final_fx.mp4'))

  return {
    event: 'done',
    durationSec: out.durationSec,
    clipDurationsSec: out.clipDurationsSec,
    segments: segments.length
  }
})
