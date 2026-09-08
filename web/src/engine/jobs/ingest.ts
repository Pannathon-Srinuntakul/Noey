/**
 * `ingest` — bring the picked clips into the project.
 *
 * A port of `desktop/sidecar/sidecar/ingest.py`, keeping its output contract
 * exactly: files land at `normalized/norm_NNN.<ext>`, a manifest is written to
 * `upload_sources.json`, and the `done` event carries the `clips` array the UI
 * stores verbatim onto `project.clips`.
 *
 * Two of the desktop's three normalisation rules survive:
 *
 *   - the DURATION CAPS, message for message, because they protect the AI call
 *     downstream and the user has to read the same sentence either way;
 *   - the RE-ENCODE GATE, for a different reason than the desktop's. There it
 *     was about seeking: HEVC plays but does not seek in Chromium. Here a codec
 *     the browser cannot decode cannot be edited at all, so anything WebCodecs
 *     refuses is re-encoded to H.264 — and if it refuses to decode it too, the
 *     clip is rejected with a plain sentence rather than failing later.
 *
 * The third — muxing a silent audio track onto a silent clip — is dropped. It
 * existed so `-c copy` concat would see identical stream layouts; nothing here
 * concatenates streams, the composer draws frames and mixes audio separately.
 */

import { projectFilePath, writeFileAtomic, deleteDir, readFile } from '../../platform/fs'
import { stageIntoStore, stagingDir } from '../../platform/picked'
import { signalOf, throwIfAborted } from '../abort'
import type { LocalClip, SidecarEvent } from '../../platform/types'
import { probeSource } from '../media'
import { registerJob, type ProgressCallback } from '../index'
import { blobForPath } from './probe'
import { canDecodeSource, remuxToMp4 } from '../media'
import { transcodeToH264 } from './transcode'

/** Same ceilings as `packages/video/scene.py` and `timeline.py`. */
const DUB_MAX_CLIP_SEC = 2 * 60 * 60
const DUB_UPLOAD_TOLERANCE_SEC = 5
const DUB_FIRST_MAX_TOTAL_SEC = 2 * 60 * 60 + 10
const TALKING_HEAD_MAX_TOTAL_SEC = 2 * 60 * 60

/**
 * Everything lands as H.264 in an MP4 — no exceptions, and no guessing later
 * about what a stored clip is.
 *
 * Three ways to get there, cheapest first:
 *
 *   already H.264   copy the packets into an MP4 container. Seconds, and the
 *                   pictures are bit-identical — a phone's `.mov` is usually
 *                   H.264 already, so re-encoding it would spend minutes and a
 *                   generation of quality to arrive where it started.
 *   decodable       decode and re-encode at the SOURCE's own resolution.
 *   not decodable   refused, with the reason. HEVC is the case that matters:
 *                   it demuxes everywhere and decodes only where the platform
 *                   has a decoder, so this is a property of the browser, not
 *                   of the file.
 */
const PASSTHROUGH_CODEC = 'avc'

function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : ''
  return ext || '.mp4'
}

/** What to tell someone whose clip this browser cannot open. */
export function undecodableMessage(name: string, codec: string | null): string {
  const label = codec === 'hevc' ? 'HEVC/H.265' : (codec ?? 'ที่ไม่รู้จัก')
  return (
    `เบราว์เซอร์นี้เปิดวิดีโอแบบ ${label} ไม่ได้ (${name}) — ` +
    'ลองใช้ Safari หรือ Edge, หรือส่งออกคลิปเป็น MP4 (H.264) แล้วนำเข้าใหม่'
  )
}

