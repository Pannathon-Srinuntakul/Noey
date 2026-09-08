/**
 * `render-highlights` — mode A: one clip per highlight.
 *
 * Mirrors `desktop/sidecar/sidecar/timeline_render.py:run_render_highlights`.
 * Every item in the index carries its own timeline, so this is the ordinary
 * timeline render run N times, publishing atomically to `highlights/hNN.mp4`
 * as it goes: stopping halfway leaves N complete files and zero partial ones.
 *
 * There is deliberately no `final.mp4` and no CapCut bundle in this mode —
 * anything reading `final.mp4` must find nothing rather than a lookalike.
 */

import { deleteDir, projectFilePath } from '../../platform/fs'
import type { SidecarEvent } from '../../platform/types'
import { renderTimelineInto } from './renderTimeline'
import { registerJob, type ProgressCallback } from '../index'

interface HighlightItem {
  id?: string
  title?: string
  timeline?: Record<string, unknown>
}

registerJob('render-highlights', async (job, emit: ProgressCallback): Promise<SidecarEvent> => {
  const uid = String(job.projectDir ?? '')
    .split('/')
    .pop() as string
  const index = (job.index ?? {}) as { items?: HighlightItem[] }
  const items = (index.items ?? []).filter((i) => i && typeof i === 'object')
  if (items.length === 0) throw new Error('ไม่มีไฮไลต์ให้เรนเดอร์ — ลองถอดเสียงใหม่อีกครั้ง')

  // A re-plan can produce FEWER highlights. Without this, h05/h06 from the
  // previous run stayed on disk, appeared in the export list with nothing
  // marking them as rejected, and were re-uploaded to S3 against the quota.
  // Every sibling render clears its own output the same way (cutRender wipes
  // clips/, extract-audio wipes stale WAVs).
  await deleteDir(projectFilePath(uid, 'highlights'))

  const done: { id: string; final: string; srt: string; durationSec: number }[] = []
  for (let n = 0; n < items.length; n++) {
    const item = items[n]
    const hid = String(item.id || `h${String(n + 1).padStart(2, '0')}`)
    emit({
      event: 'progress',
      stage: 'highlight',
      step: n + 1,
      total: items.length,
      message: String(item.title || hid)
    })
    // The inner stages stay quiet: the highlight counter above is the progress
    // a person can follow, and N×(cut/concat) underneath it is noise.
    const sub = await renderTimelineInto(uid, item.timeline ?? {}, {
      outName: `highlights/${hid}.mp4`,
      withBundle: false,
      signal: job.signal as AbortSignal | undefined
    })
    done.push({ id: hid, final: sub.final, srt: sub.srt, durationSec: sub.durationSec })
  }

  return { event: 'done', highlights: done, count: done.length }
})
