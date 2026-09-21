/**
 * Caption lines that follow the cut.
 *
 * Captions used to be derived ONCE, when the editor opened, and every save
 * stored the whole list. Nothing re-timed them afterwards, so deleting a scene,
 * trimming one, reordering or retyping a voiceover line left every caption at
 * its old output time with its old text — and the stored list then beat the
 * correct derivation on every later render, in the burn-in, the SRT and the
 * CapCut bundle alike.
 *
 * Now the derived lines are never stored: every render, and the editor on
 * every cut change, derives them from the cut as it is (transcript words for
 * the speech modes, scenes + script for dub). Only lines the user EDITED are
 * stored, each with an anchor in the SOURCE footage, and they are laid over
 * the derived set: re-timed through their anchor so they follow their scene,
 * dropped with it when it is deleted, and hiding the derived line they
 * replace. A deleted line is stored the same way (`deleted`), so the derived
 * line under it stays gone.
 */

import {
  groupWordsIntoLines,
  type CaptionLine,
  type CaptionSourcePiece,
  type CaptionWord
} from './captionLines'
import { clipAbsOffsets, remapWordsToOutput, type TimedWord } from './timelineMath'
import type { EditCut } from './editorApi'

/** What an anchor is resolved against — a cut, in output order. */
export interface AnchorCut {
  source?: string
  in: number
  out: number
}

const EPS = 0.001
/** A derived line left shorter than this by an edit over it is dropped. */
const MIN_DERIVED_SEC = 0.1

const r3 = (n: number): number => Math.round(n * 1000) / 1000

interface Laid {
  source: string
  in: number
  out: number
  outIn: number
  outOut: number
}

function layout(cuts: AnchorCut[]): Laid[] {
  let acc = 0
  const out: Laid[] = []
  for (const c of cuts) {
    const dur = Math.max(0, Number(c.out) - Number(c.in))
    out.push({
      source: String(c.source ?? 'clip0'),
      in: Number(c.in),
      out: Number(c.out),
      outIn: acc,
      outOut: acc + dur
    })
    acc += dur
  }
  return out
}

/** Only well-formed edited lines count. A full list older builds stored on
 * every save and every render carries no edit marks and is filtered out here —
 * callers that can derive the cut's lines go through storedCaptionEdits, which
 * rescues the hand-fixed text in such a list instead of dropping it. */
export function captionEditsOf(stored: unknown): CaptionLine[] {
  if (!Array.isArray(stored)) return []
  return (stored as CaptionLine[]).filter(
    (l) =>
      !!l &&
      l.edited === true &&
      Array.isArray(l.anchor) &&
      l.anchor.length > 0 &&
      typeof l.id === 'string'
  )
}

/**
 * The source footage under an output-clock span: one piece per cut the span
 * overlaps, in output order. Undefined when the span covers no footage.
 */
export function anchorForOutputSpan(
  cuts: AnchorCut[],
  start: number,
  end: number
): CaptionSourcePiece[] | undefined {
  const pieces: CaptionSourcePiece[] = []
  for (const seg of layout(cuts)) {
    const s = Math.max(start, seg.outIn)
    const e = Math.min(end, seg.outOut)
    if (e - s <= EPS) continue
    pieces.push({
      source: seg.source,
      in: r3(seg.in + (s - seg.outIn)),
      out: r3(seg.in + (e - seg.outIn))
    })
  }
  return pieces.length > 0 ? pieces : undefined
}

/** A list stored by a build from before edit marks: lines, none of them
 * marked or anchored. */
function isLegacyCaptionList(stored: unknown): stored is CaptionLine[] {
  return (
    Array.isArray(stored) &&
    stored.length > 0 &&
    stored.every(
      (l) =>
        !!l &&
        typeof l === 'object' &&
        (l as CaptionLine).edited === undefined &&
        (l as CaptionLine).anchor === undefined
    )
  )
}

const squash = (s: string): string => s.replace(/\s+/g, '')

/**
 * The caption edits a project's stored list stands for, on the cut it was
 * stored with (`derived` = that cut's derivation, `cuts` = that cut).
 *
 * Older builds stored the WHOLE list on every save, hand-fixed text included,
 * and marked nothing — so dropping unmarked lists threw away every typo fix a
 * user had made (and the first save then wrote `[]` over them). Such a list is
 * converted instead: a line whose text appears nowhere in what the derivation
 * says now is a hand fix, and becomes an edit anchored where it sat. A line
 * whose text the derivation still says — at any time — is not kept: its
 * timing is the stale copy this module exists to stop burning, not a choice.
 * (A fix that only removed words reads as unchanged and is lost; there is no
 * telling it apart from a stale fragment.)
 *
 * Ids are fixed per position, so converting the same list twice gives the
 * same edits; once the editor saves them they carry edit marks and this never
 * runs for that project again.
 */
