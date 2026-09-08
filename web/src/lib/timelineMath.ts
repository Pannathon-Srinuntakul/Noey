/**
 * Pure math for the video timeline editor (R3).
 *
 * Everything here is deliberately free of React and the DOM so the geometry
 * the editor draws — and the edits it commits — can be unit-tested without
 * mounting a 3,000-line component. The component owns state and playback;
 * this file owns arithmetic.
 */
import type { CaptionLine, EditCut } from './editorApi'

export const MIN_CUT_SEC = 0.2
export const DEFAULT_NEW_CUT_SEC = 2
/** Base scale filmstrip tile math is anchored to — the on-screen zoom
 * (`pxPerSec` state) stretches the display, it never regenerates tiles. */
export const BASE_PX_PER_SEC = 40

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

export function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Transport clock — "0:07.5" per R3's player, tenths only. */
export function fmtTimeTenths(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00.0'
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  const whole = Math.floor(s)
  const tenths = Math.floor((s - whole) * 10)
  return `${m}:${String(whole).padStart(2, '0')}.${tenths}`
}

/**
 * `"0:22.4"` / `"1:02"` / `"22.4"` → seconds, or null when it is not a time.
 *
 * Accepts a bare number so someone used to the old seconds fields can still
 * type one; anything else (empty, letters, negative) is rejected rather than
 * silently becoming 0, which would move a caption to the start of the clip.
 */
export function parseTimecode(input: string): number | null {
  const s = input.trim()
  if (!s) return null
  const mmss = /^(\d+):([0-5]?\d(?:\.\d+)?)$/.exec(s)
  if (mmss) return Number(mmss[1]) * 60 + Number(mmss[2])
  const hhmmss = /^(\d+):([0-5]?\d):([0-5]?\d(?:\.\d+)?)$/.exec(s)
  if (hhmmss) return Number(hhmmss[1]) * 3600 + Number(hhmmss[2]) * 60 + Number(hhmmss[3])
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s)
  return null
}

/** Ruler label step: smallest "round" step whose labels stay ≥ ~140px apart —
 * 5s at the default 40px/วิ, coarser as you zoom out, finer as you zoom in. */
export function rulerStepSec(pxPerSec: number): number {
  const CANDIDATES = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]
  for (const c of CANDIDATES) {
    if (c * pxPerSec >= 140) return c
  }
  return 600
}

export interface EditedSegment {
  cut: EditCut
  editedIn: number
  editedOut: number
}

/** Map cuts onto one continuous "edited" timeline — strict back-to-back, no overlap. */
export function computeEditedSegments(cuts: EditCut[]): EditedSegment[] {
  let acc = 0
  return cuts.map((c) => {
    const dur = Math.max(c.out - c.in, 0)
    const seg: EditedSegment = { cut: c, editedIn: acc, editedOut: acc + dur }
    acc += dur
    return seg
  })
}

export function computeEditedDuration(cuts: EditCut[]): number {
  return cuts.reduce((sum, c) => sum + Math.max(c.out - c.in, 0), 0)
}

/** Find which cut a position on the concatenated edited timeline falls into. */
export function findEditedSegment(cuts: EditCut[], t: number): EditedSegment | null {
  const segs = computeEditedSegments(cuts)
  if (segs.length === 0) return null
  for (const seg of segs) {
    if (t < seg.editedOut - 0.001) return seg
  }
  return segs[segs.length - 1]
}

/** Find which cut on a source lane contains source-local time `t`. */
export function findSourceCutAtTime(
  cuts: EditCut[],
  sourceId: string | null,
  t: number
): EditCut | null {
  if (!sourceId) return null
  for (const c of cuts) {
    if (c.source !== sourceId) continue
    if (t >= c.in - 0.001 && t < c.out + 0.001) return c
  }
  return null
}

