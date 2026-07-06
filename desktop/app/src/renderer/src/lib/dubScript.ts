/** Group edit-script segments into voiceover lines for the script panel. */

import type { DubEditScript } from './videosLocalApi'

export interface VoLine {
  lineId: number
  script: string
  cutCount: number
}

export function groupScriptLines(editScript: DubEditScript): VoLine[] {
  const lines: VoLine[] = []
  const seen = new Set<number>()
  for (const seg of editScript.segments) {
    const lineId = Number(seg.voiceoverLineId ?? seg.order ?? 0)
    if (seen.has(lineId)) {
      const line = lines.find((l) => l.lineId === lineId)
      if (line) line.cutCount += 1
      continue
    }
    seen.add(lineId)
    lines.push({
      lineId,
      script: String(seg.voiceoverScript ?? '').trim(),
      cutCount: 1
    })
  }
  return lines
}
