/** Camera-motion orchestration (what the desktop app runs end-to-end).
 *
 * Two moving parts since the overlay half was removed (2026-08-12):
 *   1. proxy the finished cut video (sidecar proxy-one) and upload it,
 *   2. AI places camera motion server-side (plan-effects → poll) → effects.json,
 *      then the Python sidecar bakes those ffmpeg transforms onto the cut
 *      (render-effects) → final_fx.mp4.
 *
 * There is no per-instance pre-render any more — every instance is a filter over
 * the real footage, so the bake is a single sidecar call.
 *
 * Kept as a plain async function (not a hook) so it is easy to unit-test and
 * reuse for both the AI pass and a manual-editor re-render.
 */

import type { LocalProject, SidecarEvent } from '@renderer/platform/types'
import type { ApiSession } from './videosLocalApi'
import { pollJob } from './videosLocalApi'
import { planEffects } from './effectsLocalApi'
import { normalizeEffectsDoc, type EffectsDoc } from './effects'
import { resolveClipDurationsSec } from './effectsCuts'

export interface EffectsPipelineDeps {
  session: ApiSession
  localUid: string
  remoteUid: string
  /** Finished cut video filename in the project dir (e.g. 'final.mp4'). */
  baseFile: string
  /** The project, used to resolve per-scene clip durations (clips/clip_NNN.mp4)
   * so punch-zoom effects can be baked per-clip before concat instead of on
   * the already-assembled base — see resolveClipDurationsSec. Optional: when
   * omitted, punch-zoom falls back to the older post-concat bake. */
  project?: LocalProject
  onProgress?: (msg: string) => void
  onThinking?: (excerpt: string) => void
  /** Abort the run between stages / while polling (stop button). */
  signal?: AbortSignal
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('ยกเลิกแล้ว', 'AbortError')
}

/** Bake every instance in `doc` onto the base video with the Python sidecar.
 * Returns the final_fx.mp4 path. Shared by the AI pass and manual re-renders. */
export async function renderEffectsDoc(
  deps: EffectsPipelineDeps,
  doc: EffectsDoc
): Promise<string> {
  const { localUid, baseFile, onProgress } = deps
  const projectDir = await window.noey.projects.dir(localUid)
  const clipDurationsSec = deps.project ? await resolveClipDurationsSec(deps.project) : undefined

  throwIfAborted(deps.signal)
  onProgress?.('กำลังใส่การซูมลงวิดีโอ…')
  const result = (await window.noey.sidecar.renderEffects.run({
    projectDir,
    base: baseFile,
    effects: doc,
    out: 'final_fx.mp4',
    clipsDir: 'clips',
    ...(clipDurationsSec ? { clipDurationsSec } : {})
  })) as SidecarEvent & { out?: string }
  // A stop that lands while ffmpeg is finishing must not be reported as a
  // successful bake — the caller applies the result (marks the clip rendered,
  // clears "unsaved") purely from this resolving.
  throwIfAborted(deps.signal)
  return String(result.out ?? '')
}

/** Full AI pass: proxy + upload → plan → poll → bake.
 * `scriptText` (see effectsScript.ts) carries the timed voiceover/transcript so
 * the AI can match motion to the exact spoken words, not just the visuals.
 * `referencePath` — an OPTIONAL local video/image the AI takes STYLE
 * inspiration from only, for THIS run (see effectsLocalApi.planEffects); a
 * reusable style is a saved EffectStyle instead.
 * `usePrevious` — see effectsLocalApi.planEffects: false is a fresh clean-slate
 * pass, true tells the AI about the existing effects.json so it deliberately
 * differs from it (the "แก้ไข AI" edit button). */
export async function runAiEffects(
  deps: EffectsPipelineDeps,
  promptText: string,
  scriptText = '',
  referencePath?: string,
  styleUid?: string,
  cutPointsSec?: number[],
  usePrevious = false
): Promise<{ doc: EffectsDoc; finalPath: string }> {
  const { session, localUid, remoteUid, baseFile, onProgress, onThinking } = deps
  const projectDir = await window.noey.projects.dir(localUid)

  onProgress?.('กำลังย่อวิดีโอสำหรับ AI…')
  await window.noey.sidecar.proxyOne.run({
    projectDir,
    src: baseFile,
    out: 'effects/cut_proxy.mp4'
  })

  throwIfAborted(deps.signal)
  onProgress?.('กำลังอัพโหลดให้ AI…')
  const { job_id } = await planEffects(
    session,
    remoteUid,
    localUid,
    promptText,
    scriptText,
    referencePath,
    styleUid,
    cutPointsSec,
    usePrevious
  )

  onProgress?.('AI กำลังวางการซูม…')
  const status = await pollJob(
    session,
    job_id,
    (s) => {
      const r = (s.result ?? {}) as { message?: string; thinking?: string }
      if (r.thinking) onThinking?.(r.thinking)
      else if (r.message) onProgress?.(r.message)
    },
    { signal: deps.signal }
  )

  // A job that finished without effects used to fall back to whatever was
  // already stored, which is the doc the user had just edited AWAY from: the
  // editor reported success and repopulated itself with the old zooms, with
  // nothing anywhere saying the AI had produced nothing.
  const resultDoc = (status.result as { effects?: unknown } | null)?.effects
  if (!resultDoc) throw new Error('AI ไม่ได้ส่งผลการวางซูมกลับมา — ลองใหม่อีกครั้ง')
  const doc = normalizeEffectsDoc(resultDoc)

  throwIfAborted(deps.signal)
  const finalPath = await renderEffectsDoc(deps, doc)
  return { doc, finalPath }
}
