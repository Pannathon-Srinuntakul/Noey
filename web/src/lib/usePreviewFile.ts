import { useEffect, useState } from 'react'
import type { ProjectMode, ProjectStep } from './projectFlow'

/** Probe a project-relative file without downloading it. */
async function exists(uid: string, rel: string): Promise<boolean> {
  try {
    const r = await fetch(window.noey.media.urlFor(uid, rel), {
      headers: { Range: 'bytes=0-0' },
      // A previous probe's 206 must not answer for a file that has since been
      // written (or deleted — removing music unlinks final_silent_music.mp4).
      cache: 'no-store'
    })
    // The body is a single byte, but an unread stream keeps the main-process
    // read stream (and its file handle) open until GC.
    await r.arrayBuffer().catch(() => undefined)
    return r.status === 206 || r.status === 200
  } catch {
    return false
  }
}

/**
 * Which rendered files can be the preview, richest first.
 *
 * The LAST entry is the always-present fallback and is never probed, so a
 * finished project always resolves in at most one round trip.
 *
 * `final_fx.mp4` (the zoom bake) has to head every list. It used to head only
 * the `waiting_vo` one, and `done` short-circuited straight to `final.mp4`
 * without probing at all — so on talking_head, and on dub_first once the
 * voiceover existed, the effects editor rendered a bake that the project page
 * then refused to show. Every later edit re-rendered and looked identical.
 * That is "AI สร้าง effect มา แล้วแก้ effect ไม่เปลี่ยน" (2026-09-07). The export
 * and the phone hand-off both preferred the bake the whole time
 * (`main/lanReceive.ts` FINAL_CANDIDATES), so what you previewed and what you
 * shipped were different videos.
 *
 * `null` means this state has no rendered candidates at all.
 */
export function previewCandidates(step: ProjectStep, mode: ProjectMode): string[] | null {
  // Handled by `settled` — the mode has no final.mp4, only highlights/hNN.mp4.
  if (mode === 'speech_highlights') return null
  // Voiceover is optional, and `highlight` never runs the VO mux, so for both
  // of these the silent cut is the end of the line.
  if (step === 'waiting_vo' || (step === 'done' && mode === 'highlight')) {
    return ['final_fx.mp4', 'final_silent_music.mp4', 'final_silent.mp4']
  }
  if (step === 'done') return ['final_fx.mp4', 'final.mp4']
  return null
}

/**
 * Which rendered file to show as a project's preview, or null when nothing is
 * rendered yet. Extracted from the old ProjectCard so the grid card and the
 * detail page share one definition.
 */
export function usePreviewFile(
  uid: string,
  step: ProjectStep,
  mode: ProjectMode,
  mediaKey: number,
  /** Two optionals that used to be two positional strings — and a caller
   * passing the clip path where the id now went silently asked for
   * `highlights/norm_000.mp4.mp4`, which 404s into a black box. Names make
   * that particular mistake unrepresentable. */
  opts: {
    /** speech_highlights: which highlight's file to show. The mode has NO
     * final.mp4 — every consumer names a highlight (grid cards show h01). */
    highlightId?: string
    /** First ingested clip (`normalized/norm_000.mp4`) — shown until a render
     * exists so a project has a picture the whole time it is working, not a
     * grey box. Safe to display for ANY source: ingest re-encodes non-browser
     * codecs (an iPhone HEVC .mov paints nothing in a <video>), so this path
     * is always decodable while the raw source may not be. */
    fallbackClipFile?: string
    /** speech_highlights only: false once the project is done but its index
     * came back empty, so the hook shows the source clip instead of guessing a
     * highlight file that was never written. */
    hasHighlights?: boolean
  } = {}
): string | null {
  const { highlightId, fallbackClipFile, hasHighlights = true } = opts
  // speech_highlights is the one mode whose answer is derivable without a
  // probe: it has no final.mp4 at all, only highlights/hNN.mp4.
  const settled =
    mode === 'speech_highlights' && step === 'done' && hasHighlights
      ? `highlights/${highlightId ?? 'h01'}.mp4`
      : null
  const candidates = previewCandidates(step, mode)
  // Keyed by the inputs the answer depends on, so a stale answer is discarded
  // during render instead of being cleared by a setState inside the effect.
  // After a re-render (mediaKey bump) the previous answer really can be the
  // wrong file — the music mix that was just removed, an fx bake that did not
  // exist last time round.
  const probeKey = `${uid}|${step}|${mode}|${mediaKey}`
  const [probed, setProbed] = useState<{ key: string; file: string } | null>(null)

  useEffect(() => {
    const list = previewCandidates(step, mode)
    if (!list) return
    let cancelled = false
    void (async () => {
      for (let i = 0; i < list.length; i++) {
        if (cancelled) return
        // The last candidate is the always-present fallback — no probe needed.
        const last = i === list.length - 1
        if (last || (await exists(uid, list[i]!))) {
          if (!cancelled) setProbed({ key: probeKey, file: list[i]! })
          return
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [uid, step, mode, mediaKey, probeKey])

  if (settled) return settled
  if (candidates) {
    // Null (an empty frame for the few ms the probe takes), never the raw
    // source clip: falling back to it here made a finished project open on the
    // UNCUT footage — no music, wrong length — and then swap to the real cut a
    // moment later, which read as "the music only arrives if you wait"
    // (live report 2026-08-13). The source is a placeholder for a project with
    // no render at all, not for one whose render is still being identified.
    return probed?.key === probeKey ? probed.file : null
  }
  return fallbackClipFile ?? null
}

/**
 * Which cut the effects editor should composite onto.
 *
 * Deliberately different from the preview: never `final_fx.mp4`, because that
 * is already-baked output and re-editing effects must start from the clean
 * cut again. Music-mixed silent cut is preferred over the plain one so an
 * attached track survives baking.
 */
export function useEffectsBase(
  uid: string,
  step: ProjectStep,
  mode: ProjectMode,
  mediaKey: number
): string | null {
  const [withMusic, setWithMusic] = useState<boolean | null>(null)
  // Checked FIRST, before the candidate list: `done` now offers final_fx.mp4 to
  // the preview, and this must keep returning the clean cut — re-editing zooms
  // has to start from footage with no zoom already baked into it.
  const usesFinal = step === 'done' && mode !== 'highlight'

  useEffect(() => {
    if (usesFinal || !previewCandidates(step, mode)) return
    let cancelled = false
    void exists(uid, 'final_silent_music.mp4').then((has) => {
      if (!cancelled) setWithMusic(has)
    })
    return () => {
      cancelled = true
    }
  }, [uid, step, mode, mediaKey, usesFinal])

  if (usesFinal) return 'final.mp4'
  if (!previewCandidates(step, mode)) return null
  if (withMusic === null) return null // still probing
  return withMusic ? 'final_silent_music.mp4' : 'final_silent.mp4'
}
