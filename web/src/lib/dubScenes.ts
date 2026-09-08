/**
 * Scene-level view of a dub cut: one entry per rendered scene, in output time,
 * tagged with the voiceover line it was cut for.
 *
 * Scenes — not lines — are what a playhead lands in. A line's scenes are NOT
 * contiguous (the AI interleaves angles: line 1, line 2, line 1 again), so a
 * line's [first scene start, last scene end] span overlaps its neighbours and
 * cannot answer "which line is being said right now": the first overlapping
 * span always won and the highlight stuck on it (live report 2026-08-13).
 */

import type { DubEditScript, DubTimeline } from './videosLocalApi'

export interface DubScene {
  lineId: number
  script: string
  start: number
  end: number
}

/** A scene inherits the text of the first scene of its line — later segments of
 * the same line carry an empty script. */
export function withInheritedScripts(scenes: DubScene[]): DubScene[] {
  const textByLine = new Map<number, string>()
  for (const s of scenes)
    if (s.script && !textByLine.has(s.lineId)) textByLine.set(s.lineId, s.script)
  return scenes.map((s) => ({ ...s, script: s.script || (textByLine.get(s.lineId) ?? '') }))
}

/** Scenes on the SILENT cut's clock — segment durations, played back to back. */
export function dubScenesFor(script: DubEditScript | null): DubScene[] {
  if (!script?.segments) return []
  const scenes: DubScene[] = []
  let cursor = 0
  script.segments.forEach((seg, i) => {
    const duration = Number(
      seg.durationSec ?? Math.max(0, Number(seg.sourceOut ?? 0) - Number(seg.sourceIn ?? 0))
    )
    const start = cursor
    cursor += Number.isFinite(duration) ? duration : 0
    scenes.push({
      lineId: Number(seg.voiceoverLineId ?? seg.order ?? i + 1),
      script: String(seg.voiceoverScript ?? '').trim(),
      start,
      end: cursor
    })
  })
  return withInheritedScripts(scenes)
}

/**
 * Scenes on the PLANNED timeline's clock (post-voiceover).
 *
 * The plan re-times every scene to the recorded voiceover, so the edit script's
 * own clock stops describing the video being watched. The planner maps segments
 * to cuts in order (`plan_dub_timeline_cuts`), so cut i carries segment i's
 * line; a short cut the planner dropped shifts the tail, which costs the last
 * scenes their exact text rather than the whole mapping.
 */
export function timelineScenesFor(
  timeline: DubTimeline | Record<string, unknown> | undefined,
  script: DubEditScript | null
): DubScene[] {
  const raw = (timeline as DubTimeline | undefined)?.timeline
  const cuts = Array.isArray(raw) ? raw.filter((c) => (c.type ?? 'cut') === 'cut') : []
  const segments = script?.segments ?? []
  if (cuts.length === 0 || segments.length === 0) return []
  const scenes: DubScene[] = []
  let cursor = 0
  cuts.forEach((cut, i) => {
    const seg = segments[Math.min(i, segments.length - 1)]
    const start = cursor
    cursor += Math.max(0, Number(cut.out) - Number(cut.in))
    scenes.push({
      lineId: Number(seg.voiceoverLineId ?? seg.order ?? i + 1),
      script: String(seg.voiceoverScript ?? '').trim(),
      start,
      end: cursor
    })
  })
  return withInheritedScripts(scenes)
}

/** Which line is on screen at `t` — the scene containing it, not a line span. */
export function lineIdAt(scenes: DubScene[], t: number): number | null {
  const hit = scenes.find((s) => t >= s.start - 0.02 && t < s.end - 0.02)
  return hit ? hit.lineId : null
}

export interface DubLine {
  lineId: number
  script: string
  /** Where "jump to this line" goes: the start of its FIRST scene. */
  start: number
  sceneCount: number
}

/** One entry per spoken line, in first-appearance order. */
export function linesFromScenes(scenes: DubScene[]): DubLine[] {
  const byId = new Map<number, DubLine>()
  const out: DubLine[] = []
  for (const scene of scenes) {
    const existing = byId.get(scene.lineId)
    if (existing) {
      existing.sceneCount += 1
      existing.start = Math.min(existing.start, scene.start)
      continue
    }
    const line: DubLine = {
      lineId: scene.lineId,
      script: scene.script,
      start: scene.start,
      sceneCount: 1
    }
    byId.set(scene.lineId, line)
    out.push(line)
  }
  return out
}
