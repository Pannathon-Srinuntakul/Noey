/**
 * Re-encode a clip the browser cannot edit into one it can.
 *
 * The desktop does this at ingest for a seeking bug — HEVC plays in Chromium
 * but does not seek, so a timeline built on it is unusable. On the web the
 * problem is one step earlier: if `VideoDecoder` will not open the codec at
 * all, there are no frames to draw and no edit to make.
 *
 * So this is a straight decode-and-re-encode: read every frame, draw it onto a
 * canvas of the source's own display size, encode H.264. If the decode itself
 * fails, the clip is refused with a sentence the user can act on rather than a
 * stack trace three screens later.
 */

import { decodeBlob } from '../audio'
import { deleteFile, openStagedWrite, readFile, writeFileAtomic } from '../../platform/fs'
import { attachDonorAudio, encodeVideo, openVideo, remuxWithAudio, type SourceInfo } from '../media'

/** Even dimensions — H.264 requires them, and odd sizes fail to configure. */
function even(n: number): number {
  return n % 2 === 0 ? n : n - 1
}

/**
 * PCM fallback ceiling. Only a donor whose audio cannot be packet-copied is
 * ever decoded, and only up to this long: whole-file PCM is ~384 kB/s, so
 * 15 minutes is ~350 MB — survivable once, where the 2 h cap's 2.7 GB is not.
 * A longer donor with uncopyable audio converts silent, with an honest log.
 */
const PCM_FALLBACK_MAX_SEC = 15 * 60

export async function transcodeToH264(
  source: Blob,
  info: SourceInfo,
  signal: AbortSignal | undefined,
  outPath: string
): Promise<void> {
  let reader
  try {
    reader = await openVideo(source)
  } catch {
    throw new Error(
      'ไฟล์นี้เปิดในเบราว์เซอร์ไม่ได้ ลองส่งออกจากแอปกล้องเป็น MP4 (H.264) แล้วนำเข้าใหม่'
    )
  }

  // The source's own resolution, kept: this converts the format, it does not
  // resize. Only the odd-pixel rounding H.264 forces is applied.
  const width = even(reader.width || info.width)
  const height = even(reader.height || info.height)
  const fps = info.fps || 30
  const frames = Math.max(1, Math.round(info.durationSec * fps))

  // ONE sequential decode pass, not a seek per frame. A 6-minute clip is
  // ~11,600 frames, and pulling those one at a time re-walks the same GOP over
  // and over — the same difference that took a 27-cut render from 263 s to
  // 19 s (see media.ts:VideoReader.framesAt).
  const stamps: number[] = []
  for (let f = 0; f < frames; f++) stamps.push(f / fps)
  const pass = reader.framesAt(stamps)

  // Two passes, both streamed to OPFS: the video is encoded WITHOUT audio to a
  // temp path, then the source's audio packets are copied under it. No PCM is
  // decoded and no output MP4 is ever held in RAM — the old shape did both,
  // which on a 2 h clip meant gigabytes.
  const tempPath = `${outPath}.videoonly.mp4`

  try {
    const staged = await openStagedWrite(tempPath)
    try {
      await encodeVideo(
        frames,
        async (ctx) => {
          const frame = (await pass.next()).value ?? null
          if (!frame) return false
          ctx.drawImage(frame, 0, 0, width, height)
          return true
        },
        { width, height, fps, signal },
        { writable: staged.writable }
      )
      await staged.publish()
    } catch (err) {
      await staged.discard().catch(() => undefined)
      throw err
    }

    const videoOnly = await readFile(tempPath)
    if (!videoOnly) throw new Error('แปลงไฟล์ไม่สำเร็จ')

    // The common case: AAC (every iPhone recording) copies straight across.
    if (await attachDonorAudio(videoOnly, source, outPath, signal)) {
      await deleteFile(tempPath)
      return
    }

    // Uncopyable audio. Decode it ONLY when the PCM is survivable; otherwise
    // the clip converts silent — and says so in the log, not in a later
    // stage's misdiagnosis.
    if (info.hasAudio && info.durationSec <= PCM_FALLBACK_MAX_SEC) {
      try {
        const pcm = await decodeBlob(source)
        const mixed = await remuxWithAudio(videoOnly, pcm)
        if (mixed) {
          await writeFileAtomic(outPath, mixed)
          await deleteFile(tempPath)
          return
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') throw err
        void window.noey.log.write('transcode', `audio fallback failed: ${String(err)}`)
      }
    }

    if (info.hasAudio) {
      void window.noey.log.write(
        'transcode',
        `source audio could not be carried across — output is silent (${info.durationSec.toFixed(0)}s)`
      )
    }
    await writeFileAtomic(outPath, videoOnly)
    await deleteFile(tempPath)
    return
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err
    // Say what actually went wrong. This used to report "the browser cannot
    // open this file" for every failure in here — including the ones where the
    // file opened perfectly and something else broke, which sent people off to
    // re-export a clip that was never the problem.
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`แปลงไฟล์เป็น MP4 ไม่สำเร็จ — ${detail}`)
  } finally {
    await pass.return(undefined).catch(() => undefined)
    reader.close()
  }
}
