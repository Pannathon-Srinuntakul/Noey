/**
 * R18b ปรับช็อต — pure swap logic, shared by ShotSwapModal and the pipeline.
 *
 * The AI returned backup shots (`alternates`, ≤3 per segment) inside its one
 * analysis answer; everything here is arithmetic over that stored data. No
 * function in this module may talk to the network or the LLM — the whole
 * point of the feature is that a swap costs zero model calls.
 */

import type { DubEditScript, DubTimeline } from './videosLocalApi'

/** One backup shot as validated by the backend (sanitize_segment_alternates). */
export interface ShotAlternate {
  sourceClip: string
  sourceIn: number
  sourceOut: number
  matchedFrameTime: number
  note: string
}

/** A source window a segment can be pointed at — the current main shot, one of
 * its alternates, or the pre-swap original kept in `swappedFrom`. */
export interface ShotWindow {
  sourceClip: string
  sourceIn: number
  sourceOut: number
  matchedFrameTime: number
}

/**
 * Length regimes (HANDOFF-R18b §3):
 * - `free` — highlight mode (never any voiceover) and dub_first BEFORE the
 *   voiceover is recorded: the swap adopts the alternate's natural window and
 *   the total length moves with it.
 * - `locked` — dub_first with a recorded voiceover: durationSec IS the spoken
 *   time of that line, so the alternate is trimmed to the original length,
 *   anchored on its matchedFrameTime.
 */
export type SwapRegime = 'free' | 'locked'

export function swapRegimeFor(
  mode: string | undefined,
  voiceoverPath: string | undefined
): SwapRegime {
  return mode === 'dub_first' && voiceoverPath ? 'locked' : 'free'
}

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Parse a segment's alternates defensively — old projects have no field. */
export function segmentAlternates(seg: Record<string, unknown>): ShotAlternate[] {
  const raw = seg.alternates
  if (!Array.isArray(raw)) return []
  return raw
    .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
    .map((a) => ({
      sourceClip: String(a.sourceClip ?? ''),
      sourceIn: num(a.sourceIn),
      sourceOut: num(a.sourceOut),
      matchedFrameTime: num(a.matchedFrameTime ?? a.sourceIn),
      note: String(a.note ?? '').trim()
    }))
    .filter((a) => a.sourceClip && a.sourceOut > a.sourceIn)
    .slice(0, 3)
}

/** How many shots actually pose a question. This is the number the entry
 * button shows and the length of the review queue — a 9-shot cut with 3
 * alternatives is 3 questions, not 9. Zero means there is nothing to decide. */
export function countShotsWithAlternates(script: DubEditScript | null): number {
  return (script?.segments ?? []).filter((s) => segmentAlternates(s).length > 0).length
}

/** The pre-swap original kept on a swapped segment, offered back in the tray
 * as "ตัวเดิมของ AI" so a swap is always reversible. */
export function segmentSwappedFrom(seg: Record<string, unknown>): ShotWindow | null {
  const raw = seg.swappedFrom
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  const win: ShotWindow = {
    sourceClip: String(s.sourceClip ?? seg.sourceClip ?? ''),
    sourceIn: num(s.sourceIn),
    sourceOut: num(s.sourceOut),
    matchedFrameTime: num(s.matchedFrameTime ?? s.sourceIn)
  }
  return win.sourceOut > win.sourceIn ? win : null
}

export function segmentWindow(seg: Record<string, unknown>): ShotWindow {
  return {
    sourceClip: String(seg.sourceClip ?? 'clip0'),
    sourceIn: num(seg.sourceIn),
    sourceOut: num(seg.sourceOut),
    matchedFrameTime: num(seg.matchedFrameTime ?? seg.sourceIn)
  }
}

export function sameWindow(a: ShotWindow, b: ShotWindow): boolean {
  return (
    a.sourceClip === b.sourceClip &&
    Math.abs(a.sourceIn - b.sourceIn) < 0.011 &&
    Math.abs(a.sourceOut - b.sourceOut) < 0.011
  )
}

/** Locked regime: can this window carry the segment's original duration? */
export function windowFitsLocked(win: ShotWindow, durationSec: number): boolean {
  return win.sourceOut - win.sourceIn + 1e-6 >= durationSec
}

const round2 = (n: number): number => Math.round(n * 100) / 100

/**
 * Point one segment at a new window (HANDOFF-R18b §3).
 *
 * free   → adopt the window whole; durationSec follows it.
 * locked → trim to the ORIGINAL durationSec anchored on matchedFrameTime:
 *          newIn = clamp(mft − 0.2, in, out − durationSec); newOut = newIn + dur.
 * Both keep the replaced window in `swappedFrom` for the revert path and the
 * taste log. Returns null when a locked swap cannot fit (callers disable those
 * cards, so this is a belt-and-braces guard, not a UI path).
 */
