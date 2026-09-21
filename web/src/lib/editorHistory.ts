import type { CaptionLine } from './captionLines'
import type { CaptionStyle } from './captionStyle'
import type { EditCut, EditorMusic } from './editorApi'

/**
 * One point in the editor's history — the WHOLE editable state.
 *
 * History used to hold `EditCut[]` alone, so typing a script line, retiming
 * a caption, changing the caption appearance or touching the music track were
 * all invisible to เลิกทำ, and an undo of a cut edit silently kept them (live
 * report 2026-08-13: "ให้มันจับทุกอย่าง").
 */
export interface EditorSnapshot {
  cuts: EditCut[]
  captionLines: CaptionLine[] | null
  captionStyle: CaptionStyle | null
  music: EditorMusic | null
}

/** Value equality, not reference: a snapshot is rebuilt on every push, so two
 * identical states are always different objects. Compared field by field
 * rather than via JSON so key order can never decide the answer. */
export function sameCaptionStyle(a: CaptionStyle | null, b: CaptionStyle | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.font === b.font &&
    a.mode === b.mode &&
    a.color === b.color &&
    a.border_color === b.border_color &&
    a.size === b.size
  )
}

export function sameMusic(a: EditorMusic | null, b: EditorMusic | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.path === b.path &&
    a.volume === b.volume &&
    a.offsetSec === b.offsetSec &&
    a.trimInSec === b.trimInSec &&
    a.trimOutSec === b.trimOutSec &&
    a.muted === b.muted
  )
}

export function sameCuts(a: EditCut[], b: EditCut[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((c, i) => {
    const o = b[i]
    return (
      c.id === o.id &&
      c.source === o.source &&
      c.in === o.in &&
      c.out === o.out &&
      c.label === o.label &&
      c.voiceoverLineId === o.voiceoverLineId &&
      c.voiceoverScript === o.voiceoverScript
    )
  })
}

export function sameCaptionLines(a: CaptionLine[] | null, b: CaptionLine[] | null): boolean {
  if (a === b) return true
  if (!a || !b) return a === b
  if (a.length !== b.length) return false
  return a.every((l, i) => {
    const o = b[i]
    return l.id === o.id && l.text === o.text && l.start === o.start && l.end === o.end
  })
}

export function sameSnapshot(a: EditorSnapshot, b: EditorSnapshot): boolean {
  return (
    sameCuts(a.cuts, b.cuts) &&
    sameCaptionLines(a.captionLines, b.captionLines) &&
    sameCaptionStyle(a.captionStyle, b.captionStyle) &&
    sameMusic(a.music, b.music)
  )
}

/** `sameSnapshot` minus the cut ids — a reopened editor numbers its cuts
 * afresh (`cut0`, `cut1`, …), so the same edit comes back under new ids. */
export function sameSnapshotIgnoringIds(a: EditorSnapshot, b: EditorSnapshot): boolean {
  if (a.cuts.length !== b.cuts.length) return false
  const renumbered = a.cuts.map((c, i) => ({ ...c, id: b.cuts[i].id }))
  return sameSnapshot({ ...a, cuts: renumbered }, b)
}

/**
 * Undo/redo history per project, kept for the browser session.
 *
 * The stacks used to live in the editor's refs, so leaving the editor and
 * coming back threw them away while the draft — the edits themselves — came
 * back ("กลับมาแล้ว มันยังไม่สามารถ undo ได้", live report 2026-09-21). The
 * editor stores its history here when it closes and takes it back when it
 * reopens on exactly the state the history ended at. Anything else — a render
 * of a different script, a shot swap, an AI re-edit, another device — changed
 * the ground under it, and replaying it would undo work the user never saw.
 */
export interface KeptHistory {
  undo: EditorSnapshot[]
  redo: EditorSnapshot[]
  /** The state the history ended at — the only state it may resume from. */
  at: EditorSnapshot
  edits: number
}

const keptHistory = new Map<string, KeptHistory>()

export function keepHistory(uid: string, history: KeptHistory): void {
  if (history.undo.length === 0 && history.redo.length === 0) keptHistory.delete(uid)
  else keptHistory.set(uid, history)
}

/** The history to resume, or null — and a stale entry is dropped either way. */
export function takeHistory(uid: string, loaded: EditorSnapshot): KeptHistory | null {
  const kept = keptHistory.get(uid)
  keptHistory.delete(uid)
  if (!kept || !sameSnapshotIgnoringIds(kept.at, loaded)) return null
  return kept
}
