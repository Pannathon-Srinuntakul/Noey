/**
 * `extract-proxy` — the small copies the AI actually looks at.
 *
 * The source video never leaves the machine; these do. Spec matches
 * `desktop/sidecar/sidecar/proxy.py` so the backend's analyse step sees the
 * same thing either way: 480p tall, 12 fps, no audio, low bitrate.
 *
 * Output contract, read directly by `useProjectPipeline` (which fetches the
 * manifest over the media route rather than using this job's return value):
 *
 *   proxy/<clipId>.mp4
 *   proxy/proxy_manifest.json   [{ clip_id, file, durationSec, order }]
 *
 * `durationSec` is the SOURCE duration, not the proxy's — the backend uses it
 * to map the model's timestamps back onto the original footage.
 */

import { projectFilePath, writeFileAtomic } from '../../platform/fs'
import type { SidecarEvent } from '../../platform/types'
import { encodeVideo, openVideo, probeSource } from '../media'
import { registerJob, type ProgressCallback } from '../index'
import { signalOf, throwIfAborted } from '../abort'
import { blobForPath } from './probe'

/** Same as proxy.py: 480 tall, 12 fps, silent. */
const PROXY_HEIGHT = 480
const PROXY_FPS = 12
/** Roughly what CRF 28 gives at this size — the model needs legibility, not
 * fidelity, and every extra megabyte is upload time the user waits through. */
const PROXY_BITRATE = 700_000

interface UploadSource {
  id: string
  file: string
  original?: string
}

interface ProxyEntry {
  clip_id: string
  file: string
  durationSec: number
  order: number
}

function even(n: number): number {
  return n % 2 === 0 ? n : n - 1
}

registerJob('extract-proxy', async (job, emit: ProgressCallback): Promise<SidecarEvent> => {
  const projectDir = String(job.projectDir ?? '')
  const uid = projectDir.split('/').pop() as string

  // Through blobForPath, NOT a bare OPFS read: on a project restored from the
  // server this file exists only there, and the bare read made "ให้ AI ตัดใหม่"
  // flip a finished project to 'ยังไม่ได้นำเข้าคลิป' in every browser. The
  // project row's clips carry the same id/file pairs, so they are the fallback
  // for projects synced before the manifest was uploadable at all.
  let sources: UploadSource[] | null = null
  try {
    const blob = await blobForPath(projectFilePath(uid, 'upload_sources.json'))
    sources = JSON.parse(await blob.text()) as UploadSource[]
  } catch {
    const project = await window.noey.projects.get(uid)
    const clips = project?.clips ?? []
    if (clips.length > 0) sources = clips.map((c) => ({ id: c.id, file: c.file }))
  }
  if (!sources || sources.length === 0) {
    throw new Error('ยังไม่ได้นำเข้าคลิป')
  }

  const manifest: ProxyEntry[] = []
  const signal = signalOf(job)

  for (let i = 0; i < sources.length; i++) {
    throwIfAborted(signal)
    const src = sources[i]
    const blob = await blobForPath(projectFilePath(uid, src.file))
    const info = await probeSource(blob)

    emit({
      event: 'progress',
      stage: 'proxy',
      step: i + 1,
      total: sources.length,
      message: src.file.split('/').pop() ?? src.file
    })

    const height = PROXY_HEIGHT
    const width = even(Math.round(height * (info.width / info.height || 9 / 16)))
    const frames = Math.max(1, Math.round(info.durationSec * PROXY_FPS))

    const reader = await openVideo(blob)
    // ONE sequential decode pass, not a seek per frame.
    //
    // `frameAt` is random access: every call re-seeks and re-walks the GOP from
    // the last keyframe, so the cost is quadratic-ish in clip length. Measured
    // on a 12-second clip: 22.6 s through `frameAt`, which extrapolates to
    // ~9 minutes for a 5-minute source on a fast desktop and several times that
    // on a phone — the progress bar sits at 25% long enough to read as a hang
    // (live report from an iPhone, 2026-09-09). `transcode` and `cutRender`
    // already do it this way; this job was missed in the port.
    const stamps: number[] = []
    for (let f = 0; f < frames; f++) stamps.push(f / PROXY_FPS)
    const pass = reader.framesAt(stamps)
    try {
      const out = await encodeVideo(
        frames,
        async (ctx) => {
          const frame = (await pass.next()).value ?? null
          if (!frame) return false
          ctx.drawImage(frame, 0, 0, width, height)
          return true
        },
        { width, height, fps: PROXY_FPS, bitrate: PROXY_BITRATE, signal },
        {},
        (done, total) => {
          emit({
            event: 'progress',
            stage: 'proxy',
            step: i + 1,
            total: sources.length,
            message: `${src.file.split('/').pop()} · ${Math.round((done / total) * 100)}%`
          })
        }
      )
      if (!out) throw new Error('สร้างไฟล์ตัวอย่างไม่สำเร็จ')
      await writeFileAtomic(projectFilePath(uid, `proxy/${src.id}.mp4`), out)
    } finally {
      await pass.return(undefined).catch(() => undefined)
      reader.close()
    }

    manifest.push({
      clip_id: src.id,
      file: `${src.id}.mp4`,
      durationSec: Math.round(info.durationSec * 1000) / 1000,
      order: i
    })
  }

  await writeFileAtomic(
    projectFilePath(uid, 'proxy/proxy_manifest.json'),
    new TextEncoder().encode(JSON.stringify(manifest, null, 2))
  )

  return { event: 'done', proxies: manifest, count: manifest.length }
})
