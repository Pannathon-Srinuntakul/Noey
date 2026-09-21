import { useEffect, useRef, useState } from 'react'
import {
  editorClosed,
  editorOpened,
  keepHistory,
  sameSnapshot,
  takeHistory,
  type EditorSnapshot,
  type KeptHistory
} from '../../../lib/editorHistory'

export interface EditorHistoryApi {
  /** Record the state from before an edit — the caller applies the edit. */
  push: (snapshot: EditorSnapshot) => void
  /** Everything that is not a cut edit — call BEFORE applying the change. */
  pushNow: () => void
  /** Start of a continuous edit (drag, typing) — pairs with commitEdit(). */
  beginEdit: () => void
  /** End of a continuous edit: one step, and none if nothing changed. */
  commitEdit: () => void
  /** Record a continuous edit that is still open or still being committed,
   * now — the way out calls it, so typing that never lost focus is a step. */
  settleEdit: () => void
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
  /** Steps taken this session, undo and redo included — the header count. */
  editCount: number
  resume: (loaded: EditorSnapshot) => KeptHistory | null
}

/** The stacks and the rules for filling them, free of React so they can be
 * tested — the hook below owns one for the editor's life. */
export interface EditHistoryCore {
  undoStack: EditorSnapshot[]
  redoStack: EditorSnapshot[]
  push: (snapshot: EditorSnapshot) => void
  pushNow: () => void
  beginEdit: () => void
  commitEdit: () => void
  settleEdit: () => void
  /** The snapshot to put back, or null when there is nothing to undo. */
  undo: () => EditorSnapshot | null
  redo: () => EditorSnapshot | null
  /** Replace both stacks — a resumed session's history. */
  load: (undo: EditorSnapshot[], redo: EditorSnapshot[]) => void
}

export function createEditHistory(
  snapshotNow: () => EditorSnapshot,
  /** Called on every change to the stacks — a step, an undo or a redo. */
  onChange: () => void
): EditHistoryCore {
  const core: EditHistoryCore = {
    undoStack: [],
    redoStack: [],
    push,
    pushNow,
    beginEdit,
    commitEdit,
    settleEdit,
    undo,
    redo,
    load
  }
  let editSnapshot: EditorSnapshot | null = null
  /** commitEdit's deferred comparison, until its timer fires — see settleEdit. */
  let pendingCommit: { before: EditorSnapshot; timer: ReturnType<typeof setTimeout> } | null = null

  function recordStep(snapshot: EditorSnapshot): void {
    core.undoStack.push(snapshot)
    core.redoStack = []
    onChange()
  }

  function settlePendingCommit(): void {
    const pending = pendingCommit
    if (!pending) return
    pendingCommit = null
    clearTimeout(pending.timer)
    if (!sameSnapshot(pending.before, snapshotNow())) recordStep(pending.before)
  }

  /**
   * Land any continuous edit before another step touches the stacks.
   *
   * commitEdit compares a tick later, and undo, redo and every push are
   * synchronous. On a touch device a tap on เลิกทำ or ลบ runs its blur and its
   * click in one task — iOS may not blur the text box at all — so the typing's
   * step landed AFTER the undo or the delete: it cleared the redo the undo had
   * just made, and one undo then reverted both the delete and the typing (bug
   * hunt #32). A still-open edit is recorded here too, so its later blur must
   * not record it again on top of whatever this step did.
   *
   * Returns whether an edit was open: its field still has focus, and the step
   * re-opens it (reopenAfterStep) so typing that goes on in it is recorded.
   * beginEdit runs on focus only, so a field that kept focus through the undo
   * would otherwise type into an edit nobody records.
   */
  function settleForStep(): boolean {
    const reopening = cancelReopen()
    settlePendingCommit()
    const open = editSnapshot
    if (!open) return reopening
    editSnapshot = null
    if (!sameSnapshot(open, snapshotNow())) recordStep(open)
    return true
  }

  /** The way out: land everything, re-open nothing. */
  function settleEdit(): void {
    settleForStep()
  }

  /** A deferred re-open (see reopenAfterStep), until it fires. */
  let reopenTimer: ReturnType<typeof setTimeout> | null = null
  function cancelReopen(): boolean {
    if (!reopenTimer) return false
    clearTimeout(reopenTimer)
    reopenTimer = null
    return true
  }

  /** Re-open the focused field's edit on the state a step left. `after` when
   * the step knows it (undo, redo); otherwise read a tick later, once the
   * caller's own change — applied after push — has reached the mirrors. */
  function reopenAfterStep(after?: EditorSnapshot): void {
    if (after) {
      editSnapshot = after
      return
    }
    reopenTimer = setTimeout(() => {
      reopenTimer = null
      editSnapshot = snapshotNow()
    }, 0)
  }

  function push(snapshot: EditorSnapshot): void {
    const reopen = settleForStep()
    recordStep(snapshot)
    if (reopen) reopenAfterStep()
  }

  function pushNow(): void {
    const reopen = settleForStep()
    recordStep(snapshotNow())
    if (reopen) reopenAfterStep()
  }

  function beginEdit(): void {
    cancelReopen()
    editSnapshot = snapshotNow()
  }

  /** Pushes the pre-edit snapshot onto the undo stack, unless nothing
   * actually changed (focusing a text box and tabbing away must not fill the
   * history with no-ops).
   *
   * The comparison is deferred one tick on purpose: some callers apply their
   * change with a setState and call this in the SAME handler (the caption
   * timecode inputs do), so right now the mirrors still describe the pre-edit
   * state and the edit would look like a no-op. */
  function commitEdit(): void {
    // The field let go: an edit re-opened for it is over.
    cancelReopen()
    const before = editSnapshot
    editSnapshot = null
    if (!before) return
    // One deferred comparison at a time: a second would drop the first's step.
    settlePendingCommit()
    const timer = setTimeout(() => {
      if (pendingCommit?.timer !== timer) return
      pendingCommit = null
      if (!sameSnapshot(before, snapshotNow())) recordStep(before)
    }, 0)
    pendingCommit = { before, timer }
  }

  function undo(): EditorSnapshot | null {
    const reopen = settleForStep()
    const prev = core.undoStack.pop()
    if (prev) {
      core.redoStack.push(snapshotNow())
      onChange()
    }
    if (reopen) reopenAfterStep(prev ?? snapshotNow())
    return prev ?? null
  }

  function redo(): EditorSnapshot | null {
    const reopen = settleForStep()
    const next = core.redoStack.pop()
    if (next) {
      core.undoStack.push(snapshotNow())
      onChange()
    }
    if (reopen) reopenAfterStep(next ?? snapshotNow())
    return next ?? null
  }

  function load(undo: EditorSnapshot[], redo: EditorSnapshot[]): void {
    core.undoStack = undo
    core.redoStack = redo
  }

  return core
}

