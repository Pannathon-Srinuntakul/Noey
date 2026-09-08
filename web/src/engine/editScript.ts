/**
 * Edit-script normalisation, ported from
 * `backend/packages/video/timeline.py:normalize_dub_edit_script`.
 *
 * The render depends on every one of these repairs, and the model does not
 * reliably do them itself:
 *
 *   - segments come back in whatever order, so they are sorted by `order`;
 *   - `durationSec` is derived from the trim and floored, because a cut shorter
 *     than DUB_MIN_CUT_SEC reads as a glitch rather than an edit;
 *   - `voiceoverLineId` is filled in when omitted, and a continuation cut
 *     inherits the line it belongs to — that grouping is what the editor's
 *     "angles of this line" and the script file are both built on;
 *   - a montage continuation with no text of its own borrows the line's text,
 *     so captions and `script.txt` do not have holes in them.
 */

export interface DubSegment {
  order?: number
  sourceClip?: string
  sourceIn: number
  sourceOut: number
  durationSec?: number
  voiceoverLineId?: number | null
  voiceoverScript?: string | null
  /** Filled by `annotateOutputTimes` — where the segment lands in the render. */
  outputIn?: number
  outputOut?: number
  voiceoverLineOutputIn?: number
  voiceoverLineOutputOut?: number
  [key: string]: unknown
}

export interface DubEditScript {
  segments?: DubSegment[]
  [key: string]: unknown
}

/** `timeline.py:719`. A cut below this floor plays as a flicker. */
export const DUB_MIN_CUT_SEC = 0.35

export function normalizeDubEditScript(script: DubEditScript): DubEditScript {
  // Copied, not repaired in place: the caller passes the project's live edit
  // script, and a render must not rewrite the record the editor is showing.
  const segs = (script.segments ?? [])
    .filter((s): s is DubSegment => !!s && typeof s === 'object')
    .map((s) => ({ ...s }))
  if (segs.length === 0) return { ...script, segments: [] }

  segs.sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0))

  for (const seg of segs) {
    const srcDur = Math.max(0, Number(seg.sourceOut) - Number(seg.sourceIn))
    let dur = Number(seg.durationSec ?? 0)
    if (dur <= 0 && srcDur > 0) dur = srcDur
    if (dur > 0) seg.durationSec = Math.round(Math.max(dur, DUB_MIN_CUT_SEC) * 100) / 100
  }

  let nextLineId = 1
  let prevScript = ''
  let prevLineId: number | null = null
  for (const seg of segs) {
    const raw = seg.voiceoverLineId
    const text = String(seg.voiceoverScript ?? '').trim()
    let lineId: number
    if (raw !== null && raw !== undefined) {
      const parsed = Number(raw)
      if (Number.isFinite(parsed)) {
        lineId = parsed
        nextLineId = Math.max(nextLineId, lineId + 1)
      } else {
        lineId = nextLineId
        nextLineId += 1
      }
    } else if (!text && prevLineId !== null) {
      // A continuation cut: another angle on the line already being spoken.
      lineId = prevLineId
    } else if (text && text === prevScript && prevLineId !== null) {
      lineId = prevLineId
    } else {
      lineId = nextLineId
      nextLineId += 1
    }
    seg.voiceoverLineId = lineId
    if (text) {
      prevScript = text
      prevLineId = lineId
    }
  }

  const lineScript = new Map<number, string>()
  for (const seg of segs) {
    const lid = Number(seg.voiceoverLineId)
    const text = String(seg.voiceoverScript ?? '').trim()
    if (text && !lineScript.has(lid)) lineScript.set(lid, text)
  }
  for (const seg of segs) {
    const lid = Number(seg.voiceoverLineId)
    if (!String(seg.voiceoverScript ?? '').trim() && lineScript.has(lid)) {
      seg.voiceoverScript = lineScript.get(lid) as string
    }
  }

  return annotateOutputTimes({ ...script, segments: segs })
}

/**
 * The OUTPUT clock — where each segment lands in the finished video.
 *
 * Ported from `timeline.py:annotate_dub_script_output_times`, and it is the
 * last step of normalisation there too. `script.txt` is read by someone
 * watching the render, so its timestamps have to be output times; without
 * these fields the web build printed SOURCE times under the same headings,
 * pointing at the wrong moment of the wrong file.
 */
export function annotateOutputTimes(script: DubEditScript): DubEditScript {
  const segs = script.segments ?? []
  let cursor = 0
  const r2 = (n: number): number => Math.round(n * 100) / 100
  for (const seg of segs) {
    const dur = segmentDuration(seg)
    seg.outputIn = r2(cursor)
    seg.outputOut = r2(cursor + dur)
    cursor += dur
  }

  // A montage line spans every cut that speaks it: first in to last out.
  const span = new Map<number, { in: number; out: number }>()
  for (const seg of segs) {
    const lid = Number(seg.voiceoverLineId)
    if (!Number.isFinite(lid)) continue
    const existing = span.get(lid)
    if (!existing) span.set(lid, { in: Number(seg.outputIn), out: Number(seg.outputOut) })
    else existing.out = Number(seg.outputOut)
  }
  for (const seg of segs) {
    const s = span.get(Number(seg.voiceoverLineId))
    if (!s) continue
    seg.voiceoverLineOutputIn = s.in
    seg.voiceoverLineOutputOut = s.out
  }

  if (cursor > 0) script.totalEstimatedSec = Math.round(cursor)
  return script
}

/** `timeline.py:_dub_segment_duration` — the stored length, or the trim. */
function segmentDuration(seg: DubSegment): number {
  const stored = Number(seg.durationSec ?? 0)
  if (stored > 0) return stored
  return Math.max(0, Number(seg.sourceOut) - Number(seg.sourceIn))
}

/**
 * `script.txt` — the voiceover script, grouped by line.
 *
 * Ported from `dub_render.py:write_dub_script_txt`. It ships inside the bundle
 * and is what someone reads into a microphone, so the grouping (one entry per
 * spoken line, however many angles it was cut into) is the whole point.
 */
export function buildScriptTxt(segs: DubSegment[], brief?: string | null): string {
  const lines: string[] = ['=== Script ===\n']
  if (brief) lines.push(`Brief: ${brief}\n`)
  lines.push('')

  const seen = new Set<number>()
  let lineNo = 0
  for (const seg of segs) {
    const lid = Number(seg.voiceoverLineId ?? seg.order ?? 0)
    if (seen.has(lid)) continue
    seen.add(lid)
    lineNo += 1

    const lineSegs = segs.filter((s) => Number(s.voiceoverLineId ?? s.order ?? 0) === lid)
    // OUTPUT times, with the fallback chain `write_dub_script_txt` uses: the
    // line's own span first, then the segment's own, then zero. Source times
    // would name a moment in a file the reader is not watching.
    const first = lineSegs[0]
    const last = lineSegs[lineSegs.length - 1]
    const oIn = Number(first.voiceoverLineOutputIn ?? first.outputIn ?? 0)
    const oOut = Number(last.voiceoverLineOutputOut ?? last.outputOut ?? 0)
    const cuts = lineSegs.length > 1 ? ` | ${lineSegs.length} cuts` : ''
    lines.push(`[Line ${lineNo} | ${oIn.toFixed(1)}s → ${oOut.toFixed(1)}s${cuts}]`)
    lines.push(String(first.voiceoverScript ?? '').trim())
    lines.push('')
  }
  const totalSec = segs.length ? Number(segs[segs.length - 1].outputOut ?? 0) : 0
  lines.push('===')
  lines.push(`Total: ${totalSec.toFixed(0)}s`)
  return lines.join('\n')
}