/** Prevent cuts on the same source lane from overlapping each other. */
export function sourceNeighborBounds(
  cut: EditCut,
  sourceCuts: EditCut[],
  laneDurationSec: number
): { minIn: number; maxOut: number } {
  const sorted = [...sourceCuts].sort((a, b) => a.in - b.in || a.out - b.out)
  const idx = sorted.findIndex((c) => c.id === cut.id)
  const prev = idx > 0 ? sorted[idx - 1] : null
  const next = idx >= 0 && idx < sorted.length - 1 ? sorted[idx + 1] : null
  return {
    minIn: prev ? prev.out : 0,
    maxOut: next ? next.in : laneDurationSec
  }
}

export const BEAT_SNAP_THRESHOLD_SEC = 0.2

/** Snap `candidate` (an output-timeline second) to the nearest beat timestamp
 * within BEAT_SNAP_THRESHOLD_SEC, or return it unchanged if none is close
 * enough / snapping is off. Beats are the full-track domain (from upload-time
 * librosa analysis); `musicOffsetSec`/`musicTrimInSec` convert a beat into the
 * output-timeline position it plays at. */
export function snapCandidateToBeat(
  candidate: number,
  beatsSec: number[] | null,
  enabled: boolean,
  musicOffsetSec: number,
  musicTrimInSec: number
): number {
  if (!enabled || !beatsSec || beatsSec.length === 0) return candidate
  let best = candidate
  let bestDist = BEAT_SNAP_THRESHOLD_SEC
  for (const b of beatsSec) {
    const outputSec = b - musicTrimInSec + musicOffsetSec
    if (outputSec < 0) continue
    const d = Math.abs(outputSec - candidate)
    if (d < bestDist) {
      bestDist = d
      best = outputSec
    }
  }
  return best
}

/** Every scene boundary on the OUTPUT timeline: where one cut ends and the next
 * begins, plus 0 and the total. These are the lines a caption edge or a music
 * drop wants to land on. */
export function cutBoundariesSec(cuts: EditCut[]): number[] {
  const segs = computeEditedSegments(cuts)
  if (segs.length === 0) return []
  return [0, ...segs.map((s) => s.editedOut)]
}

export interface TimedWord {
  word: string
  start: number
  end: number
}

/**
 * Where each source clip begins on the concatenated SOURCE clock.
 *
 * Mirrors `_clip_abs_offsets` in `desktop/sidecar/sidecar/timeline_render.py`:
 * transcript word timestamps are absolute across all clips laid end to end, so
 * a cut's `in`/`out` (which are clip-local) have to be lifted by this before
 * they can be compared with a word. A single-clip project is all zeroes, which
 * is why this never mattered until a project had two.
 */
export function clipAbsOffsets(clipDurationsSec: number[]): Record<string, number> {
  const offsets: Record<string, number> = {}
  let off = 0
  clipDurationsSec.forEach((d, i) => {
    offsets[`clip${i}`] = off
    off += d
  })
  return offsets
}

/**
 * Source-clock transcript words → OUTPUT-clock words.
 *
 * A direct port of `remap_words_to_output` in `backend/packages/video/caption.py`
 * — the renderer and the burn-in must agree word for word, so the two are
 * pinned against each other in `timelineMath.test.ts`.
 *
 * WHY IT IS NEEDED HERE. `build_ass_captions` documents `caption_lines` as
 * being "in output timeline", but the editor was handed talking_head lines
 * grouped straight from `timeline.words`, which are SOURCE timestamps, and
 * declared `captionTimeBase: 'source'`. Saving wrote those source-clock lines
 * into `timeline.captionLines`, and the sidecar burned them as output time. On
 * a 60 s source cut down to 25 s of speech a line at source 40–42 s was burned
 * at output 40–42 s: past the end of the clip, so it never appeared at all.
 * Any save from the editor triggered it, a pure trim included, and the stored
 * lines then overrode the correct auto-grouping on every later render
 * (2026-09-07).
 */
