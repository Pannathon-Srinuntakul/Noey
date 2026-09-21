import { useEffect, useRef, useState, type RefObject } from 'react'
import { editorApi, type CaptionLine } from '../../../lib/editorApi'
import { useUnsavedGuard } from '../../../lib/unsavedGuard'
import { useStableCallback } from '../../../lib/useStableCallback'
import { cutPayload } from '../cutPayload'
import type { WorkingCut } from '../types'

export interface DraftAutosaveApi {
  /** Write whatever is not on disk yet — the way out calls it. */
  saveDraftNow: () => Promise<void>
  /** When the last draft write landed (HH:MM), or null before the first. */
  draftSavedAt: string | null
}

/**
 * The editor's draft: written shortly after every edit, flushed on the way
 * out, and guarded while a write is still in flight when the tab or app
 * closes. The write reads the cuts and caption lines from their refs, so it
 * saves the newest state rather than the one the timer was set in.
 */
export function useDraftAutosave({
  editorPhase,
  saving,
  editCount,
  cuts,
  captionLines,
  isDub,
  cutsRef,
  captionLinesRef
}: {
  editorPhase: 'loading' | 'preparing' | 'ready'
  saving: boolean
  editCount: number
  cuts: WorkingCut[]
  captionLines: CaptionLine[] | null
  isDub: boolean
  cutsRef: RefObject<WorkingCut[]>
  captionLinesRef: RefObject<CaptionLine[] | null>
}): DraftAutosaveApi {
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null)
  /** Edits made since the last draft write. Refs, not state: the flush on the
   * way out runs from an event handler and must see the newest values. */
  const draftDirtyRef = useRef(false)
  const draftSavingRef = useRef<Promise<void> | null>(null)
  /** Mirrors "a draft is not on disk yet" for the one warning that still makes
   * sense: closing the whole tab/app mid-write. */
  const [draftPending, setDraftPending] = useState(false)

  /**
   * Write the draft NOW (used by the debounce and by the way out).
   *
   * Leaving the editor within the debounce window used to drop the last edit
   * on the floor: the timer was cleared by the unmount and nothing else wrote
   * it. Everything else about closing is a warning; this is the part that
   * actually preserves the work.
   */
  async function saveDraftNow(): Promise<void> {
    // A save already in flight cannot contain edits made after it started, so
    // returning it as "done" let the way-out flush report success while the
    // newest edits were still only in memory — then the editor unmounted.
    // Chain behind it and write again instead.
    if (draftSavingRef.current) {
      await draftSavingRef.current.catch(() => undefined)
      return saveDraftNow()
    }
    if (!draftDirtyRef.current) return
    if (editorPhase !== 'ready' || cutsRef.current.length === 0) return
    draftDirtyRef.current = false
    const run = editorApi
      .saveDraft(cutPayload(cutsRef.current, isDub), captionLinesRef.current ?? undefined)
      .then(() =>
        setDraftSavedAt(
          new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
        )
      )
      .catch(() => {
        // Keep it pending so the next tick (or the way out) tries again.
        draftDirtyRef.current = true
      })
      .finally(() => {
        draftSavingRef.current = null
        setDraftPending(draftDirtyRef.current)
      })
    draftSavingRef.current = run
    return run
  }

  // Draft autosave (R3 header). Debounced, and never while a render save is
  // in flight — the two write the same document.
  const draftFirstRef = useRef(true)
  // What the editor opened on. A change from it is an edit even before the
  // history counts one: typing records its undo step only when the box loses
  // focus, so a sentence typed as the session's first edit was never marked
  // dirty — Esc, a reload or closing the tab lost it without a word (bug hunt
  // #10). Compared by identity: every edit writes a new list.
  const openedOnRef = useRef<{ cuts: WorkingCut[]; captionLines: CaptionLine[] | null } | null>(
    null
  )
  useEffect(() => {
    if (draftFirstRef.current) {
      draftFirstRef.current = false
      return
    }
    if (editorPhase === 'ready' && !openedOnRef.current)
      openedOnRef.current = { cuts, captionLines }
    const opened = openedOnRef.current
    const unchanged =
      editCount === 0 && opened?.cuts === cuts && opened?.captionLines === captionLines
    if (saving || editorPhase !== 'ready' || cuts.length === 0 || unchanged) return
    draftDirtyRef.current = true
    setDraftPending(true)
    // Short: the draft is written on this device first (the server copy
    // follows in the background), so it is cheap — and until it lands, a
    // reload still has to ask. 2s left that prompt up for too long.
    const t = setTimeout(() => void saveDraftNow(), 800)
    return () => clearTimeout(t)
  }, [cuts, captionLines, saving, editorPhase, isDub, editCount])

  /**
   * Only one thing can still be lost: a draft write that has not finished when
   * the whole tab or app closes. Leaving the editor loses nothing — the draft
   * is written continuously and the editor reopens on it — so leaving no
   * longer asks. It used to warn "ยังไม่ได้บันทึก" on every exit after an edit,
   * while the edits it warned about were already saved (live report
   * 2026-09-21). "Not rendered yet" is now said on the project page instead
   * (LocalProject.needsRender), where the old clip actually plays.
   */
  const pendingDraftReason =
    draftPending && !saving ? 'การแก้ไขล่าสุดยังบันทึกไม่เสร็จ — ถ้าปิดตอนนี้อาจหาย' : null
  // A stable flush: the guard keys an effect on it, so a new function on
  // every render re-ran that effect — and its setUnsaved — on every render.
  const flushDraft = useStableCallback(saveDraftNow)
  useUnsavedGuard(pendingDraftReason, flushDraft)

  return { saveDraftNow, draftSavedAt }
}
