/**
 * `render-timeline` — the modes that keep the original audio.
 *
 * Mirrors `desktop/sidecar/sidecar/timeline_render.py:run_render_timeline`.
 * The difference from `render-final` is the whole point of the mode: the
 * source's own sound is cut and joined along with the picture instead of being
 * replaced by a voiceover.
 *
 * Captions are the other half. `timeline.words` are SOURCE-clock word
 * timestamps, and they have to be lifted onto the OUTPUT clock before anything
 * draws them — `remapWordsToOutput`, shared with the editor and pinned against
 * `caption.py` by its own tests. Burning source-clock times directly is a real
 * bug this code has had: a line at source 40 s on a 25 s output was drawn past
 * the end of the video and never appeared.
 *
 * Writes: clips/, the output (default `final.mp4`), the SRT beside it, and the
 * CapCut bundle when this is the project's single video.
 */

import { projectFilePath, writeFileAtomic, deleteFile } from '../../platform/fs'
import type { SidecarEvent } from '../../platform/types'
import type { CaptionStyle } from '../../lib/captionStyle'
import { captionLinesToSrt } from '../../lib/captionLines'
import { plainCaptionLines, timelineCaptionLines } from '../../lib/captionEdits'
import { clipAbsOffsets, remapWordsToOutput, type TimedWord } from '../../lib/timelineMath'
import { renderCutList, OUTPUT_FPS, type CutSpec } from '../cutRender'
import { concatSourceAudio, decodeBlob, type SourceAudioCut } from '../audio'
import { buildCapCutBundle, buildSrt } from '../bundle'
import { registerJob, type ProgressCallback } from '../index'
import { blobForPath } from './probe'

interface TimelineCut {
  type?: string
  in: number
  out: number
  source?: string
}

export interface TimelineJobResult {
  final: string
  srt: string
  bundle: string | null
  durationSec: number
  cuts: number
}

/**
 * The shared body — `render-highlights` runs this once per highlight rather
 * than re-implementing it, exactly as the desktop does.
 */
