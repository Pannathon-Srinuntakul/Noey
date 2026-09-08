/**
 * `probe` — duration, size and whether there is audio.
 *
 * Accepts both path shapes the UI can hold: a file in the project store
 * (`noeyfs://…`) and one the user just picked (`picked://…`). The desktop
 * version only ever sees OS paths; here the two are the same question.
 *
 * Consumers read `duration` (voiceover length before planning, per-clip
 * durations for the effects cut points, music length in the editor) and
 * `width`/`height` (the wizard's clip cards). `has_audio` and `fps` are
 * reported for parity but nothing reads them yet.
 */

import { mediaUrlForFsPath, readFile, writeFileAtomic } from '../../platform/fs'
import { getPicked } from '../../platform/picked'
import { isPickedPath } from '../../platform/fs'
import type { SidecarEvent } from '../../platform/types'
import { canDecodeSource, probeSource } from '../media'
import { registerJob } from '../index'

export async function blobForPath(path: string): Promise<Blob> {
  if (isPickedPath(path)) {
    const file = getPicked(path)
    if (!file) throw new Error('ไฟล์ที่เลือกไว้หายไปแล้ว กรุณาเลือกไฟล์อีกครั้ง')
    return file
  }
  const file = await readFile(path)
  if (file) return file

  // Not in this browser's storage — which is the normal state for a project
  // opened somewhere else, or one Safari swept after seven idle days. The
  // service worker serves `/media/…` from the server in that case, so fetching
  // through it is how a job gets its bytes.
  //
  // The result is CACHED back into the store: a render reads its sources many
  // times over, and downloading a clip once per pass would be unusable.
  const url = mediaUrlForFsPath(path)
  const res = await fetch(url)
  // 401/403 means the session lapsed, not that the file is gone. Saying
  // "ไม่พบไฟล์" for an expired token sends people looking for a clip that is
  // sitting on the server exactly where they left it.
  if (res.status === 401 || res.status === 403) {
    throw new Error('เซสชันหมดอายุ กรุณารีเฟรชหน้าเว็บแล้วลองใหม่')
  }
  if (!res.ok) throw new Error(`ไม่พบไฟล์ ${path}`)
  const blob = await res.blob()
  try {
    await writeFileAtomic(path, blob)
  } catch {
    // A cache write that fails costs speed, not correctness.
  }
  return blob
}

registerJob('probe', async (job): Promise<SidecarEvent> => {
  const path = String(job.file ?? '')
  if (!path) throw new Error('ไม่ได้ระบุไฟล์')
  const blob = await blobForPath(path)
  const info = await probeSource(blob)
  return {
    event: 'probe',
    file: path,
    duration: info.durationSec,
    has_audio: info.hasAudio,
    width: info.width || null,
    height: info.height || null,
    fps: info.fps || null,
    // Web-only additions. The wizard asks BEFORE the user commits to a run:
    // an HEVC clip parses fine and decodes only on a platform that has an
    // HEVC decoder, and finding that out three screens later is the whole
    // problem this answers.
    codec: info.codec,
    decodable: await canDecodeSource(info),
    name: blob instanceof File ? blob.name : null
  }
})