registerJob('ingest', async (job, emit: ProgressCallback): Promise<SidecarEvent> => {
  const projectDir = String(job.projectDir ?? '')
  const uid = projectDir.split('/').pop() as string
  const mode = String(job.mode ?? 'talking_head')
  const sources = (job.sources as string[]) ?? []
  if (sources.length === 0) throw new Error('ไม่ได้เลือกไฟล์')

  const clips: LocalClip[] = []
  const manifest: { id: string; file: string; original: string }[] = []
  let totalSec = 0

  const signal = signalOf(job)

  for (let i = 0; i < sources.length; i++) {
    throwIfAborted(signal)
    const src = sources[i]
    // A picked file has to reach the store before anything else: a reload
    // between here and the next step would otherwise lose it.
    const stagedPath = await stageIntoStore(src, uid)
    let blob = await blobForPath(stagedPath)
    const name = (blob as File).name ?? `clip_${i}.mp4`

    emit({ event: 'progress', stage: 'ingest', step: i + 1, total: sources.length, message: name })

    let info = await probeSource(blob)
    if (info.durationSec <= 0) throw new Error(`อ่านความยาวของ ${name} ไม่ได้`)

    // Caps — same numbers, same sentences as the desktop.
    if (
      (mode === 'dub_first' || mode === 'highlight') &&
      info.durationSec > DUB_MAX_CLIP_SEC + DUB_UPLOAD_TOLERANCE_SEC
    ) {
      throw new Error(
        `คลิป ${name} ยาว ${info.durationSec.toFixed(0)}s เกินลิมิตต่อคลิป ${DUB_MAX_CLIP_SEC}s`
      )
    }
    if (mode === 'talking_head' && info.durationSec > TALKING_HEAD_MAX_TOTAL_SEC) {
      throw new Error(
        `คลิป ${name} ยาว ${(info.durationSec / 3600).toFixed(1)} ชม. — โหมดนี้รองรับสูงสุด ` +
          `${TALKING_HEAD_MAX_TOTAL_SEC / 3600} ชั่วโมงต่อโปรเจกต์ (รวมทุกไฟล์)`
      )
    }
    totalSec += info.durationSec

    // Everything ends up as H.264 in an MP4 — see PASSTHROUGH_CODEC above.
    let isMp4 = extOf(name) === '.mp4'
    let alreadyStored = false
    if (info.codec === PASSTHROUGH_CODEC) {
      // Already the right pictures; only the container may be wrong.
      if (!isMp4) {
        emit({
          event: 'progress',
          stage: 'transcode',
          step: i + 1,
          total: sources.length,
          message: `กำลังจัดรูปแบบ ${name} เป็น MP4…`
        })
        const remuxed = await remuxToMp4(blob, signal)
        if (remuxed) {
          blob = remuxed
          info = await probeSource(blob)
          isMp4 = true
        }
        // A remux that fails is not fatal: the pictures are already editable,
        // so the original container is kept rather than the import refused.
      }
    } else if (await canDecodeSource(info)) {
      emit({
        event: 'progress',
        stage: 'transcode',
        step: i + 1,
        total: sources.length,
        message: `กำลังแปลง ${name} เป็น MP4…`
      })
      // Streamed straight into its final home -- the conversion no longer
      // returns (or ever holds) the whole MP4 in memory.
      const transRel = `normalized/norm_${String(i).padStart(3, '0')}.mp4`
      await transcodeToH264(blob, info, signal, projectFilePath(uid, transRel))
      const written = await readFile(projectFilePath(uid, transRel))
      if (!written) throw new Error('แปลงไฟล์ไม่สำเร็จ')
      blob = written
      info = await probeSource(blob)
      isMp4 = true
      alreadyStored = true
    } else {
      throw new Error(undecodableMessage(name, info.codec))
    }

    // The stored name states what the file IS, so nothing downstream has to
    // sniff it: `.mp4` unless a remux failed and the original container stayed.
    const rel = `normalized/norm_${String(i).padStart(3, '0')}${isMp4 ? '.mp4' : extOf(name)}`
    if (!alreadyStored) await writeFileAtomic(projectFilePath(uid, rel), blob)

    const id = `clip${i}`
    clips.push({
      id,
      file: rel,
      durationSec: info.durationSec,
      width: info.width,
      height: info.height,
      fps: info.fps,
      hasAudio: info.hasAudio
    })
    manifest.push({ id, file: rel, original: name })
  }

  // Project total, checked after the per-clip cap: many short clips add up.
  if (mode === 'dub_first' || mode === 'highlight') {
    if (totalSec > DUB_FIRST_MAX_TOTAL_SEC) {
      throw new Error(
        `คลิปทั้งหมดรวมกันยาว ${totalSec.toFixed(0)}s — โหมดนี้รองรับสูงสุด ` +
          `${DUB_FIRST_MAX_TOTAL_SEC / 60} นาทีต่อโปรเจกต์ กรุณาลดจำนวน/ความยาวคลิป`
      )
    }
  } else if (totalSec > TALKING_HEAD_MAX_TOTAL_SEC) {
    throw new Error(
      `คลิปทั้งหมดรวมกันยาว ${(totalSec / 3600).toFixed(1)} ชม. — รองรับสูงสุด ` +
        `${TALKING_HEAD_MAX_TOTAL_SEC / 3600} ชั่วโมงต่อโปรเจกต์ กรุณาลดจำนวน/ความยาวคลิป`
    )
  }

  await writeFileAtomic(
    projectFilePath(uid, 'upload_sources.json'),
    new TextEncoder().encode(JSON.stringify(manifest, null, 2))
  )

  // The staging copies have served their purpose now that the clips are in
  // `normalized/`; leaving them would double the storage every import. THIS
  // project's staging only — the wizard can run several imports at once, and
  // deleting the shared root took the others' sources with it.
  await deleteDir(stagingDir(uid))

  return { event: 'done', clips }
})
