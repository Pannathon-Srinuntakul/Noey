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

import { projectFilePath, readJson, writeFileAtomic } from '../../platform/fs'
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
  original: string
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

  const sources = await readJson<UploadSource[]>(projectFilePath(uid, 'upload_sources.json'))
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
    try {
      const out = await encodeVideo(
        frames,
        async (ctx, _i, timeSec) => {
          const frame = await reader.frameAt(timeSec)
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