export function storedCaptionEdits(
  stored: unknown,
  derived: CaptionLine[],
  cuts: AnchorCut[]
): CaptionLine[] {
  if (!isLegacyCaptionList(stored)) return captionEditsOf(stored)
  const said = squash(derived.map((d) => d.text).join(''))
  const edits: CaptionLine[] = []
  stored.forEach((l, i) => {
    const text = typeof l.text === 'string' ? l.text.trim() : ''
    const start = Number(l.start)
    const end = Number(l.end)
    if (!text || !Number.isFinite(start) || !(end - start > 0.01)) return
    if (said.includes(squash(text))) return
    const anchor = anchorForOutputSpan(cuts, start, end)
    if (!anchor) return
    edits.push({ id: `legacy${i}`, text, start: r3(start), end: r3(end), edited: true, anchor })
  })
  return edits
}

/**
 * An edited line re-timed onto `cuts` through its source anchor, or null when
 * none of its footage is in the cut any more.
 *
 * The line starts where its first surviving piece lands. Later pieces extend
 * it only while they continue it on screen — the next piece in the SAME
 * scene, or at the very start of the scene that plays next — so a line whose
 * two halves were reordered apart keeps its first half rather than
 * stretching over whatever now sits between them.
 */
export function rebaseCaptionEdit(edit: CaptionLine, cuts: AnchorCut[]): CaptionLine | null {
  const laid = layout(cuts)
  let start: number | null = null
  let end = 0
  let segIdx = -1
  const overlapIn = (p: CaptionSourcePiece, seg: Laid): [number, number] | null => {
    if (seg.source !== p.source) return null
    const s = Math.max(p.in, seg.in)
    const e = Math.min(p.out, seg.out)
    return e - s > EPS ? [s, e] : null
  }
  for (const piece of edit.anchor ?? []) {
    if (start === null) {
      const i = laid.findIndex((seg) => overlapIn(piece, seg) !== null)
      if (i < 0) continue // this piece was cut out; the next may survive
      const [s, e] = overlapIn(piece, laid[i])!
      start = laid[i].outIn + (s - laid[i].in)
      end = laid[i].outIn + (e - laid[i].in)
      segIdx = i
      continue
    }
    const same = overlapIn(piece, laid[segIdx])
    if (same) {
      end = Math.max(end, laid[segIdx].outIn + (same[1] - laid[segIdx].in))
      continue
    }
    // Continue into the next scene only from the current one's very end, and
    // only if the piece starts that scene.
    const cur = laid[segIdx]
    if (end < cur.outOut - 0.01) break
    const next = laid[segIdx + 1]
    const ov = next ? overlapIn(piece, next) : null
    if (!next || !ov || ov[0] > next.in + 0.01) break
    end = next.outIn + (ov[1] - next.in)
    segIdx += 1
  }
  if (start === null || end - start < 0.01) return null
  return { ...edit, start: r3(start), end: r3(end) }
}

/**
 * The lines to show and burn: `derived` (from the cut as it is now) with the
 * user's edits laid over it.
 *
 * An edit hides every derived line it mostly covers (more than half of the
 * shorter of the two) and pushes the edge of one it only grazes out of its
 * way, so two captions never share the screen. Deleted edits hide lines the
 * same way and are never returned themselves.
 */
export function resolveCaptionLines(
  derived: CaptionLine[],
  edits: CaptionLine[],
  cuts: AnchorCut[]
): CaptionLine[] {
  const rebased = captionEditsOf(edits)
    .map((e) => rebaseCaptionEdit(e, cuts))
    .filter((e): e is CaptionLine => e !== null)
  const kept: CaptionLine[] = []
  for (const line of derived) {
    let { start, end } = line
    let hidden = false
    for (const ed of rebased) {
      const ov = Math.min(end, ed.end) - Math.max(start, ed.start)
      if (ov <= EPS) continue
      if (ov > 0.5 * Math.min(end - start, ed.end - ed.start)) {
        hidden = true
        break
      }
      if (ed.start > start) end = Math.min(end, ed.start)
      else start = Math.max(start, ed.end)
    }
    if (hidden || end - start < MIN_DERIVED_SEC) continue
    // Derived ids are positional and regenerated on every cut change; the
    // prefix keeps them from ever naming an edit.
    kept.push({ id: line.id, text: line.text, start: r3(start), end: r3(end) })
  }
  return [...kept, ...rebased.filter((e) => !e.deleted)].sort((a, b) => a.start - b.start)
}

