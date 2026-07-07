/** Group edit-script segments into voiceover lines for the script panel. */

import type { DubEditScript } from './videosLocalApi'

export interface VoLine {
  lineId: number
  script: string
  cutCount: number
  outputIn: number
  outputOut: number
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
      cutCount: 1,
      outputIn,
      outputOut
    })
  }
  return lines
}
