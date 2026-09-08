/**
 * The one frame loop both renders use.
 *
 * `render-silent` cuts an edit script; `render-final` cuts a timeline and muxes
 * the voiceover onto it. The desktop keeps those as two ffmpeg pipelines that
 * happen to share `trim_media`; here they share the loop itself, because the
 * loop is the whole render — every frame of the output is drawn onto one canvas
 * of one fixed size, and that is what makes a mixed-source project impossible
 * to render into a mixed-shape file.
 */

import { projectFilePath, writeFileAtomic, deleteDir } from '../platform/fs'
import type { CaptionLine } from '../lib/captionLines'
import type { CaptionStyle } from '../lib/captionStyle'
import { drawCaption, ensureCaptionFont, resolveCaptionStyle, type CaptionWord } from './captions'
import {
  encodeVideo,
  openClipWriter,
  openVideo,
  probeSource,
  type ClipWriter,
  type VideoReader
} from './media'
import { blobForPath } from './jobs/probe'

/** The pipeline renders at 30 fps; the editor's frame nudge assumes it too. */
export const OUTPUT_FPS = 30

export interface CutSpec {
  /** Which imported clip this cut comes from — `clip0`, `clip1`, … */
  sourceClip: string
  sourceIn: number
  sourceOut: number
}

export interface CutRenderRequest {
  uid: string
  cuts: CutSpec[]
  captionStyle?: CaptionStyle
  captionLines?: CaptionLine[]
  captionWords?: CaptionWord[]
  /** Mixed to the output's own length; null renders a silent file. */
  audio?: AudioBuffer | null
  signal?: AbortSignal
  onSegment?: (index: number, total: number) => void
  onFrame?: (done: number, total: number) => void
  /**
   * Write `clips/clip_NNN.mp4` alongside the joined render.
   *
   * Off for highlights: each highlight is self-contained and there is no
   * bundle to put per-scene files in, so writing them would only mean N sets
   * of clips overwriting each other under one name.
   */
  writeClips?: boolean
}

export interface CutRenderResult {
  video: Blob
  width: number
  height: number
  durationSec: number
  /** One entry per cut, measured in whole output frames. */
  clipDurationsSec: number[]
}

interface UploadSource {
  id: string
  file: string
}

/**
 * The output's shape: the first cut's source, exactly like the desktop's
 * `segment_geometry`/`target_geometry`. A single-source project is therefore
 * conformed to itself and nothing about it changes.
 */
async function outputGeometry(
  uid: string,
  clips: UploadSource[],
  firstClipId: string
): Promise<{ width: number; height: number }> {
  const first = clips.find((c) => c.id === firstClipId) ?? clips[0]
  const info = await probeSource(await blobForPath(projectFilePath(uid, first.file)))
  const even = (n: number): number => (n % 2 === 0 ? n : n - 1)
  return { width: even(info.width), height: even(info.height) }
}

/**
 * Cut, join, caption and encode — and write `clips/clip_NNN.mp4` on the way.
 *
 * The per-scene clips come out of the SAME pass (`mirror`): the desktop builds
 * them first and concatenates them, but there is no concat here, so producing
 * them separately would mean decoding every source a second time.
 */
