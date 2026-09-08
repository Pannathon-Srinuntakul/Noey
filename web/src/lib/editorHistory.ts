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
