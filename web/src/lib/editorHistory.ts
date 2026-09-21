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
  /** The caption EDITS (captionEdits.ts), not the lines on screen — those are
   * derived from `cuts`, so restoring the cuts restores them. */
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
    // `deleted` too: removing an edited line keeps its id and only flips this.
    return (
      l.id === o.id &&
      l.text === o.text &&
      l.start === o.start &&
      l.end === o.end &&
      !!l.deleted === !!o.deleted
    )
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

/**
 * Every music file a kept history can still restore — its end state and both
 * stacks. A replaced track must outlive the editor for as long as one of
 * these names it: pruning it left a reopened editor's เลิกทำ pointing at a
 * deleted file (bug hunt #24).
 */
export function keptMusicPaths(uid: string): string[] {
  const kept = keptHistory.get(uid)
  if (!kept) return []
  const paths = new Set<string>()
  for (const snapshot of [kept.at, ...kept.undo, ...kept.redo]) {
    if (snapshot.music?.path) paths.add(snapshot.music.path)
  }
  return [...paths]
}

/**
 * Editors open right now, by project. The editor hands its history in on its
 * way OUT (unmount), which runs after whatever closed it — so a cleanup that
 * must see that history (useProjectPipeline pruning replaced music) waits for
 * the close here, and can tell an editor reopened meanwhile from one gone.
 */
const openEditors = new Map<string, { closed: Promise<void>; done: () => void }>()

export function editorOpened(uid: string): void {
  let done: () => void = () => undefined
  const closed = new Promise<void>((resolve) => {
    done = resolve
  })
  openEditors.get(uid)?.done()
  openEditors.set(uid, { closed, done })
}

export function editorClosed(uid: string): void {
  const open = openEditors.get(uid)
  openEditors.delete(uid)
  open?.done()
}

export function isEditorOpen(uid: string): boolean {
  return openEditors.has(uid)
}

/** Resolves once no editor is open on `uid` (at once if none is). */
export function whenEditorClosed(uid: string): Promise<void> {
  return openEditors.get(uid)?.closed ?? Promise.resolve()
}

/**
 * The largest N among the `new<N>` cut ids anywhere in a kept history — the
 * state it ended at and both stacks — or 0.
 *
 * The editor names the cuts it creates `new1`, `new2`, … from a counter that
 * started at 0 on every open, while a resumed history keeps its own ids. So
 * the first cut created after reopening could be a second `new1`, and every
 * edit addressed by id (a trim, a delete) then hit both cuts. The counter
 * resumes from here instead.
 */
export function highestNewCutNumber(kept: KeptHistory): number {
  let highest = 0
  for (const snapshot of [kept.at, ...kept.undo, ...kept.redo]) {
    for (const c of snapshot.cuts) {
      const m = /^new(\d+)$/.exec(c.id)
      if (m) highest = Math.max(highest, Number(m[1]))
    }
  }
  return highest
}
