/**
 * What a drag can snap TO — the target lists the editor hands the lanes, the
 * music block, the markers and the scrub through its SnapContext.
 *
 * Pure: the editor builds these from its refs on every drag frame (drags
 * outlive renders, so the memoized arrays are mirrored into refs first). The
 * snapping itself — nearest target, tolerance, clamp — lives in
 * lib/timelineSnap.ts; this file only says WHERE the edges are.
 *
 * The output clock has more than scene edges on it: the voiceover lines
 * (the owner's explicit ask — a cut that lands a hair off a line reads as a
 * mistake in the finished clip), the caption chips, the music block, its
 * beats, the markers, the I/O range and the playhead itself. The source clock
 * has that file's other scenes, and the playhead only when it is on that file
 * (its time means nothing on another file's lane).
 */
import type { SnapTarget } from '../../lib/timelineSnap'
import { computeEditedSegments, type EditCut } from '../../lib/timelineMath'

/** The music fields a snap target needs — a subset of EditorMusic. */
export interface SnapMusic {
  offsetSec: number
  trimInSec: number
  trimOutSec: number | null
}

export interface OutputTargetsInput {
  cuts: EditCut[]
  /** voiceoverLineBlocks(cuts) — each block's start and end on the output clock. */
  voBlocks: readonly { outStart: number; durationSec: number }[]
  /** captionChipSpans(...) — each chip's start and end on the output clock. */
  capSpans: readonly { outStart: number; durationSec: number }[]
  music: SnapMusic | null
  /** The decoded track length — the block's end when trimOutSec is unset. */
  musicDurationSec?: number
  /** Beat times in the music FILE; mapped to the output clock like
   * snapCandidateToBeat did (b − trimInSec + offsetSec). */
  beats: readonly number[] | null
  markers: readonly { id: string; sec: number }[]
  range: { inSec: number; outSec: number } | null
  playheadSec: number
  editedDur: number
  /** The cut being dragged: its own two boundaries are not targets. */
  excludeCutId?: string
}

/** Every edge on the OUTPUT clock a drag may land on, in priority order for
 * ties (nearestTarget keeps the earlier of two equidistant targets). */
export function buildOutputTargets(input: OutputTargetsInput): SnapTarget[] {
  const out: SnapTarget[] = [{ sec: 0, kind: 'start' }]
  const segs = computeEditedSegments(input.cuts)
  // The excluded cut's own edges, so a trim never snaps to the boundary it is
  // moving — nor to its own start, which is pinned by the cuts before it.
  const own = input.excludeCutId ? segs.find((s) => s.cut.id === input.excludeCutId) : undefined
  const ownEdges = own ? [own.editedIn, own.editedOut] : []
  const isOwnEdge = (sec: number): boolean => ownEdges.some((e) => Math.abs(e - sec) < 1e-6)
  for (const seg of segs) {
    if (isOwnEdge(seg.editedOut)) continue
    out.push({ sec: seg.editedOut, kind: 'cut', ownerId: seg.cut.id })
  }
  for (const b of input.voBlocks) {
    out.push({ sec: b.outStart, kind: 'voiceover' })
    out.push({ sec: b.outStart + b.durationSec, kind: 'voiceover' })
  }
  for (const c of input.capSpans) {
    out.push({ sec: c.outStart, kind: 'caption' })
    out.push({ sec: c.outStart + c.durationSec, kind: 'caption' })
  }
  const m = input.music
  if (m) {
    const trimOut = m.trimOutSec ?? input.musicDurationSec ?? m.trimInSec
    out.push({ sec: m.offsetSec, kind: 'music' })
    const blockDur = Math.max(trimOut - m.trimInSec, 0)
    if (blockDur > 0) out.push({ sec: m.offsetSec + blockDur, kind: 'music' })
    if (input.beats && input.beats.length > 0) {
      for (const sec of beatsOnOutputClock(input.beats, m.trimInSec, m.offsetSec)) {
        out.push({ sec, kind: 'beat' })
      }
    }
  }
  for (const mk of input.markers) out.push({ sec: mk.sec, kind: 'marker', ownerId: mk.id })
  if (input.range) {
    out.push({ sec: input.range.inSec, kind: 'range' })
    out.push({ sec: input.range.outSec, kind: 'range' })
  }
  out.push({ sec: input.playheadSec, kind: 'playhead' })
  out.push({ sec: input.editedDur, kind: 'end' })
  return out.filter((t) => Number.isFinite(t.sec) && t.sec >= 0)
}

/** The beats as output-clock seconds — exactly the mapping the old
 * snapCandidateToBeat made (a beat before the track's trim-in plays nowhere). */
export function beatsOnOutputClock(
  beats: readonly number[],
  trimInSec: number,
  offsetSec: number
): number[] {
  const out: number[] = []
  for (const b of beats) {
    const sec = b - trimInSec + offsetSec
    if (sec >= 0) out.push(sec)
  }
  return out
}

export interface SourceTargetsInput {
  cuts: EditCut[]
  /** The lane being dragged on. */
  sourceId: string
  laneDurationSec: number
  playheadSec: number
  /** The file the preview has loaded — the playhead is on ITS clock. */
  previewSource: string | null
  excludeCutId?: string
}

/** Every edge on one source lane's clock: the file's start and end, the other
 * scenes' in/out points on that file, and the playhead when it is on that file. */
export function buildSourceTargets(input: SourceTargetsInput): SnapTarget[] {
  const out: SnapTarget[] = [{ sec: 0, kind: 'start' }]
  for (const c of input.cuts) {
    if (c.source !== input.sourceId || c.id === input.excludeCutId) continue
    out.push({ sec: c.in, kind: 'cut', ownerId: c.id })
    out.push({ sec: c.out, kind: 'cut', ownerId: c.id })
  }
  if (input.previewSource === input.sourceId) {
    out.push({ sec: input.playheadSec, kind: 'playhead' })
  }
  out.push({ sec: input.laneDurationSec, kind: 'end' })
  return out.filter((t) => Number.isFinite(t.sec) && t.sec >= 0)
}