export function remapWordsToOutput(
  words: TimedWord[],
  cuts: EditCut[],
  absOffsets: Record<string, number>
): TimedWord[] {
  const out: TimedWord[] = []
  let outputOffset = 0
  const r3 = (n: number): number => Math.round(n * 1000) / 1000
  for (const cut of cuts) {
    const absBase = absOffsets[cut.source] ?? 0
    const dur = cut.out - cut.in
    if (dur <= 0) continue
    const absIn = absBase + cut.in
    const absOut = absBase + cut.out
    for (const w of words) {
      if (w.end <= absIn || w.start >= absOut) continue
      const cs = Math.max(w.start, absIn)
      const ce = Math.min(w.end, absOut)
      out.push({
        word: w.word,
        start: r3(outputOffset + (cs - absIn)),
        end: r3(outputOffset + (ce - absIn))
      })
    }
    outputOffset += dur
  }
  return out
}

export interface BeatSnapTrimInput {
  /** What `bindTrimDrag` produced — already clamped, one edge only. */
  patch: Partial<Pick<EditCut, 'in' | 'out'>>
  /** The cut being trimmed, BEFORE this patch. */
  cut: Pick<EditCut, 'in' | 'out'>
  /** Where this cut starts on the output timeline. */
  startOffsetSec: number
  /** Upper bound for `out` — the source clip's length (or the current out). */
  maxOut: number
  beatsSec: number[] | null
  snapEnabled: boolean
  musicOffsetSec: number
  musicTrimInSec: number
}

/**
 * Snap a trim to the music grid, then put it back inside its bounds.
 *
 * ORDER MATTERS, and it is the whole reason this is a function.
 * `bindTrimDrag` clamps and THEN hands the value here, so a snap of up to
 * `BEAT_SNAP_THRESHOLD_SEC` could push it straight back out — and nothing
 * downstream re-checks: `dubSegmentsFromEditCuts` passes `in`/`out` through
 * untouched into `sourceIn`/`sourceOut`, and `trim_one_segment` hands those to
 * ffmpeg's trim filter as-is. A right-edge snap could leave a scene a few
 * milliseconds long (a 0- or 1-frame mp4 the concat still joins), a left-edge
 * snap a NEGATIVE `sourceIn` — which silently shortens the clip and offsets
 * every later scene, caption and effect window (2026-09-07).
 *
 * Only the cut's END lands on a new output position when trimmed — its start is
 * fixed by the cumulative duration of the cuts before it — so whichever edge is
 * dragged, it is the END that is snapped to a beat.
 */
export function snapTrimToBeat({
  patch,
  cut,
  startOffsetSec,
  maxOut,
  beatsSec,
  snapEnabled,
  musicOffsetSec,
  musicTrimInSec
}: BeatSnapTrimInput): Partial<Pick<EditCut, 'in' | 'out'>> {
  if (!snapEnabled || !beatsSec || beatsSec.length === 0) return patch

  if (patch.out !== undefined) {
    const candidateEnd = startOffsetSec + (patch.out - cut.in)
    const snappedEnd = snapCandidateToBeat(
      candidateEnd,
      beatsSec,
      true,
      musicOffsetSec,
      musicTrimInSec
    )
    return {
      out: clamp(cut.in + (snappedEnd - startOffsetSec), cut.in + MIN_CUT_SEC, maxOut)
    }
  }

  if (patch.in !== undefined) {
    const candidateEnd = startOffsetSec + (cut.out - patch.in)
    const snappedEnd = snapCandidateToBeat(
      candidateEnd,
      beatsSec,
      true,
      musicOffsetSec,
      musicTrimInSec
    )
    return { in: clamp(cut.out - (snappedEnd - startOffsetSec), 0, cut.out - MIN_CUT_SEC) }
  }

  return patch
}

/** Snap `candidate` to the nearest marker within `thresholdSec`, else return it
 * unchanged. The generic form of snapCandidateToBeat — markers are already in
 * the candidate's own clock. */
