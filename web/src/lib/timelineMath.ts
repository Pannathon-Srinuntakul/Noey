/**
 * Pure math for the video timeline editor (R3).
 *
 * Everything here is deliberately free of React and the DOM so the geometry
 * the editor draws — and the edits it commits — can be unit-tested without
 * mounting a 3,000-line component. The component owns state and playback;
 * this file owns arithmetic.
 */
import type { CaptionLine, EditCut } from './editorApi'

/** Re-exported so the timeline modules built on this math (snap targets,
 * selection, …) can take the cut type from the same place as the functions. */
export type { EditCut } from './editorApi'

export const MIN_CUT_SEC = 0.2
export const DEFAULT_NEW_CUT_SEC = 2
/** Base scale filmstrip tile math is anchored to — the on-screen zoom
 * (`pxPerSec` state) stretches the display, it never regenerates tiles. */
export const BASE_PX_PER_SEC = 40

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/** Round a DECIMAL grid value (ruler ticks: i × 0.1) away from float noise.
 * Never used on cut times: the nudge unit is 1/30 s, which no decimal
 * rounding represents — thirty rounded steps drift off 1.0 instead of
 * landing on it. */
function r9(n: number): number {
  return Math.round(n * 1e9) / 1e9
}

// ---- skipped scenes (ข้ามฉาก) --------------------------------------------------

/** A scene the user parked without deleting it: it keeps its place in the
 * list (and survives a reload through `meta.skipped`, which cutPayload carries)
 * but has no span on the output clock — no segment, no boundary, no caption
 * chip, and the render save drops it (`cutPayload(..., { dropSkipped })`). */
export function isSkipped(cut: Pick<EditCut, 'meta'>): boolean {
  return cut.meta?.skipped === true
}

/** The list with cut `id` skipped, or un-skipped when it already was. A cut
 * that is not in the list comes back unchanged. Un-skipping removes the key
 * (and an emptied `meta` altogether) so the saved segment is byte-for-byte
 * what it was before the skip. */
