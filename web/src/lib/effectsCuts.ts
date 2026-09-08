/** Builds real scene-cut boundary timestamps (output-timeline seconds) sent to
 * the effects AI (backend `cuts` form field → effects_ai.py `cut_points_sec`)
 * so it can place a whip-pan `transitions` sweep or an ambient `sceneDrifts`
 * span AT an actual cut instead of an invented one.
 *
 * Same cumulative-cursor model as effectsScript.ts's groupScriptLines, but per
 * raw cut (every edit-script segment / timeline entry is one real cut) rather
 * than grouped by voiceover line — every source-to-source jump in the
 * concatenated output IS a real cut boundary. dub_first/highlight:
 * project.editScript segments. talking_head: project.timeline's raw cut list.
 */

import type { LocalProject } from '@renderer/platform/types'

/** Recovers real per-clip durations from the already-rendered clips/ folder
 * when project.clipDurationsSec wasn't captured (renders from before this was
 * tracked) — probes each clip_NNN.mp4 the silent render already wrote to
 * disk (same naming as dub_render.trim_one_segment: 1-indexed, zero-padded
 * to 3 digits), no re-render needed. Opportunistically persists the result
 * so future calls don't re-probe. Returns undefined if the clips are
 * missing/count-mismatched — buildEffectsCutPoints then falls back to
 * nominal edit-script math, same as before this existed. */
export async function resolveClipDurationsSec(
  project: LocalProject
): Promise<number[] | undefined> {
  if (Array.isArray(project.clipDurationsSec)) return project.clipDurationsSec
  if ((project.mode !== 'dub_first' && project.mode !== 'highlight') || !project.editScript) {
    return undefined
  }
  const segments = (project.editScript as { segments?: unknown[] }).segments ?? []
  if (segments.length === 0) return undefined
  try {
    const durations: number[] = []
    for (let i = 0; i < segments.length; i++) {
      const rel = `clips/clip_${String(i + 1).padStart(3, '0')}.mp4`
      const abs = await window.noey.projects.resolvePath(project.uid, rel)
      const probe = await window.noey.sidecar.probe(abs)
      const d = Number(probe.duration)
      if (!d || d <= 0) return undefined
      durations.push(d)
    }
    void window.noey.projects
      .update(project.uid, { clipDurationsSec: durations })
      .catch(() => undefined)
    return durations
  } catch {
    return undefined
  }
}

// Invariant: this cumulative-cursor walk and the render-time clip-boundary
// cumsum in backend/packages/video/effects_render.py (_clip_index_for) must
// stay derived from the same clipDurationsSec array, in the same order — both
// exist to answer "which clip is second N in" and must agree, or a punch-zoom
// baked per-clip (effects_render.py) would land in a different clip than the
// cut point this function reports to the AI/editor.
export function buildEffectsCutPoints(
  project: LocalProject,
  clipDurationsSec?: number[]
): number[] {
  const points: number[] = []
  let cursor = 0

  if ((project.mode === 'dub_first' || project.mode === 'highlight') && project.editScript) {
    const segments = (project.editScript as { segments?: Record<string, unknown>[] }).segments ?? []
    // Prefer the REAL measured per-clip output durations from the silent
    // render (same order as segments) over the edit script's nominal
    // sourceOut-sourceIn math — ffmpeg's frame-accurate re-encode rounds each
    // clip slightly, and nominal cumulative sums drift further off with every
    // segment, throwing later scene-cut boundaries off by increasing amounts
    // (live report 2026-07-19: punch-zoom overshooting into the next scene,
    // worse later in the video). Falls back to nominal math when absent
    // (older projects rendered before this was tracked).
    const measured = clipDurationsSec ?? project.clipDurationsSec
    const useMeasured = Array.isArray(measured) && measured.length === segments.length
    segments.forEach((seg, i) => {
      const durationSec = useMeasured
        ? Number(measured![i])
        : Number(
            seg.durationSec ?? Math.max(0, Number(seg.sourceOut ?? 0) - Number(seg.sourceIn ?? 0))
          )
      cursor += durationSec
      points.push(cursor)
    })
  } else if (project.mode === 'talking_head' && project.timeline) {
    const timeline = project.timeline as { timeline?: { in: number; out: number }[] }
    for (const cut of timeline.timeline ?? []) {
      const durationSec = Math.max(0, Number(cut.out) - Number(cut.in))
      cursor += durationSec
      points.push(cursor)
    }
  }

  // The final boundary is the end of the video, not an internal cut — drop it.
  // Also drop any point too close to 0 (a leading zero-length cut, if any).
  if (points.length) points.pop()
  return points.filter((p) => p > 0.05)
}