export async function renderTimelineInto(
  uid: string,
  timeline: Record<string, unknown>,
  opts: {
    outName?: string
    withBundle?: boolean
    signal?: AbortSignal
    emit?: ProgressCallback
  } = {}
): Promise<TimelineJobResult> {
  const outName = opts.outName ?? 'final.mp4'
  const withBundle = opts.withBundle !== false
  const emit = opts.emit ?? ((): void => undefined)

  const rawCuts = ((timeline.timeline as TimelineCut[]) ?? []).filter((c) => c.type === 'cut')
  if (rawCuts.length === 0) throw new Error('ไทม์ไลน์ไม่มีฉากให้เรนเดอร์ — ลองวางแผนใหม่อีกครั้ง')

  const cuts: CutSpec[] = rawCuts.map((c) => ({
    sourceClip: String(c.source ?? 'clip0'),
    sourceIn: Number(c.in),
    sourceOut: Number(c.out)
  }))

  // Decode each source's audio ONCE; a cut list usually revisits the same clip
  // many times and decoding per cut would dominate the render.
  const project = await window.noey.projects.get(uid)
  const sources = project?.clips ?? []
  const audioByClip = new Map<string, AudioBuffer | null>()
  for (const c of sources) {
    // Only a clip that HAS no audio may become silence. This catch used to
    // swallow fetch and decode failures too — and these are the modes built on
    // the original audio, so one transient failure here wrote a silent
    // final.mp4, reported it as done, and the size-diffed sync then pushed it
    // over the good server copy.
    if (c.hasAudio === false) {
      audioByClip.set(c.id, null)
      continue
    }
    try {
      audioByClip.set(c.id, await decodeBlob(await blobForPath(projectFilePath(uid, c.file))))
    } catch {
      throw new Error(
        `อ่านเสียงจากคลิปต้นฉบับไม่ได้ (${c.file.split('/').pop()}) — ลองใหม่อีกครั้ง`
      )
    }
  }

  const quantised = (sec: number): number => Math.max(1, Math.round(sec * OUTPUT_FPS)) / OUTPUT_FPS
  const audioCuts: SourceAudioCut[] = cuts.map((c) => ({
    buffer: audioByClip.get(c.sourceClip) ?? null,
    sourceIn: c.sourceIn,
    durationSec: quantised(c.sourceOut - c.sourceIn)
  }))
  const audio = await concatSourceAudio(audioCuts)

  // Source-clock words → output-clock words, then grouped into lines the same
  // way `build_ass_captions` groups them.
  const words = (timeline.words as TimedWord[] | undefined) ?? []
  const captionStyle = timeline.captionStyle as CaptionStyle | undefined
  const clipDurations = sources.map((c) => Number((c as { durationSec?: number }).durationSec ?? 0))
  const absOffsets = clipAbsOffsets(clipDurations)
  const outputWords = words.length
    ? remapWordsToOutput(
        words,
        rawCuts.map((c) => ({
          in: Number(c.in),
          out: Number(c.out),
          source: String(c.source ?? 'clip0')
        })) as Parameters<typeof remapWordsToOutput>[1],
        absOffsets
      )
    : []
  // Grouped from THIS cut every time, with the lines the user edited in the
  // editor laid over (captionEdits.ts). A stored full list used to win here,
  // so a trim or a deleted scene burned every later line at its old time.
  const captionLines = plainCaptionLines(timelineCaptionLines(timeline, clipDurations))

  emit({ event: 'progress', stage: 'cut', step: 1, total: cuts.length })

  const out = await renderCutList({
    outPath: projectFilePath(uid, outName),
    uid,
    cuts,
    audio,
    captionStyle,
    captionLines,
    captionWords: outputWords,
    writeClips: withBundle,
    signal: opts.signal,
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

  // The SRT sits beside a highlight (`hNN.srt`) but in `captions/` for the
  // single-video modes, so exporting one highlight grabs a matching pair.
  const srtRel = withBundle ? 'captions/subtitles.srt' : outName.replace(/\.mp4$/, '.srt')
  // The SRT is the lines just burned. It used to prefer the server plan's
  // `timeline.captions`, built for the AI's ORIGINAL cut, so after any edit
  // the exported subtitles and the CapCut bundle drifted off the speech.
  // Only a timeline with no transcript at all falls back to the plan's copy —
  // there is nothing to derive from, and no editor edit to lose.
  const planCaptions = words.length
    ? []
    : ((timeline.captions as { start: number; end: number; text: string }[] | undefined) ?? [])
  const srt = captionLines.length
    ? captionLinesToSrt(captionLines)
    : planCaptions.length
      ? buildSrt(planCaptions)
      : ''
  await writeFileAtomic(projectFilePath(uid, srtRel), new TextEncoder().encode(srt))

  let bundleRel: string | null = null
  if (withBundle) {
    emit({ event: 'progress', stage: 'bundle', step: cuts.length, total: cuts.length })
    await buildCapCutBundle(uid, {
      final: out.video,
      srt,
      mode: String(timeline.mode ?? 'talking_head'),
      outputName: outName
    })
    bundleRel = projectFilePath(uid, 'capcut_bundle.zip')
  }

  // The cut changed, so any zoom bake made from the old one is now a lie.
  await deleteFile(projectFilePath(uid, 'final_fx.mp4'))

  return {
    final: projectFilePath(uid, outName),
    srt: projectFilePath(uid, srtRel),
    bundle: bundleRel,
    durationSec: out.durationSec,
    cuts: cuts.length
  }
}

registerJob('render-timeline', async (job, emit: ProgressCallback): Promise<SidecarEvent> => {
  const uid = String(job.projectDir ?? '')
    .split('/')
    .pop() as string
  const result = await renderTimelineInto(uid, (job.timeline ?? {}) as Record<string, unknown>, {
    outName: job.outName ? String(job.outName) : undefined,
    withBundle: job.withBundle !== false,
    signal: job.signal as AbortSignal | undefined,
    emit
  })
  return { event: 'done', ...result }
})