/** Strip the editor-only fields — what a render job is handed. */
export function plainCaptionLines(lines: CaptionLine[]): CaptionLine[] {
  return lines.map((l) => ({ id: l.id, text: l.text, start: l.start, end: l.end }))
}

/**
 * The speech modes' derived lines: the transcript's SOURCE-clock words lifted
 * onto the output clock through `cuts`, then grouped. The one derivation the
 * editor, the render and the effects script share.
 */
export function wordCaptionLines(
  words: CaptionWord[] | TimedWord[] | undefined,
  cuts: AnchorCut[],
  clipDurationsSec: number[]
): CaptionLine[] {
  if (!words?.length) return []
  const editCuts = cuts.map((c, i) => ({
    id: `c${i}`,
    source: String(c.source ?? 'clip0'),
    in: Number(c.in),
    out: Number(c.out),
    label: ''
  })) as EditCut[]
  return groupWordsIntoLines(remapWordsToOutput(words, editCuts, clipAbsOffsets(clipDurationsSec)))
}

// ── editor operations ────────────────────────────────────────────────────────

/**
 * Apply an editor change to `shown` (a line currently on screen) and return
 * the new edit list plus the id the line now goes by — a derived line becomes
 * an edit with a fresh id the first time it is touched, and a drag in
 * progress has to keep addressing it.
 *
 * A retime re-anchors the line where it now sits; a text-only change keeps
 * the anchor, so the line still follows its scene.
 */
export function applyCaptionEdit(
  edits: CaptionLine[],
  shown: CaptionLine,
  patch: Partial<Pick<CaptionLine, 'text' | 'start' | 'end'>>,
  cuts: AnchorCut[],
  newId: () => string
): { edits: CaptionLine[]; id: string } {
  const merged = { ...shown, ...patch }
  const retimed = patch.start !== undefined || patch.end !== undefined
  const existing = edits.find((e) => e.id === shown.id)
  if (existing) {
    const anchor = retimed
      ? (anchorForOutputSpan(cuts, merged.start, merged.end) ?? existing.anchor)
      : existing.anchor
    const next: CaptionLine = {
      ...existing,
      text: merged.text,
      start: merged.start,
      end: merged.end,
      anchor
    }
    return { edits: edits.map((e) => (e.id === shown.id ? next : e)), id: shown.id }
  }
  const anchor = anchorForOutputSpan(cuts, merged.start, merged.end)
  if (!anchor) return { edits, id: shown.id }
  const id = newId()
  return {
    edits: [
      ...edits,
      { id, text: merged.text, start: merged.start, end: merged.end, edited: true, anchor }
    ],
    id
  }
}

/** Remove `shown` for good: an edit becomes a tombstone, a derived line gets
 * one, so the derivation cannot bring it back. */
export function deleteCaptionEdit(
  edits: CaptionLine[],
  shown: CaptionLine,
  cuts: AnchorCut[],
  newId: () => string
): CaptionLine[] {
  const existing = edits.find((e) => e.id === shown.id)
  if (existing) {
    return edits.map((e) => (e.id === shown.id ? { ...existing, text: '', deleted: true } : e))
  }
  const anchor = anchorForOutputSpan(cuts, shown.start, shown.end)
  if (!anchor) return edits
  return [
    ...edits,
    {
      id: newId(),
      text: '',
      start: shown.start,
      end: shown.end,
      edited: true,
      deleted: true,
      anchor
    }
  ]
}

/** A fresh id for an edit. Stored with the project and compared across
 * sessions, so it must not be positional like a derived line's `capN`. */
export function newCaptionEditId(): string {
  return `ed${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
}

/**
 * Everything a speech-mode timeline burns: its transcript's lines on its own
 * cuts, with its stored edits laid over. The render, the SRT, the CapCut
 * bundle, the detail page's transcript panel and the effects script all read
 * this, so none of them can describe a different cut from the video.
 */
export function timelineCaptionLines(
  timeline: Record<string, unknown> | null | undefined,
  clipDurationsSec: number[]
): CaptionLine[] {
  if (!timeline) return []
  const raw = Array.isArray(timeline.timeline) ? (timeline.timeline as AnchorCut[]) : []
  const cuts = raw.filter((c) => ((c as { type?: string }).type ?? 'cut') === 'cut')
  const derived = wordCaptionLines(
    timeline.words as TimedWord[] | undefined,
    cuts,
    clipDurationsSec
  )
  return resolveCaptionLines(
    derived,
    storedCaptionEdits(timeline.captionLines, derived, cuts),
    cuts
  )
}
