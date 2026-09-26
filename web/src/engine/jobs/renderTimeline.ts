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
import { concatSourceAudio, decodeBlob, MIX_SAMPLE_RATE, type SourceAudioCut } from '../audio'
import { openAudioSource, type AudioSource } from '../audioStream'
import { quantiseToFrames } from '../util'
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

  // Each cut's own window, decoded from the clip it references — not every
  // project clip in full. A talking-head source can be two hours long and a
  // cut list references seconds of it; decoding whole clips read each one
  // into memory entire (multi-gigabyte) and did it for clips no cut used.
  // The container is opened once per clip and kept for every cut from it.
  const project = await window.noey.projects.get(uid)
  const sources = project?.clips ?? []
  const clipById = new Map(sources.map((c) => [c.id, c]))
  const opened = new Map<string, AudioSource | null>()
  // The whole-clip path survives only for a track the streamed decoder will
  // not open; that buffer is then sliced by `sourceIn` as before.
  const whole = new Map<string, AudioBuffer>()
  const audioCuts: SourceAudioCut[] = []
  try {
    for (const cut of cuts) {
      const durationSec = quantiseToFrames(cut.sourceOut - cut.sourceIn, OUTPUT_FPS)
      const c = clipById.get(cut.sourceClip)
      // Only a clip that HAS no audio may become silence. This catch used to
      // swallow fetch and decode failures too — and these are the modes built
      // on the original audio, so one transient failure here wrote a silent
      // final.mp4, reported it as done, and the size-diffed sync then pushed
      // it over the good server copy.
      if (!c || c.hasAudio === false) {
        audioCuts.push({ buffer: null, sourceIn: 0, durationSec })
        continue
      }
      try {
        if (!opened.has(c.id)) {
          const blob = await blobForPath(projectFilePath(uid, c.file))
          const source = await openAudioSource(blob)
          opened.set(c.id, source)
          if (!source) whole.set(c.id, await decodeBlob(blob, opts.signal))
        }
        const source = opened.get(c.id)
        if (source) {
          const buffer = await source.decode({
            sampleRate: MIX_SAMPLE_RATE,
            channels: 'source',
            startSec: cut.sourceIn,
            endSec: cut.sourceIn + durationSec,
            signal: opts.signal
          })
          audioCuts.push({ buffer, sourceIn: 0, durationSec })
        } else {
          audioCuts.push({ buffer: whole.get(c.id) ?? null, sourceIn: cut.sourceIn, durationSec })
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') throw err
        throw new Error(
          `อ่านเสียงจากคลิปต้นฉบับไม่ได้ (${c.file.split('/').pop()}) — ลองใหม่อีกครั้ง`
        )
      }
    }
  } finally {
    for (const s of opened.values()) s?.close()
  }
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
