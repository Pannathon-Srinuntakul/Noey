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
import { encodeVideo, openVideo, type SourceInfo } from '../media'

/** Even dimensions — H.264 requires them, and odd sizes fail to configure. */
function even(n: number): number {
  return n % 2 === 0 ? n : n - 1
}

export async function transcodeToH264(
  source: Blob,
  info: SourceInfo,
  signal?: AbortSignal
): Promise<Blob> {
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

  // The SOURCE's audio, carried across. Without this the conversion produced a
  // silent file — and since every undecodable clip goes through here, a phone
  // recording imported this way lost its sound before the user ever saw a
  // timeline. Anything that speaks the original audio (talking_head, both
  // speech modes) then had nothing to work from.
  //
  // Decoded through the browser's own audio path rather than the video one:
  // the container opens for audio even when the video codec does not, which is
  // exactly the case this function exists for. If it does not, the conversion
  // still succeeds — silent, as it always was — rather than refusing the clip.
  const audio = await decodeBlob(source).catch(() => null)
  if (!audio) {
    void window.noey.log.write('transcode', 'source audio could not be decoded — output is silent')
  }

  try {
    const out = await encodeVideo(
      frames,
      async (ctx) => {
        const frame = (await pass.next()).value ?? null
        if (!frame) return false
        ctx.drawImage(frame, 0, 0, width, height)
        return true
      },
      { width, height, fps, signal, audio }
    )
    if (!out) throw new Error('แปลงไฟล์ไม่สำเร็จ')
    return out
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
