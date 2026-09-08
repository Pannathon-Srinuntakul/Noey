/**
 * Convert a clip the browser cannot decode, using the server's ffmpeg.
 *
 * WEB ONLY. This file has no counterpart in the desktop build, which decodes
 * everything locally and never needs it.
 *
 * The web build's promise is that video stays on the user's machine, and this
 * is the one deliberate exception to it. A browser cannot decode some codecs
 * at all — HEVC most of all, which every recent iPhone records by default —
 * and no amount of client-side work changes that. Refusing those clips means
 * refusing most phone footage.
 *
 * So the exception is kept as small as it can be:
 *
 *   - only clips the client FAILED to open are sent. H.264 (the common case)
 *     is remuxed locally in milliseconds and never leaves the machine;
 *   - the server converts the codec and nothing else — no cut, no AI, no
 *     render, and the resolution is the source's own;
 *   - the moment the bytes are back, `DELETE` removes both files. The server
 *     is a converter, not a store.
 *
 * Measured on a 6:27 1080×1920 HEVC clip: ~85 s of CPU on 2 cores, and the
 * result is 61% smaller than the source.
 */

import { ApiError } from './api'
import { authedFetch, serverMessage } from './authedFetch'
import { pollJob, type ApiSession, type JobStatus } from './videosLocalApi'

export interface TranscodeProgress {
  /** 0–100, straight from the job row. */
  percent: number
  message: string
}

interface TranscodeTicket {
  job_id: string
  token: string
}

/**
 * Upload → convert → download → delete.
 *
 * Returns the converted MP4. Throws with a message the card can show; the
 * server-side scratch is dropped on failure too, so a refused conversion
 * leaves nothing behind.
 */
export async function transcodeOnServer(
  session: ApiSession,
  file: Blob,
  filename: string,
  onProgress?: (p: TranscodeProgress) => void,
  signal?: AbortSignal
): Promise<Blob> {
  const form = new FormData()
  form.append('file', file, filename)

  onProgress?.({ percent: 0, message: 'กำลังส่งไฟล์ไปแปลง…' })

  // `authedFetch`, not the shared `request` helper: that one carries a JSON
  // body through the platform bridge, and this needs to stream a multi-hundred
  // megabyte body and read binary back. What it keeps is the refresh-on-401 —
  // a conversion is the longest-running call in the app and the token it
  // started with may well have lapsed by the time the bytes come back.
  const upload = await authedFetch(session, '/videos/transcode', {
    method: 'POST',
    body: form,
    signal
  })
  if (!upload.ok) {
    throw new ApiError(upload.status, await readError(upload))
  }
  const ticket = (await upload.json()) as TranscodeTicket

  try {
    onProgress?.({ percent: 5, message: 'รอคิวแปลงไฟล์…' })
    await pollJob(
      session,
      ticket.job_id,
      (status: JobStatus) => {
        const msg = (status.result as { message?: string } | null)?.message
        onProgress?.({ percent: status.progress ?? 0, message: msg || 'กำลังแปลงไฟล์…' })
      },
      { signal }
    )

    onProgress?.({ percent: 95, message: 'กำลังรับไฟล์ที่แปลงแล้ว…' })
    const res = await authedFetch(session, `/videos/transcode/${ticket.token}`, { signal })
    if (!res.ok) throw new ApiError(res.status, await readError(res))
    const blob = await res.blob()
    onProgress?.({ percent: 100, message: 'แปลงไฟล์เสร็จแล้ว' })
    return blob
  } finally {
    // Always — success, failure or cancellation. Leaving a copy on the server
    // is exactly what this whole design exists to avoid.
    void authedFetch(session, `/videos/transcode/${ticket.token}`, {
      method: 'DELETE'
    }).catch(() => undefined)
  }
}

function readError(res: Response): Promise<string> {
  return serverMessage(res, 'แปลงไฟล์ไม่สำเร็จ')
}

/**
 * A poster frame for a clip this browser cannot decode.
 *
 * The client can DEMUX what it cannot DECODE, so `firstFrameClip` cuts the
 * first key packet into a tiny self-contained MP4 — 48 KB out of a 9 MB HEVC
 * source, in 11 ms — and only that is sent. The server decodes one frame and
 * returns a JPEG.
 *
 * Returns null on any failure: a thumbnail is decoration, and the film icon is
 * a perfectly honest fallback.
 */
export async function posterFrameFromServer(
  session: ApiSession,
  source: Blob,
  signal?: AbortSignal
): Promise<Blob | null> {
  try {
    const { firstFrameClip } = await import('../engine/media')
    const clip = await firstFrameClip(source)
    if (!clip) return null

    const form = new FormData()
    form.append('file', clip, 'poster.mp4')
    const res = await authedFetch(session, '/videos/poster', {
      method: 'POST',
      body: form,
      signal
    })
    if (!res.ok) return null
    return await res.blob()
  } catch {
    return null
  }
}
