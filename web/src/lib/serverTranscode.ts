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

  onProgress?.({ percent: 5, message: 'รอคิวแปลงไฟล์…' })
  const finalStatus = await pollJob(
    session,
    ticket.job_id,
    (status: JobStatus) => {
      const msg = (status.result as { message?: string } | null)?.message
      onProgress?.({ percent: status.progress ?? 0, message: msg || 'กำลังแปลงไฟล์…' })
    },
    { signal }
  )
  // The worker reports the converted size — the only way to tell a complete
  // download from one the connection dropped mid-body with a 200 already sent
  // (live: ERR_HTTP2_PROTOCOL_ERROR at "200 OK", 2026-09-09).
  const expectedBytes = Number((finalStatus?.result as { bytes?: number } | null)?.bytes) || 0

  const blob = await downloadConverted(session, ticket.token, expectedBytes, onProgress, signal)

  // DELETE only now, with the bytes verified in hand. It used to run in a
  // `finally`, so ONE failed download destroyed the server's copy and every
  // retry after it was doomed to 404/422 — the "กดลองใหม่ก็ไม่ได้" half of the
  // report. A conversion that fails here is reclaimed by the server's daily
  // sweep instead; the privacy promise holds either way.
  void authedFetch(session, `/videos/transcode/${ticket.token}`, {
    method: 'DELETE'
  }).catch(() => undefined)

  onProgress?.({ percent: 100, message: 'แปลงไฟล์เสร็จแล้ว' })
  return blob
}

/** How many times a broken download is resumed before giving up. */
const DOWNLOAD_ATTEMPTS = 5

/**
 * Download with resume. The server's FileResponse answers Range with 206, so a
 * body that dies mid-stream is continued from the bytes already held instead
 * of starting over — on the multi-hundred-MB files this endpoint serves, a
 * restart is usually how the NEXT attempt dies too.
 */
async function downloadConverted(
  session: ApiSession,
  token: string,
  expectedBytes: number,
  onProgress?: (p: TranscodeProgress) => void,
  signal?: AbortSignal
): Promise<Blob> {
  const parts: BlobPart[] = []
  let received = 0
  let lastError: unknown = null

  for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)))
    }
    try {
      const resume = received > 0
      const res = await authedFetch(session, `/videos/transcode/${token}`, {
        signal,
        ...(resume ? { headers: { Range: `bytes=${received}-` } } : {})
      })
      if (!res.ok) throw new ApiError(res.status, await readError(res))
      if (resume && res.status !== 206) {
        // The server (or something between) ignored the Range — appending this
        // body to what is held would interleave two copies. Start clean.
        parts.length = 0
        received = 0
      }
      const reader = res.body?.getReader()
      if (!reader) throw new Error('อ่านไฟล์ที่แปลงแล้วไม่ได้')
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        parts.push(value)
        received += value.byteLength
        if (expectedBytes > 0) {
          const pct = 95 + Math.min(4, Math.round((received / expectedBytes) * 4))
          onProgress?.({ percent: pct, message: 'กำลังรับไฟล์ที่แปลงแล้ว…' })
        }
      }
      if (expectedBytes > 0 && received !== expectedBytes) {
        // Stream ended clean but short — treat like a drop and resume.
        lastError = new Error(`ได้ไฟล์ไม่ครบ (${received}/${expectedBytes} ไบต์)`)
        continue
      }
      return new Blob(parts, { type: 'video/mp4' })
    } catch (err) {
      if (signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) throw err
      if (err instanceof ApiError) throw err // a real 4xx/5xx — retrying is noise
      lastError = err // network drop mid-body: keep `received`, resume
    }
  }
  throw new Error(
    `ดาวน์โหลดไฟล์ที่แปลงแล้วไม่สำเร็จ (เน็ตหลุดระหว่างทาง) — กดลองใหม่ได้เลย ไฟล์ที่แปลงไว้ยังอยู่: ${String(
      lastError instanceof Error ? lastError.message : lastError
    )}`
  )
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