export function snapToMarkers(candidate: number, markers: number[], thresholdSec: number): number {
  let best = candidate
  let bestDist = thresholdSec
  for (const m of markers) {
    const d = Math.abs(m - candidate)
    if (d < bestDist) {
      bestDist = d
      best = m
    }
  }
  return best
}

/**
 * Offset that lands one of the track's beats on one of the video's cuts.
 *
 * Dragging music is not really about where the file starts — it is about making
 * a beat hit a cut. Searching (beat × cut) pairs and returning the offset that
 * aligns the closest pair is what "snap the drop to the cut" actually means;
 * snapping the track's START to a cut leaves the beats wherever they fell.
 *
 * Returns `candidateOffsetSec` unchanged when nothing lines up within
 * `thresholdSec`, or when there is no beat/cut data.
 */
export function snapMusicOffsetToCut(
  candidateOffsetSec: number,
  beatsSec: number[] | null,
  cutBoundaries: number[],
  musicTrimInSec: number,
  thresholdSec: number
): number {
  if (!beatsSec?.length || cutBoundaries.length === 0) return candidateOffsetSec
  let best = candidateOffsetSec
  let bestDist = thresholdSec
  for (const b of beatsSec) {
    const beatAt = b - musicTrimInSec + candidateOffsetSec
    if (beatAt < 0) continue
    for (const c of cutBoundaries) {
      const d = Math.abs(beatAt - c)
      if (d < bestDist) {
        bestDist = d
        // Shift the whole track by exactly the gap so that beat sits on that cut.
        best = candidateOffsetSec + (c - beatAt)
      }
    }
  }
  return Math.max(0, best)
}

// ---- voiceover-line helpers (dub_first) ------------------------------------