export function withSkipToggled(cuts: EditCut[], id: string): EditCut[] {
  return cuts.map((c) => {
    if (c.id !== id) return c
    if (isSkipped(c)) {
      const rest: Record<string, unknown> = { ...c.meta }
      delete rest.skipped
      return { ...c, meta: Object.keys(rest).length ? rest : undefined }
    }
    return { ...c, meta: { ...(c.meta ?? {}), skipped: true } }
  })
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

/** Sign of a delta for the readouts: a real minus sign (U+2212), and nothing
 * for a delta that rounds to zero at the shown precision — "−0.00" is a lie. */
function signOf(n: number, unit: number): '+' | '−' | '' {
  if (n >= unit / 2) return '+'
  if (n <= -unit / 2) return '−'
  return ''
}

/** A signed delta for the drag readout — "+0.40 วิ" / "−0.07 วิ" / "0.00 วิ". */
export function fmtSignedSec(deltaSec: number): string {
  if (!Number.isFinite(deltaSec)) return '0.00 วิ'
  const sign = signOf(deltaSec, 0.01)
  return `${sign}${Math.abs(deltaSec).toFixed(2)} วิ`
}

/** A signed delta in whole frames — "+12 เฟรม" / "−1 เฟรม" / "0 เฟรม". Only the
 * drag readout and the timecode entry speak in frames; the transport clock
 * stays fmtTimeTenths. */
export function fmtFrames(deltaSec: number, fps = 30): string {
  if (!Number.isFinite(deltaSec)) return '0 เฟรม'
  const frames = Math.round(deltaSec * fps)
  const sign = frames > 0 ? '+' : frames < 0 ? '−' : ''
  return `${sign}${Math.abs(frames)} เฟรม`
}

/** Frame-accurate timecode "m:ss:ff" (ff = frame within the second, 00–29 at
 * 30 fps). Rounds to the nearest frame, so 29.5 frames carries into the next
 * second rather than printing a frame 30 that does not exist. */
export function fmtTimecodeFrames(sec: number, fps = 30): string {
  if (!Number.isFinite(sec) || sec < 0 || !(fps > 0)) return '0:00:00'
  const totalFrames = Math.round(sec * fps)
  const ff = totalFrames % fps
  const wholeSec = Math.floor(totalFrames / fps)
  const m = Math.floor(wholeSec / 60)
  const s = wholeSec % 60
  return `${m}:${String(s).padStart(2, '0')}:${String(ff).padStart(2, '0')}`
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

/** What a timecode field commits on blur: nothing when the text is still
 * what focus showed (the field shows tenths, so re-parsing it would floor the
 * real value — 3.4667 → 3.4), nothing for text that does not parse. */
export function timecodeCommitValue(draft: string, focusText: string | null): number | null {
  return draft === focusText ? null : parseTimecode(draft)
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

export interface RulerTicks {
  /** Label step — rulerStepSec. */
  stepSec: number
  /** Minor tick step: a fifth of the label step, or a tenth when tenths are
   * still ≥ 12 px apart (they always are at rulerStepSec's ≥ 140 px labels,
   * but the rule is written down so a cheaper label step keeps ticks legible). */
  subStepSec: number
  /** Labelled ticks, 0 first, running to the first step at or past the end. */
  majors: number[]
  /** Unlabelled ticks between the majors — never on a major. */
  minors: number[]
}

/** The ruler's tick grid: something to aim at between the labels. With only
 * one tick per label, at 160 px/s a label every 160 px left a 1 s stretch
 * with no mark to line a trim up against. */
export function rulerTicks(pxPerSec: number, durationSec: number): RulerTicks {
  const stepSec = rulerStepSec(pxPerSec)
  const divs = (stepSec / 10) * pxPerSec >= 12 ? 10 : 5
  const subStepSec = stepSec / divs
  const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0
  // Same count the ruler has always drawn: every step up to and including the
  // first one at or past the end.
  const majorCount = Math.max(1, Math.ceil(dur / stepSec) + 1)
  const majors: number[] = []
  for (let i = 0; i < majorCount; i += 1) majors.push(r9(i * stepSec))
  const minors: number[] = []
  const lastIdx = (majorCount - 1) * divs
  for (let i = 1; i < lastIdx; i += 1) {
    if (i % divs === 0) continue
    minors.push(r9(i * subStepSec))
  }
  return { stepSec, subStepSec, majors, minors }
}

export interface EditedSegment {
  cut: EditCut
  editedIn: number
  editedOut: number
}

/** Map cuts onto one continuous "edited" timeline — strict back-to-back, no
 * overlap. A skipped scene (isSkipped) has NO segment: the scenes after it
 * start earlier, exactly as the render will lay them, and a lookup of its id
 * in the result is undefined — the lane draws it as a stub, the player never
 * reaches it. */
export function computeEditedSegments(cuts: EditCut[]): EditedSegment[] {
  let acc = 0
  const segs: EditedSegment[] = []
  for (const c of cuts) {
    if (isSkipped(c)) continue
    const dur = Math.max(c.out - c.in, 0)
    segs.push({ cut: c, editedIn: acc, editedOut: acc + dur })
    acc += dur
  }
  return segs
}

export function computeEditedDuration(cuts: EditCut[]): number {
  return cuts.reduce((sum, c) => (isSkipped(c) ? sum : sum + Math.max(c.out - c.in, 0)), 0)
}

/** Find which cut a position on the concatenated edited timeline falls into. */
export function findEditedSegment(cuts: EditCut[], t: number): EditedSegment | null {
  return findSegmentAt(computeEditedSegments(cuts), t)
}

/** findEditedSegment over segments already laid out — for the playback frame
 * loop and the scrub, which ask many times against one cut list and must not
 * rebuild the whole layout for every answer. */
export function findSegmentAt(segs: EditedSegment[], t: number): EditedSegment | null {
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

/**
 * sourceNeighborBounds for every cut on one lane, from a single sort.
 *
 * Asking per cut sorted the whole lane once per block on every render. Same
 * order, same neighbours, same answer; a repeated id keeps its first place in
 * that order, as findIndex does there.
 */
export function sourceNeighborBoundsById(
  sourceCuts: EditCut[],
  laneDurationSec: number
): Map<string, { minIn: number; maxOut: number }> {
  const sorted = [...sourceCuts].sort((a, b) => a.in - b.in || a.out - b.out)
  const bounds = new Map<string, { minIn: number; maxOut: number }>()
  sorted.forEach((c, i) => {
    if (bounds.has(c.id)) return
    const prev = i > 0 ? sorted[i - 1] : null
    const next = i < sorted.length - 1 ? sorted[i + 1] : null
    bounds.set(c.id, { minIn: prev ? prev.out : 0, maxOut: next ? next.in : laneDurationSec })
  })
  return bounds
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
 *
 * @deprecated Beats are one SnapTarget kind among many now — use
 * `snapTrimPatch` in `lib/timelineSnap.ts` (same clamp-after-snap rule, every
 * target kind, a pixel-based tolerance). Kept for the pinned regression tests
 * and any straggling caller; not deleted this round.
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
  return lineScriptDraft(cuts, lineId).trim()
}

/**
 * A line's script exactly as it was typed — what the script box shows. Trimmed
 * on every keystroke, a space at the end of the box was gone before the next
 * word could follow it, and so was a new line (owner, 2026-09-22); the value is
 * trimmed where it is stored instead (cutPayload).
 */
export function lineScriptDraft(cuts: EditCut[], lineId: number): string {
  const line = cutsInLine(cuts, lineId)
  // The cut that carries the words — on a loaded script it can be a later
  // angle. A box holding only whitespace so far lives on the first cut.
  const carrier = line.find((c) => c.voiceoverScript?.trim()) ?? line[0]
  return carrier?.voiceoverScript ?? ''
}

/**
 * A voiceover line's angles play back to back, so its cuts must sit next to
 * each other in the list: the VO lane draws a line as one block from its first
 * cut for the summed length of all of them, and the render spans a line from
 * its first in to its last out. A line split by another scene claims that
 * scene's time too (bug hunt 2026-09-22, #13). Every edit that adds or moves a
 * cut keeps that true through these two.
 *
 * `idx` as an insert position, moved to the end of the line run it would land
 * inside of — unchanged when it falls between two lines. Line 0 (a cut with
 * no line) never forms a run.
 */
export function insertIndexOutsideLineRuns(cuts: EditCut[], idx: number): number {
  let i = idx
  while (i > 0 && i < cuts.length) {
    const lineId = cutLineId(cuts[i - 1])
    if (lineId === 0 || cutLineId(cuts[i]) !== lineId) break
    i += 1
  }
  return i
}

/** The index just past the contiguous run of line cuts that holds `idx`. */
function lineRunEnd(cuts: EditCut[], idx: number): number {
  const lineId = cutLineId(cuts[idx])
  let end = idx + 1
  if (lineId === 0) return end
  while (end < cuts.length && cutLineId(cuts[end]) === lineId) end += 1
  return end
}

/**
 * ลากตัวบล็อกเพื่อสลับลำดับ — the list with cut `activeId` moved to where
 * `overId` is. In a dub project it keeps every voiceover line in one piece:
 * a scene dropped between two angles of ANOTHER line lands past that line, on
 * the side it was dragged towards; an angle dragged away from its own line
 * becomes a line of its own (its script, when it carried the line's, stays
 * with the angles left behind). Null when nothing moves.
 */
export function withReorder(
  prev: EditCut[],
  activeId: string,
  overId: string,
  isDub: boolean
): EditCut[] | null {
  const from = prev.findIndex((c) => c.id === activeId)
  const to = prev.findIndex((c) => c.id === overId)
  if (from < 0 || to < 0 || from === to) return null
  const moved = prev[from]
  const rest = [...prev.slice(0, from), ...prev.slice(from + 1)]
  if (!isDub) return [...rest.slice(0, to), moved, ...rest.slice(to)]

  const ownLine = cutLineId(moved)
  let at = to
  // Inside another line's run: jump over it in the drag's direction.
  if (at > 0 && at < rest.length) {
    const splitLine = cutLineId(rest[at - 1])
    if (splitLine !== 0 && splitLine !== ownLine && cutLineId(rest[at]) === splitLine) {
      if (to > from) {
        at = insertIndexOutsideLineRuns(rest, at)
      } else {
        while (at > 0 && cutLineId(rest[at - 1]) === splitLine) at -= 1
      }
    }
  }
  const next = [...rest.slice(0, at), moved, ...rest.slice(at)]
  if (at === from) return null

  // Still next to an angle of its own line (or the line's only cut)?
  const others = rest.filter((c) => cutLineId(c) === ownLine)
  const touchesOwn =
    (at > 0 && cutLineId(next[at - 1]) === ownLine) ||
    (at + 1 < next.length && cutLineId(next[at + 1]) === ownLine)
  if (ownLine === 0 || others.length === 0 || touchesOwn) return next

  const newLineId = nextVoiceoverLineId(prev)
  const carried = moved.voiceoverScript ?? ''
  const keeperId = others[0].id
  const keeperNeedsScript = !lineScriptFor(others, ownLine) && carried.trim() !== ''
  return next.map((c) => {
    if (c.id === moved.id) {
      return {
        ...c,
        label: `บรรทัด ${newLineId}`,
        voiceoverLineId: newLineId,
        voiceoverScript: ''
      }
    }
    if (keeperNeedsScript && c.id === keeperId) return { ...c, voiceoverScript: carried }
    return c
  })
}

/** Alt+↑/↓ — cut `id` swapped with its neighbour one slot earlier (−1) or
 * later (+1), through withReorder so a dub line's run is jumped over rather
 * than split. Null at either end of the list, or for an unknown id. */
export function withSceneMoved(
  cuts: EditCut[],
  id: string,
  dir: -1 | 1,
  isDub: boolean
): EditCut[] | null {
  const idx = cuts.findIndex((c) => c.id === id)
  if (idx < 0) return null
  const neighbour = cuts[idx + dir]
  if (!neighbour) return null
  return withReorder(cuts, id, neighbour.id, isDub)
}

/**
 * A multi-selection dragged as one block onto `overId`'s slot. `ids` must be
 * contiguous in play order — a scattered selection has no single slot to
 * move to, so it is null and the caller says 'เลือกฉากที่ติดกันเพื่อย้ายพร้อมกัน'.
 * The block lands where withReorder would put its FIRST member: after the
 * scene at `overId` when moving later, before it when moving earlier. In a
 * dub project another line's run is jumped over (insertIndexOutsideLineRuns),
 * and a part of a line carried away from the rest of it becomes a line of
 * its own — with the line's script left on the angles that stayed, as
 * withReorder does. Null when nothing moves. A single id is withReorder.
 */
export function withReorderMany(
  cuts: EditCut[],
  ids: readonly string[],
  overId: string,
  isDub: boolean
): EditCut[] | null {
  const wanted = new Set(ids)
  const positions: number[] = []
  cuts.forEach((c, i) => {
    if (wanted.has(c.id)) positions.push(i)
  })
  if (positions.length === 0) return null
  if (positions.length === 1) return withReorder(cuts, cuts[positions[0]].id, overId, isDub)
  for (let i = 1; i < positions.length; i += 1) {
    if (positions[i] !== positions[i - 1] + 1) return null
  }
  const from = positions[0]
  const len = positions.length
  const to = cuts.findIndex((c) => c.id === overId)
  if (to < 0 || (to >= from && to < from + len)) return null

  const block = cuts.slice(from, from + len)
  const rest = [...cuts.slice(0, from), ...cuts.slice(from + len)]
  // Moving later: land right after the scene dropped on (it sits at to − len
  // in `rest`). Moving earlier: land right before it (still at `to`).
  let at = to > from ? to - len + 1 : to
  if (isDub && at > 0 && at < rest.length) {
    const splitLine = cutLineId(rest[at - 1])
    const blockLines = new Set(block.map(cutLineId))
    if (splitLine !== 0 && !blockLines.has(splitLine) && cutLineId(rest[at]) === splitLine) {
      if (to > from) {
        at = insertIndexOutsideLineRuns(rest, at)
      } else {
        while (at > 0 && cutLineId(rest[at - 1]) === splitLine) at -= 1
      }
    }
  }
  if (at === from) return null
  let next = [...rest.slice(0, at), ...block, ...rest.slice(at)]
  if (!isDub) return next

  // A line whose angles are only partly in the block sits at one of the
  // block's ends (lines are contiguous runs, and so is the block). A part
  // that no longer touches the rest of its line becomes a new line; the
  // line's script stays with the angles left behind (as withReorder).
  const detachLine = (line: number, touchesOwn: boolean): void => {
    if (line === 0 || touchesOwn) return
    const others = rest.filter((c) => cutLineId(c) === line)
    if (others.length === 0) return
    const movedOfLine = block.filter((c) => cutLineId(c) === line)
    const newLineId = nextVoiceoverLineId(next)
    const carried = lineScriptFor(movedOfLine, line)
    const keeperId = others[0].id
    const keeperNeedsScript = !lineScriptFor(others, line) && carried !== ''
    const movedIds = new Set(movedOfLine.map((c) => c.id))
    next = next.map((c) => {
      if (movedIds.has(c.id)) {
        const angle = movedOfLine.findIndex((m) => m.id === c.id) + 1
        return {
          ...c,
          label:
            movedOfLine.length > 1 ? `บรรทัด ${newLineId} · มุม ${angle}` : `บรรทัด ${newLineId}`,
          voiceoverLineId: newLineId,
          voiceoverScript: ''
        }
      }
      if (keeperNeedsScript && c.id === keeperId) return { ...c, voiceoverScript: carried }
      return c
    })
  }
  const firstLine = cutLineId(block[0])
  const lastLine = cutLineId(block[len - 1])
  const before = next[at - 1]
  const after = next[at + len]
  const leftTouch = !!before && cutLineId(before) === firstLine
  const rightTouch = !!after && cutLineId(after) === lastLine
  if (firstLine === lastLine) {
    // Same line at both ends means the whole block is that line.
    detachLine(firstLine, leftTouch || rightTouch)
  } else {
    detachLine(firstLine, leftTouch)
    detachLine(lastLine, rightTouch)
  }
  return next
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
  // The AI's per-shot metadata (alternates, …) stays with the first half: a
  // copy on both halves would offer the same backups twice in ปรับช็อต.
  const second: EditCut = { ...cut, id: newId, in: atSrcSec, voiceoverScript: '', meta: undefined }
  return [...cuts.slice(0, idx), first, second, ...cuts.slice(idx + 1)]
}

export interface EdgeBounds {
  /** How far the cut's `in` may go back — 0 or the lane neighbour's out. */
  minIn: number
  /** How far the cut's `out` may go — the source length or the lane neighbour's in. */
  maxOut: number
}

export interface RollBounds {
  /** Bounds of the left cut (its `in` never moves; `leftMinIn` is accepted so
   * the caller can pass the same shape it passes to a trim). */
  leftMinIn: number
  leftMaxOut: number
  /** Bounds of the right cut (its `out` never moves). */
  rightMinIn: number
  rightMaxOut: number
}

/**
 * Roll edit — "give this beat to the other shot". The boundary between cut
 * `leftId` and the cut AFTER it in play order moves by `deltaSec`: left.out
 * and right.in shift by ONE shared, clamped delta, so the total edited length
 * is unchanged and nothing after the pair moves on the output clock. Both
 * neighbours are windows into different source moments, so each is clamped
 * on its own footage: the left keeps ≥ MIN_CUT_SEC and stays ≤ leftMaxOut,
 * the right keeps ≥ MIN_CUT_SEC and stays ≥ rightMinIn — the tighter one
 * wins for both. Null when `leftId` is the last cut (no junction), unknown,
 * or the clamped delta is 0.
 */
export function rollCutBoundary(
  cuts: EditCut[],
  leftId: string,
  deltaSec: number,
  bounds: RollBounds
): EditCut[] | null {
  const idx = cuts.findIndex((c) => c.id === leftId)
  if (idx < 0 || idx >= cuts.length - 1 || !Number.isFinite(deltaSec)) return null
  const left = cuts[idx]
  const right = cuts[idx + 1]
  const dMax = Math.min(bounds.leftMaxOut - left.out, right.out - MIN_CUT_SEC - right.in)
  const dMin = Math.max(left.in + MIN_CUT_SEC - left.out, bounds.rightMinIn - right.in)
  if (dMin > dMax + 1e-9) return null // already outside its bounds — do not make it worse
  const d = clamp(deltaSec, dMin, dMax)
  if (Math.abs(d) < 1e-9) return null
  const next = [...cuts]
  next[idx] = { ...left, out: left.out + d }
  next[idx + 1] = { ...right, in: right.in + d }
  return next
}

/**
 * Slip — the window moves inside its source, the block does not move on the
 * output clock: `in` and `out` shift together by `deltaSec`, duration kept,
 * clamped so in ≥ minIn and out ≤ maxOut (the same arithmetic the source
 * view's block drag did inline). A window wider than its bounds is returned
 * unchanged rather than squeezed.
 */
export function slipCut(
  cut: Pick<EditCut, 'in' | 'out'>,
  deltaSec: number,
  bounds: EdgeBounds
): { in: number; out: number } {
  const lo = bounds.minIn - cut.in
  const hi = bounds.maxOut - cut.out
  if (!Number.isFinite(deltaSec) || lo > hi + 1e-9) return { in: cut.in, out: cut.out }
  const d = clamp(deltaSec, lo, hi)
  return { in: cut.in + d, out: cut.out + d }
}

/**
 * One edge of cut `id` moved by a signed amount (callers pass FRAME_SEC
 * multiples — Alt+←/→), with the same clamps a trim handle has: the left
 * edge stays in [minIn, out − MIN_CUT_SEC], the right in
 * [in + MIN_CUT_SEC, maxOut]. Null when the edge cannot move (already at its
 * limit, unknown id, zero delta) so the caller records no undo step.
 */
export function nudgeCutEdge(
  cuts: EditCut[],
  id: string,
  edge: TrimEdge,
  deltaSec: number,
  bounds: EdgeBounds
): EditCut[] | null {
  const idx = cuts.findIndex((c) => c.id === id)
  if (idx < 0 || !Number.isFinite(deltaSec)) return null
  const cut = cuts[idx]
  const patch =
    edge === 'left'
      ? { in: clamp(cut.in + deltaSec, bounds.minIn, cut.out - MIN_CUT_SEC) }
      : { out: clamp(cut.out + deltaSec, cut.in + MIN_CUT_SEC, bounds.maxOut) }
  const before = edge === 'left' ? cut.in : cut.out
  const after = edge === 'left' ? patch.in! : patch.out!
  if (Math.abs(after - before) < 1e-9) return null
  const next = [...cuts]
  next[idx] = { ...cut, ...patch }
  return next
}

/** The list without every cut whose id is in `ids` — one undo step for a
 * multi-selection's Delete. Null when none of them is in the list. */
export function withCutsRemoved(cuts: EditCut[], ids: ReadonlySet<string>): EditCut[] | null {
  const next = cuts.filter((c) => !ids.has(c.id))
  return next.length === cuts.length ? null : next
}

/** The ids from `a` to `b` inclusive in `orderedIds`, whichever comes first —
 * a Shift+click range. When only one of them is in the list, that one; when
 * neither, nothing. */
export function idsBetween(orderedIds: readonly string[], a: string, b: string): string[] {
  const ia = orderedIds.indexOf(a)
  const ib = orderedIds.indexOf(b)
  if (ia < 0 && ib < 0) return []
  if (ia < 0) return [b]
  if (ib < 0) return [a]
  return orderedIds.slice(Math.min(ia, ib), Math.max(ia, ib) + 1)
}

/**
 * วาง (⌘V) — the list with copies of `clipboard` inserted after `afterId`
 * (at the front when null; at the end when the id is gone). Every copy gets
 * a fresh id from `nextId()` and, as withDuplicate does, loses the AI's
 * per-shot `meta` — a pasted shot must not offer the original's alternates a
 * second time, and never arrives skipped. In a dub project the copies become
 * angles of the line of the cut before the insertion point (the first cut's
 * line when prepending), so no line's run is ever split; an empty list opens
 * a new line. An angle's script is empty — the line's lives on its first cut.
 */
export function pasteCuts(
  cuts: EditCut[],
  afterId: string | null,
  clipboard: EditCut[],
  nextId: () => string,
  isDub: boolean
): EditCut[] {
  if (clipboard.length === 0) return cuts
  let at = cuts.length
  if (afterId === null) {
    at = 0
  } else {
    const idx = cuts.findIndex((c) => c.id === afterId)
    if (idx >= 0) at = idx + 1
  }
  let lineId: number | undefined
  if (isDub) {
    const neighbour = at > 0 ? cuts[at - 1] : cuts[0]
    lineId = neighbour ? cutLineId(neighbour) : 0
    if (lineId === 0) lineId = nextVoiceoverLineId(cuts)
  }
  const angleBase = isDub ? cutsInLine(cuts, lineId!).length : 0
  const copies = clipboard.map((src, i) => {
    const copy: EditCut = { ...src, id: nextId(), meta: undefined }
    if (isDub) {
      copy.label = `บรรทัด ${lineId} · มุม ${angleBase + i + 1}`
      copy.voiceoverLineId = lineId
      copy.voiceoverScript = ''
    }
    return copy
  })
  return [...cuts.slice(0, at), ...copies, ...cuts.slice(at)]
}

/** A fresh id for a piece withRangeRemoved splits off when the caller has no
 * counter of its own: the parent's id with a suffix no cut has yet. */
function defaultSplitId(cuts: EditCut[]): () => string {
  const taken = new Set(cuts.map((c) => c.id))
  let n = 0
  return () => {
    let id: string
    do {
      n += 1
      id = `range-${n}`
    } while (taken.has(id))
    taken.add(id)
    return id
  }
}

/**
 * Shift+Delete — the list with the OUTPUT-clock range [inSec, outSec] taken
 * out: every scene whose span lies inside the range is dropped, and the
 * scene under each end is cut there. A range inside ONE scene splits it with
 * splitCutAt (the first half keeps the id, the tail past outSec gets one
 * from `nextId`); a scene the range only overlaps at one end is trimmed to
 * the part it keeps, so it keeps its id (selection, filmstrip keys). Skipped
 * scenes take no output time, so they stay where they are.
 *
 * Null when the range is shorter than MIN_CUT_SEC, when a piece that would
 * remain is shorter than MIN_CUT_SEC (the edit is refused whole rather than
 * leaving a sliver), or when nothing lies under the range.
 */
export function withRangeRemoved(
  cuts: EditCut[],
  range: { inSec: number; outSec: number },
  nextId: () => string = defaultSplitId(cuts)
): EditCut[] | null {
  const inSec = Math.min(range.inSec, range.outSec)
  const outSec = Math.max(range.inSec, range.outSec)
  if (!Number.isFinite(inSec) || !Number.isFinite(outSec)) return null
  if (outSec - inSec < MIN_CUT_SEC - 1e-9) return null
  const EPS = 1e-6
  const strictlyInside = (s: EditedSegment, t: number): boolean =>
    t > s.editedIn + EPS && t < s.editedOut - EPS

  // Judged on the ORIGINAL layout: the edits below shorten the clock after
  // each end, which would pull a kept piece into the range if judged later.
  const segs = computeEditedSegments(cuts)
  const inside = new Set(
    segs
      .filter((s) => s.editedIn >= inSec - EPS && s.editedOut <= outSec + EPS)
      .map((s) => s.cut.id)
  )
  const outSeg = segs.find((s) => strictlyInside(s, outSec))
  const inSegBefore = segs.find((s) => strictlyInside(s, inSec))
  if (inside.size === 0 && !outSeg && !inSegBefore) return null

  // The out end: the scene under it keeps its part AFTER outSec. When that
  // scene also reaches back past inSec the range is inside it — split, so
  // the part before inSec survives too.
  let list = cuts
  if (outSeg) {
    const srcAt = outSeg.cut.in + (outSec - outSeg.editedIn)
    if (outSeg.cut.out - srcAt < MIN_CUT_SEC - 1e-9) return null
    if (outSeg.editedIn < inSec - EPS) {
      const split = splitCutAt(cuts, outSeg.cut.id, srcAt, nextId())
      if (!split) return null
      list = split
    } else {
      list = cuts.map((c) => (c.id === outSeg.cut.id ? { ...c, in: srcAt } : c))
    }
  }

  // The in end: the scene under it keeps its part BEFORE inSec — the rest is
  // inside the range, since the out end is already cut. Found again on the
  // edited list so the single-scene case sees the first half.
  const inSeg = computeEditedSegments(list).find((s) => strictlyInside(s, inSec))
  if (inSeg) {
    const srcAt = inSeg.cut.in + (inSec - inSeg.editedIn)
    if (srcAt - inSeg.cut.in < MIN_CUT_SEC - 1e-9) return null
    list = list.map((c) => (c.id === inSeg.cut.id ? { ...c, out: srcAt } : c))
  }

  return list.filter((c) => !inside.has(c.id))
}

/** เพิ่มฉาก (N) — the list with a new scene [start, end) of `source`. It goes
 * right after `afterCutId` when given — the edited view's scene under the
 * playhead, since there the list's order IS the timeline and source time says
 * nothing about where the user is (bug hunt #31). Otherwise it goes at the
 * end, or with `atPlayhead` in front of the first cut of the same file that
 * starts at or after `start` (after that file's last cut when none does) —
 * the source view, where lanes are laid out by source time. A dub scene opens
 * a new voiceover line with an empty script, and never inside another line's
 * run of angles (see insertIndexOutsideLineRuns). */
export function withNewScene(
  prev: EditCut[],
  opts: {
    id: string
    source: string
    start: number
    end: number
    isDub: boolean
    atPlayhead: boolean
    afterCutId?: string
  }
): EditCut[] {
  const { id, source, start, end, isDub, atPlayhead, afterCutId } = opts
  const newLineId = isDub ? nextVoiceoverLineId(prev) : undefined
  const created: EditCut = {
    id,
    source,
    in: start,
    out: end,
    label: isDub ? `บรรทัด ${newLineId}` : 'ฉากใหม่',
    voiceoverLineId: newLineId,
    voiceoverScript: isDub ? '' : undefined
  }
  let insertIdx = prev.length
  const afterIdx = afterCutId ? prev.findIndex((c) => c.id === afterCutId) : -1
  if (afterIdx >= 0) {
    insertIdx = afterIdx + 1
  } else if (atPlayhead) {
    let placed = false
    for (let i = 0; i < prev.length; i += 1) {
      if (prev[i].source === source && prev[i].in >= start - 0.01) {
        insertIdx = i
        placed = true
        break
      }
    }
    if (!placed) {
      for (let i = prev.length - 1; i >= 0; i -= 1) {
        if (prev[i].source === source) {
          insertIdx = i + 1
          break
        }
      }
    }
  }
  if (isDub) insertIdx = insertIndexOutsideLineRuns(prev, insertIdx)
  return [...prev.slice(0, insertIdx), created, ...prev.slice(insertIdx)]
}

/** เพิ่มมุม (M) — the list with another angle for voiceover line `lineId`,
 * right after the line's last cut (at the end when the line has none). An
 * angle shares its line's script, which lives on the line's first cut, so its
 * own is empty. */
export function withNewAngle(
  prev: EditCut[],
  opts: { id: string; source: string; lineId: number; start: number; end: number }
): EditCut[] {
  const { id, source, lineId, start, end } = opts
  const angleNum = cutsInLine(prev, lineId).length + 1
  const created: EditCut = {
    id,
    source,
    in: start,
    out: end,
    label: `บรรทัด ${lineId} · มุม ${angleNum}`,
    voiceoverLineId: lineId,
    voiceoverScript: ''
  }
  let insertIdx = prev.length
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    if (cutLineId(prev[i]) === lineId) {
      insertIdx = i + 1
      break
    }
  }
  return [...prev.slice(0, insertIdx), created, ...prev.slice(insertIdx)]
}

/** ทำซ้ำ — the list with a copy of cut `cutId` right after it, under `newId`.
 * In a dub project the copy is a new voiceover line carrying the original's
 * script, so it goes after the original's LAST angle rather than between two
 * of them (see insertIndexOutsideLineRuns). Null when `cutId` is no longer in the list, so the caller records no
 * undo step for an edit that did nothing. */
export function withDuplicate(
  prev: EditCut[],
  cutId: string,
  newId: string,
  isDub: boolean
): EditCut[] | null {
  const idx = prev.findIndex((c) => c.id === cutId)
  if (idx < 0) return null
  const src = prev[idx]
  const newLineId = isDub ? nextVoiceoverLineId(prev) : undefined
  const copy: EditCut = {
    ...src,
    id: newId,
    label: isDub ? `บรรทัด ${newLineId}` : src.label,
    voiceoverLineId: newLineId ?? src.voiceoverLineId,
    voiceoverScript: isDub ? (src.voiceoverScript ?? '') : src.voiceoverScript,
    // The AI's per-shot metadata (alternates, swappedFrom, …) stays with the
    // original, as in splitCutAt: a copy made ปรับช็อต ask the same question
    // twice and could put the same backup shot into the clip twice.
    meta: undefined
  }
  const at = isDub ? lineRunEnd(prev, idx) : idx + 1
  return [...prev.slice(0, at), copy, ...prev.slice(at)]
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
 * A chip covers the WHOLE line, across every scene it overlaps, and its drag
 * range is those scenes together. talking_head groups words three at a time
 * regardless of cuts, so its lines straddle scene boundaries routinely; the
 * chip used to stop at the first scene's end, and touching its right edge cut
 * the real line down to that scene.
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
    const covered = segs.filter(
      (seg) => Math.min(line.end, seg.editedOut) - Math.max(line.start, seg.editedIn) >= 0.05
    )
    if (covered.length === 0) continue
    const cutIn = covered[0].editedIn
    const cutOut = covered[covered.length - 1].editedOut
    const s = Math.max(line.start, cutIn)
    const e = Math.min(line.end, cutOut)
    out.push({ id: line.id, text: line.text, outStart: s, durationSec: e - s, cutIn, cutOut })
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

/**
 * Pull a dragged caption edge onto the nearest scene boundary within `tol`.
 *
 * The snap must not undo the MIN_CAPTION_SEC clamp: a dub line starts ON a
 * scene boundary, so dragging its right edge to the minimum put the end
 * within reach of the line's own start boundary, the snap landed it there,
 * and the zero-length line vanished from the lane and the render. A snap that
 * would leave the line shorter than the minimum is not taken.
 */
export function snapCaptionEdge(
  patch: { start: number; end: number },
  edge: TrimEdge,
  markers: number[],
  tol: number
): { start: number; end: number } {
  const snapped =
    edge === 'right'
      ? { ...patch, end: snapToMarkers(patch.end, markers, tol) }
      : { ...patch, start: snapToMarkers(patch.start, markers, tol) }
  return snapped.end - snapped.start >= MIN_CAPTION_SEC - 1e-9 ? snapped : patch
}

// ---- drag binding (window-level, shared by every trim/move handle) ---------

export type TrimEdge = 'left' | 'right'

/** Window-level trim drag — reliable even when the pointer leaves the handle.
 * `pxPerSec` is passed per-call because zoom made it state, not a constant.
 *
 * @deprecated Use `bindPointerDrag` in `lib/pointerDrag.ts` (the one shared
 * drag loop: Escape cancels, Alt re-runs a frame, edge auto-scroll) with the
 * per-frame arithmetic in the lane. Kept so existing callers still compile;
 * not deleted this round. */
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

  // One update per frame, not per pointer event. Every update re-renders the
  // whole editor, and a trackpad or a 120Hz display delivers several moves per
  // frame — the drag lagged behind the pointer (live report 2026-09-21).
  let lastX = startX
  let frame = 0
  function apply(): void {
    frame = 0
    const deltaSec = (lastX - startX) / pxPerSec
    if (edge === 'left') {
      onChange({ in: clamp(startIn + deltaSec, minIn, startOut - MIN_CUT_SEC) })
    } else {
      onChange({ out: clamp(startOut + deltaSec, startIn + MIN_CUT_SEC, maxOut) })
    }
  }

  function onMove(ev: PointerEvent): void {
    lastX = ev.clientX
    if (!frame) frame = window.requestAnimationFrame(apply)
  }

  function onUp(): void {
    // Land the last position before the edit is committed to history.
    if (frame) {
      window.cancelAnimationFrame(frame)
      apply()
    }
    onDragEnd()
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
  }

  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp)
}