export async function renderCutList(req: CutRenderRequest): Promise<CutRenderResult> {
  const { uid, cuts } = req
  if (cuts.length === 0) throw new Error('ไทม์ไลน์ไม่มีฉาก')

  const project = await window.noey.projects.get(uid)
  const clips: UploadSource[] = (project?.clips ?? []).map((c) => ({ id: c.id, file: c.file }))
  if (clips.length === 0) throw new Error('ยังไม่ได้นำเข้าคลิป')

  const { width, height } = await outputGeometry(uid, clips, cuts[0].sourceClip)

  const readers = new Map<string, VideoReader>()
  for (const c of clips) {
    readers.set(c.id, await openVideo(await blobForPath(projectFilePath(uid, c.file))))
  }

  // Lay the cuts out on the output clock. Each one's LENGTH is quantised to
  // whole frames here, which is what makes the reported durations exact rather
  // than a nominal figure the render then rounds.
  const timeline: { reader: VideoReader; sourceIn: number; frames: number }[] = []
  const clipDurationsSec: number[] = []
  for (const cut of cuts) {
    const reader = readers.get(cut.sourceClip) ?? readers.get(clips[0].id)
    if (!reader) throw new Error(`ไม่พบคลิปต้นทาง ${cut.sourceClip}`)
    const frames = Math.max(1, Math.round(Math.max(0, cut.sourceOut - cut.sourceIn) * OUTPUT_FPS))
    timeline.push({ reader, sourceIn: cut.sourceIn, frames })
    clipDurationsSec.push(Math.round((frames / OUTPUT_FPS) * 1000) / 1000)
  }
  const totalFrames = timeline.reduce((n, s) => n + s.frames, 0)

  const writeClips = req.writeClips !== false
  if (writeClips) await deleteDir(projectFilePath(uid, 'clips'))

  /**
   * The per-scene clip being written right now — ONE encoder, not one per cut.
   *
   * Opening them all up front cost nothing on a desktop and was how this
   * started, but it means N live `VideoEncoder`s for an N-scene project: 29 of
   * them on a 1080x1920 timeline. A phone has a handful of hardware encoder
   * contexts and a tab memory ceiling, so that shape fails there for reasons
   * that never show up here. Each clip is opened when its cut starts, written
   * to disk when the cut ends, and released.
   */
  let clipWriter: ClipWriter | null = null

  const style = resolveCaptionStyle(req.captionStyle, width, height)
  const captionLines = req.captionLines ?? []
  const burnCaptions = !!req.captionStyle && captionLines.length > 0
  if (burnCaptions) await ensureCaptionFont(style)

  // Which cut covers output frame N, walked forward rather than searched.
  let segIndex = 0
  let segStartFrame = 0

  /**
   * One sequential decode pass per cut, opened when the cut starts.
   *
   * Pulling frames one at a time through `frameAt` re-seeks for every frame;
   * feeding the whole run of timestamps to the decoder at once is what makes a
   * long render finish. See `media.ts:VideoReader.framesAt`.
   */
  const openPass = (index: number): AsyncGenerator<CanvasImageSource | null> => {
    const seg = timeline[index]
    const stamps: number[] = []
    for (let f = 0; f < seg.frames; f++) stamps.push(seg.sourceIn + f / OUTPUT_FPS)
    return seg.reader.framesAt(stamps)
  }
  let pass = openPass(0)

  const clipName = (index: number): string => `clips/clip_${String(index + 1).padStart(3, '0')}.mp4`

  /** Finish the open clip and write it out, freeing its encoder and its bytes. */
  const closeClip = async (index: number): Promise<void> => {
    if (!clipWriter) return
    const done = clipWriter
    clipWriter = null
    await writeFileAtomic(projectFilePath(uid, clipName(index)), await done.finish())
  }

  if (writeClips) clipWriter = await openClipWriter(width, height, OUTPUT_FPS)

  try {
    req.onSegment?.(1, cuts.length)

    const video = await encodeVideo(
      totalFrames,
      async (ctx, frame, timeSec) => {
        while (
          segIndex < timeline.length - 1 &&
          frame >= segStartFrame + timeline[segIndex].frames
        ) {
          segStartFrame += timeline[segIndex].frames
          await closeClip(segIndex)
          segIndex += 1
          await pass.return(undefined)
          pass = openPass(segIndex)
          if (writeClips) clipWriter = await openClipWriter(width, height, OUTPUT_FPS)
          req.onSegment?.(segIndex + 1, cuts.length)
        }
        const src = (await pass.next()).value ?? null
        if (!src) return false

        // COVER, never stretch: a source of a different aspect keeps its
        // proportions and loses the overflow, rather than being squashed.
        const sw = (src as { width?: number }).width ?? width
        const sh = (src as { height?: number }).height ?? height
        const scale = Math.max(width / sw, height / sh)
        ctx.fillStyle = '#000000'
        ctx.fillRect(0, 0, width, height)
        ctx.drawImage(
          src,
          (width - sw * scale) / 2,
          (height - sh * scale) / 2,
          sw * scale,
          sh * scale
        )

        if (burnCaptions) drawCaption(ctx, timeSec, captionLines, style, req.captionWords ?? [])
        return true
      },
      {
        width,
        height,
        fps: OUTPUT_FPS,
        audio: req.audio ?? null,
        signal: req.signal,
        mirror: () => clipWriter
      },
      {},
      (done, total) => req.onFrame?.(done, total)
    )
    if (!video) throw new Error('ประมวลผลวิดีโอไม่สำเร็จ')

    // The last cut has no successor to close it.
    await closeClip(segIndex)

    return {
      video,
      width,
      height,
      durationSec: Math.round((totalFrames / OUTPUT_FPS) * 1000) / 1000,
      clipDurationsSec
    }
  } catch (err) {
    // A half-written clip on disk would be indistinguishable from a finished
    // one, and the bundle zips whatever `clips/` holds. The clips already
    // written are consistent with the cut list up to this point; the one still
    // open is not, so it is dropped rather than flushed.
    await clipWriter?.cancel()
    clipWriter = null
    throw err
  } finally {
    await pass.return(undefined).catch(() => undefined)
    for (const r of readers.values()) r.close()
  }
}