export function cutLineId(c: EditCut): number {
  if (c.voiceoverLineId != null && c.voiceoverLineId > 0) return c.voiceoverLineId
  const parsed = parseInt(String(c.label || ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

export function normalizeDubCuts(cuts: EditCut[]): EditCut[] {
  return cuts.map((c, i) => ({
    ...c,
    voiceoverLineId: c.voiceoverLineId ?? (cutLineId(c) || i + 1)
  }))
}

export function nextVoiceoverLineId(cuts: EditCut[]): number {
  const ids = cuts.map(cutLineId).filter((id) => id > 0)
  return ids.length ? Math.max(...ids) + 1 : 1
}

export function cutsInLine(cuts: EditCut[], lineId: number): EditCut[] {
  return cuts.filter((c) => cutLineId(c) === lineId)
}

export function lineScriptFor(cuts: EditCut[], lineId: number): string {
  return (
    cutsInLine(cuts, lineId)
      .find((c) => c.voiceoverScript?.trim())
      ?.voiceoverScript?.trim() ?? ''
  )
}

export function cutIndexInLine(cuts: EditCut[], cut: EditCut): number {
  const idx = cutsInLine(cuts, cutLineId(cut)).findIndex((c) => c.id === cut.id)
  return idx >= 0 ? idx + 1 : 1
}

export function countVoiceoverLines(cuts: EditCut[]): number {
  return new Set(cuts.map(cutLineId).filter((id) => id > 0)).size
}

/** One block per voiceover line on the เสียงพากย์ track: where the line's
 * first cut starts on the output timeline, and the summed screen time of all
 * its cuts (angles play back-to-back, so the block is contiguous). */
export interface VoiceoverLineBlock {
  lineId: number
  script: string
  outStart: number
  durationSec: number
  cutCount: number
  firstCutId: string
}

export function voiceoverLineBlocks(cuts: EditCut[]): VoiceoverLineBlock[] {
  const segs = computeEditedSegments(cuts)
  const byLine = new Map<number, VoiceoverLineBlock>()
  for (const seg of segs) {
    const lineId = cutLineId(seg.cut)
    const existing = byLine.get(lineId)
    if (existing) {
      existing.durationSec += seg.editedOut - seg.editedIn
      existing.cutCount += 1
    } else {
      byLine.set(lineId, {
        lineId,
        script: seg.cut.voiceoverScript?.trim() ?? '',
        outStart: seg.editedIn,
        durationSec: seg.editedOut - seg.editedIn,
        cutCount: 1,
        firstCutId: seg.cut.id
      })
    }
  }
  // A line whose script lives on a later cut still needs it on the block.
  for (const block of byLine.values()) {
    if (!block.script) block.script = lineScriptFor(cuts, block.lineId)
  }
  return Array.from(byLine.values()).sort((a, b) => a.outStart - b.outStart)
}

// ---- edits -----------------------------------------------------------------

/** Split `cut` at source-local time `atSrcSec` into two cuts. Returns null when
 * the split point leaves either side shorter than MIN_CUT_SEC. The first half
 * keeps the id (selection, filmstrip keys stay stable); the script stays on
 * the first half only, so a dub line is not duplicated. */
export function splitCutAt(
  cuts: EditCut[],
  cutId: string,
  atSrcSec: number,
  newId: string
): EditCut[] | null {
  const idx = cuts.findIndex((c) => c.id === cutId)
  if (idx < 0) return null
  const cut = cuts[idx]
  if (atSrcSec < cut.in + MIN_CUT_SEC || atSrcSec > cut.out - MIN_CUT_SEC) return null
  const first: EditCut = { ...cut, out: atSrcSec }
  const second: EditCut = { ...cut, id: newId, in: atSrcSec, voiceoverScript: '' }
  return [...cuts.slice(0, idx), first, second, ...cuts.slice(idx + 1)]
}

/** Removed-span summary for talking_head's "ตัดออกแล้ว N ช่วง · kept จาก total". */
export function removedSpanStats(
  cuts: EditCut[],
  sources: { id: string; durationSec: number }[]
): { removedCount: number; keptSec: number; totalSec: number } {
  const totalSec = sources.reduce((s, src) => s + Math.max(src.durationSec, 0), 0)
  const keptSec = computeEditedDuration(cuts)
  let removedCount = 0
  for (const src of sources) {
    const own = cuts.filter((c) => c.source === src.id).sort((a, b) => a.in - b.in || a.out - b.out)
    let cursor = 0
    for (const c of own) {
      if (c.in > cursor + 0.05) removedCount += 1
      cursor = Math.max(cursor, c.out)
    }
    if (own.length > 0 && src.durationSec > cursor + 0.05) removedCount += 1
  }
  return { removedCount, keptSec, totalSec }
}

/** Map a SOURCE-absolute caption time onto the edited/output timeline, or null
 * when that footage was cut out. Caption lines carry no source id, so the
 * first cut containing the time wins — the same approximation the preview
 * overlay has always made. */
export function mapSourceTimeToOutput(cuts: EditCut[], srcSec: number): number | null {
  const segs = computeEditedSegments(cuts)
  for (const seg of segs) {
    if (srcSec >= seg.cut.in - 0.001 && srcSec < seg.cut.out + 0.001) {
      return seg.editedIn + clamp(srcSec - seg.cut.in, 0, seg.editedOut - seg.editedIn)
    }
  }
  return null
}

export interface CaptionChipSpan {
  id: string
  text: string
  outStart: number
  durationSec: number
  /** The containing cut's source bounds — dragging an edge is clamped to them
   * so a retimed caption can never outlive the scene it belongs to, which is
   * the invariant the dub_first caption split exists to guarantee. */
  cutIn: number
  cutOut: number
}

/** Caption chip geometry on the คำบรรยาย track (edited mode). */
export function captionChipSpans(cuts: EditCut[], lines: CaptionLine[]): CaptionChipSpan[] {
  const out: CaptionChipSpan[] = []
  const segs = computeEditedSegments(cuts)
  for (const line of lines) {
    for (const seg of segs) {
      const s = Math.max(line.start, seg.cut.in)
      const e = Math.min(line.end, seg.cut.out)
      if (e - s < 0.05) continue
      out.push({
        id: line.id,
        text: line.text,
        outStart: seg.editedIn + (s - seg.cut.in),
        durationSec: e - s,
        cutIn: seg.cut.in,
        cutOut: seg.cut.out
      })
      break // first containing cut wins — one chip per line
    }
  }
  return out.sort((a, b) => a.outStart - b.outStart)
}

/**
 * Chip spans for caption lines already timed on the OUTPUT clock.
 *
 * dub_first captions are derived from the voiceover script laid out along the
 * finished cut (`dubCaptionLines`), so their times ARE output times — the
 * source-time version above would compare them against each cut's source
 * in/out and drop nearly all of them (live 2026-08-13: a 20-line project drew
 * exactly one chip). talking_head is the other case: its lines come from raw
 * transcript words, which are source times.
 *
 * `cutIn`/`cutOut` come back in the SAME clock as the line, so edge-dragging
 * clamps to the containing scene either way.
 */
export function captionChipSpansFromOutput(
  cuts: EditCut[],
  lines: CaptionLine[]
): CaptionChipSpan[] {
  const segs = computeEditedSegments(cuts)
  const out: CaptionChipSpan[] = []
  for (const line of lines) {
    for (const seg of segs) {
      const s = Math.max(line.start, seg.editedIn)
      const e = Math.min(line.end, seg.editedOut)
      if (e - s < 0.05) continue
      out.push({
        id: line.id,
        text: line.text,
        outStart: s,
        durationSec: e - s,
        cutIn: seg.editedIn,
        cutOut: seg.editedOut
      })
      break // first containing scene wins — one chip per line
    }
  }
  return out.sort((a, b) => a.outStart - b.outStart)
}

/** Shortest caption a drag may leave behind. */
export const MIN_CAPTION_SEC = 0.2

/**
 * A caption edge dragged by `deltaSec`, in SOURCE time.
 *
 * Output time runs 1:1 with source time inside a cut, so the pixel delta needs
 * no conversion beyond px→sec. Clamped to the cut so the caption stays inside
 * its scene, and to MIN_CAPTION_SEC so it cannot be dragged out of existence.
 */
export function dragCaptionEdge(
  line: { start: number; end: number },
  span: { cutIn: number; cutOut: number },
  edge: TrimEdge,
  deltaSec: number
): { start: number; end: number } {
  if (edge === 'left') {
    const start = clamp(line.start + deltaSec, span.cutIn, line.end - MIN_CAPTION_SEC)
    return { start, end: line.end }
  }
  const end = clamp(line.end + deltaSec, line.start + MIN_CAPTION_SEC, span.cutOut)
  return { start: line.start, end }
}

// ---- drag binding (window-level, shared by every trim/move handle) ---------

export type TrimEdge = 'left' | 'right'

/** Window-level trim drag — reliable even when the pointer leaves the handle.
 * `pxPerSec` is passed per-call because zoom made it state, not a constant. */
export function bindTrimDrag(opts: {
  e: { stopPropagation(): void; preventDefault(): void; clientX: number }
  edge: TrimEdge
  pxPerSec: number
  startIn: number
  startOut: number
  minIn?: number
  maxOut: number
  onChange: (patch: Partial<EditCut>) => void
  onDragStart: () => void
  onDragEnd: () => void
}): void {
  opts.e.stopPropagation()
  opts.e.preventDefault()
  opts.onDragStart()
  const startX = opts.e.clientX
  const { startIn, startOut, minIn = 0, maxOut, edge, pxPerSec, onChange, onDragEnd } = opts

  function onMove(ev: PointerEvent): void {
    const deltaSec = (ev.clientX - startX) / pxPerSec
    if (edge === 'left') {
      onChange({ in: clamp(startIn + deltaSec, minIn, startOut - MIN_CUT_SEC) })
    } else {
      onChange({ out: clamp(startOut + deltaSec, startIn + MIN_CUT_SEC, maxOut) })
    }
  }

  function onUp(): void {
    onDragEnd()
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
  }

  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp)
}