/**
 * Undo/redo for the timeline editor — the whole editable state (see
 * EditorSnapshot), kept for the browser session when the editor closes
 * (lib/editorHistory keepHistory/takeHistory).
 *
 * The editor owns that state, so it hands in how to read it (`snapshotNow`,
 * refs only) and how to put a snapshot back (`applySnapshot`). A step is
 * pushed by the handler that makes the edit, once — never from inside a state
 * updater, which React runs in render and twice under StrictMode.
 */
export function useEditorHistory(
  uid: string,
  snapshotNow: (overrides?: Partial<EditorSnapshot>) => EditorSnapshot,
  applySnapshot: (next: EditorSnapshot) => Promise<void>
): EditorHistoryApi {
  // Undo/redo: the core holds the stacks (no re-render needed per push),
  // historyTick forces a re-render so the toolbar buttons' disabled state
  // stays accurate. snapshotNow reads refs only, so the first render's copy
  // is current for the editor's life.
  const [, setHistoryTick] = useState(0)
  const [editCount, setEditCount] = useState(0)
  const [history] = useState(() =>
    createEditHistory(
      () => snapshotNow(),
      () => {
        setEditCount((n) => n + 1)
        setHistoryTick((t) => t + 1)
      }
    )
  )
  // History outlives the editor for the browser session (lib/editorHistory
  // keepHistory/takeHistory). Stored on unmount — but only once the editor
  // actually loaded, or a failed open would store an empty state as "current".
  const historyLoadedRef = useRef(false)
  const editCountRef = useRef(0)
  useEffect(() => {
    editCountRef.current = editCount
  }, [editCount])

  function undo() {
    const prev = history.undo()
    if (prev) void applySnapshot(prev)
  }

  function redo() {
    const next = history.redo()
    if (next) void applySnapshot(next)
  }

  /**
   * Take this project's kept history back if the editor reopened on the very
   * state it was left in (see takeHistory), and mark the history as loaded so
   * the way out hands it back. Call it only for a load that is still current:
   * a cancelled one — StrictMode's first mount — must not consume it.
   */
  function resume(loaded: EditorSnapshot): KeptHistory | null {
    const resumed = takeHistory(uid, loaded)
    history.load(resumed?.undo ?? [], resumed?.redo ?? [])
    setEditCount(resumed?.edits ?? 0)
    setHistoryTick((n) => n + 1)
    historyLoadedRef.current = true
    return resumed
  }

  // Hand this session's history back on the way out (see resume above).
  useEffect(() => {
    editorOpened(uid)
    return () => {
      if (historyLoadedRef.current) {
        // A step still being committed belongs in what is kept.
        history.settleEdit()
        keepHistory(uid, {
          undo: history.undoStack,
          redo: history.redoStack,
          at: snapshotNow(),
          edits: editCountRef.current
        })
      }
      // After keepHistory: whoever waits for the close reads what was kept.
      editorClosed(uid)
    }
    // snapshotNow reads refs only, so the first render's copy is current here.
  }, [uid])

  return {
    push: history.push,
    pushNow: history.pushNow,
    beginEdit: history.beginEdit,
    commitEdit: history.commitEdit,
    settleEdit: history.settleEdit,
    undo,
    redo,
    // Read in render, as the toolbar always did: every change to the stacks
    // bumps historyTick, which re-renders the editor.
    canUndo: history.undoStack.length > 0,
    canRedo: history.redoStack.length > 0,
    editCount,
    resume
  }
}
