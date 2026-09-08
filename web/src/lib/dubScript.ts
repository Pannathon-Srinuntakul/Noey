/** Group edit-script segments into voiceover lines for the script panel. */

import type { DubEditScript } from './videosLocalApi'

export interface VoLine {
  lineId: number
  script: string
  /** AI-generated per-scene description (see dub_ai.py's `visualDescription`
   * schema field) — the only per-scene context available when `script` is
   * empty (e.g. highlight mode, or any dub_first line with no VO text). */
  visualDescription: string
  cutCount: number
  outputIn: number
  outputOut: number
}

/**
 * The same lines, re-timed against a PLANNED timeline (post-voiceover).
 *
 * A dub's final render re-times every scene to the recorded voiceover, so the
 * edit script's own output clock stops describing the video the user is
 * watching. The planner maps segments to cuts in order (`plan_dub_timeline_cuts`),
 * so cut i carries segment i's line.
 */
export function retimeLinesToCuts(
  editScript: DubEditScript,
  cuts: { in: number; out: number; type?: string }[]
): VoLine[] {
  const segments = editScript.segments ?? []
  const realCuts = cuts.filter((c) => (c.type ?? 'cut') === 'cut')
  if (segments.length === 0 || realCuts.length === 0) return groupScriptLines(editScript)

  const lines: VoLine[] = []
  const byId = new Map<number, VoLine>()
  let cursor = 0
  realCuts.forEach((cut, i) => {
    const seg = segments[Math.min(i, segments.length - 1)]
    const outputIn = cursor
    cursor += Math.max(0, Number(cut.out) - Number(cut.in))
    const lineId = Number(seg.voiceoverLineId ?? seg.order ?? i + 1)
    const existing = byId.get(lineId)
    if (existing) {
      existing.cutCount += 1
      existing.outputOut = cursor
      return
    }
    const line: VoLine = {
      lineId,
      script: String(seg.voiceoverScript ?? '').trim(),
      visualDescription: String(seg.visualDescription ?? '').trim(),
      cutCount: 1,
      outputIn,
      outputOut: cursor
    }
    byId.set(lineId, line)
    lines.push(line)
  })
  return lines
}

export function groupScriptLines(editScript: DubEditScript): VoLine[] {
  const lines: VoLine[] = []
  const seen = new Set<number>()
  let cursor = 0
  for (const seg of editScript.segments) {
    const durationSec = Number(
      seg.durationSec ?? Math.max(0, Number(seg.sourceOut ?? 0) - Number(seg.sourceIn ?? 0))
    )
    const outputIn = cursor
    const outputOut = cursor + durationSec
    cursor = outputOut

    const lineId = Number(seg.voiceoverLineId ?? seg.order ?? 0)
    if (seen.has(lineId)) {
      const line = lines.find((l) => l.lineId === lineId)
      if (line) {
        line.cutCount += 1
        line.outputOut = outputOut
      }
      continue
    }
    seen.add(lineId)
    lines.push({
      lineId,
      script: String(seg.voiceoverScript ?? '').trim(),
      visualDescription: String(seg.visualDescription ?? '').trim(),
      cutCount: 1,
      outputIn,
      outputOut
    })
  }
  return lines
}
