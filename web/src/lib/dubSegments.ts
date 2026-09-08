/** TS port of backend `dub_segments_from_edit_cuts` (packages/video/timeline.py:1490).
 * Fixture-tested against the Python original — keep behavior identical. */

export interface EditCutIn {
  source: string
  in: number
  out: number
  label?: string
  voiceoverLineId?: number | null
  voiceoverScript?: string | null
}

export interface DubSegment {
  order: number
  sourceClip: string
  sourceIn: number
  sourceOut: number
  durationSec: number
  voiceoverLineId: number
  voiceoverScript: string
  cutStyle: 'jump_cut'
}

function round2(x: number): number {
  return Math.round(x * 100) / 100
}

export function dubSegmentsFromEditCuts(cuts: EditCutIn[]): DubSegment[] {
  return cuts.map((c, i) => {
    let lineId: number
    if (c.voiceoverLineId !== null && c.voiceoverLineId !== undefined) {
      const n = Number(c.voiceoverLineId)
      lineId = Number.isFinite(n) ? Math.trunc(n) : i + 1
    } else {
      const label = String(c.label ?? '').trim()
      const n = label === '' ? NaN : Number(label)
      lineId = Number.isInteger(n) ? n : i + 1
    }
    const srcIn = Number(c.in)
    const srcOut = Number(c.out)
    return {
      order: i + 1,
      sourceClip: String(c.source || 'clip0'),
      sourceIn: srcIn,
      sourceOut: srcOut,
      durationSec: round2(Math.max(0, srcOut - srcIn)),
      voiceoverLineId: lineId,
      voiceoverScript: String(c.voiceoverScript ?? ''),
      cutStyle: 'jump_cut'
    }
  })
}