export function swapSegment(
  seg: Record<string, unknown>,
  win: ShotWindow,
  regime: SwapRegime
): Record<string, unknown> | null {
  const current = segmentWindow(seg)
  const duration = num(seg.durationSec) || round2(current.sourceOut - current.sourceIn)
  let sourceIn: number
  let sourceOut: number
  let durationSec: number
  if (regime === 'locked') {
    if (!windowFitsLocked(win, duration)) return null
    const lo = win.sourceIn
    const hi = win.sourceOut - duration
    sourceIn = round2(Math.min(Math.max(win.matchedFrameTime - 0.2, lo), hi))
    sourceOut = round2(sourceIn + duration)
    durationSec = duration
  } else {
    sourceIn = round2(win.sourceIn)
    sourceOut = round2(win.sourceOut)
    durationSec = round2(win.sourceOut - win.sourceIn)
  }
  return {
    ...seg,
    sourceClip: win.sourceClip,
    sourceIn,
    sourceOut,
    matchedFrameTime: round2(win.matchedFrameTime),
    durationSec,
    swappedFrom: {
      sourceClip: current.sourceClip,
      sourceIn: current.sourceIn,
      sourceOut: current.sourceOut,
      matchedFrameTime: current.matchedFrameTime,
      durationSec: duration
    }
  }
}

/** One chosen swap: which segment (by index in `segments`) gets which window. */
export interface SwapChoice {
  segIndex: number
  window: ShotWindow
}

/** What one committed swap looks like in the taste log (HANDOFF-R18b §7). */
export interface ShotSwapLogEntry {
  line: number
  from: { frame: number; desc: string }
  to: { frame: number; note: string }
}

/**
 * Apply the chosen swaps to a script — pure; the input is never mutated.
 * Recomputes totalEstimatedSec the same way the editor's save path does.
 * Locked swaps that cannot fit are skipped (see swapSegment).
 */
export function applySwapsToScript(
  script: DubEditScript,
  choices: SwapChoice[],
  regime: SwapRegime
): { script: DubEditScript; applied: SwapChoice[] } {
  const segments = script.segments.map((s) => ({ ...s }))
  const applied: SwapChoice[] = []
  for (const choice of choices) {
    const seg = segments[choice.segIndex]
    if (!seg) continue
    if (sameWindow(segmentWindow(seg), choice.window)) continue
    const swapped = swapSegment(seg, choice.window, regime)
    if (!swapped) continue
    segments[choice.segIndex] = swapped
    applied.push(choice)
  }
  const total = segments.reduce((acc, s) => {
    const d = num(s.durationSec) || Math.max(0, num(s.sourceOut) - num(s.sourceIn))
    return acc + d
  }, 0)
  return {
    script: { ...script, segments, totalEstimatedSec: Math.round(total * 10) / 10 },
    applied
  }
}

/** Sum of segment durations — the bar's "รวม 42 → 42.5 วิ" figures. */
export function scriptTotalSec(script: DubEditScript | null): number {
  return (script?.segments ?? []).reduce((acc, s) => {
    const d = num(s.durationSec) || Math.max(0, num(s.sourceOut) - num(s.sourceIn))
    return acc + d
  }, 0)
}

/**
 * Locked-regime timeline patch: the planned timeline maps cut i to segment i
 * (see lib/dubScenes timelineScenesFor), and the locked rule kept every
 * durationSec identical — so a swap only has to re-point the affected cuts at
 * the new source window, keeping each cut's own (VO-scaled) length. Zero AI:
 * this is why the length is locked in the first place.
 *
 * A cut whose old window doesn't contain the mapped old segment (the planner
 * dropped a short cut and shifted the tail) is left untouched rather than
 * guessed at.
 */
export function retimeTimelineForSwap(
  oldSegments: Record<string, unknown>[],
  newSegments: Record<string, unknown>[],
  timeline: DubTimeline
): DubTimeline {
  const cuts = (timeline.timeline ?? []).map((c) => ({ ...c }))
  cuts.forEach((cut, i) => {
    if ((cut.type ?? 'cut') !== 'cut') return
    const oldSeg = oldSegments[i]
    const newSeg = newSegments[i]
    if (!oldSeg || !newSeg) return
    const before = segmentWindow(oldSeg)
    const after = segmentWindow(newSeg)
    if (sameWindow(before, after)) return
    // Sanity: the cut must belong to the old segment's window.
    if (
      String(cut.source) !== before.sourceClip ||
      Number(cut.in) < before.sourceIn - 0.05 ||
      Number(cut.out) > before.sourceOut + 0.05
    ) {
      return
    }
    const len = Math.max(0, Number(cut.out) - Number(cut.in))
    const lo = after.sourceIn
    const hi = Math.max(lo, after.sourceOut - len)
    const newIn = round2(Math.min(Math.max(after.matchedFrameTime - 0.2, lo), hi))
    cut.source = after.sourceClip
    cut.in = newIn
    cut.out = round2(Math.min(newIn + len, after.sourceOut))
  })
  return { ...timeline, timeline: cuts as DubTimeline['timeline'] }
}
