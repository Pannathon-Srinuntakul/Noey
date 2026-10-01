/**
 * When the timeline editor's first view is ready to be shown.
 *
 * Owner report 2026-10-01: the loading screen went away, the editor appeared,
 * and the scene thumbnails sat SOLID BLACK for a while before popping in. The
 * old gate opened as soon as the filmstrip job had handed back its manifests —
 * which on a warm reopen is instant — but a manifest is not a picture: every
 * visible tile still had to come through the service worker and be decoded,
 * and the preview <video> had not even been given its source yet, because the
 * editor body was not mounted until the gate opened.
 *
 * The editor body now mounts UNDER the loading screen, so the lanes ask for
 * exactly the tiles they will show and the preview loads its first frame while
 * covered. The gate opens when:
 *
 *   - the filmstrip job has settled (strips in hand, or failed — a failed lane
 *     is an empty lane, never a reason to wait);
 *   - no tile an on-screen lane is waiting for is still loading;
 *   - the preview has painted its first frame (or failed to);
 *
 * or when the cap runs out, whichever comes first. Past the cap the editor
 * opens with neutral placeholders that the tiles fade in over.
 */

/** Never hold the editor longer than this, whatever is still loading. */
export const FIRST_VIEW_CAP_MS = 8000

export interface FilmstripProgress {
  status: 'idle' | 'running' | 'ready' | 'error'
  done: number
  total: number
}

export interface FirstViewInputs {
  filmstrip: FilmstripProgress
  /** Every tile the visible lanes asked for has decoded (or failed). */
  tilesSettled: boolean
  /** The preview <video> shows its first frame (or failed to load). */
  previewSettled: boolean
}

/** The job is over one way or another, or there was never anything to do. */
export function filmstripSettled(f: FilmstripProgress): boolean {
  return f.status === 'ready' || f.status === 'error' || f.total === 0
}

/**
 * Open the editor, or keep waiting and say on what. The hint names the step,
 * never a percentage — nothing here knows how far along a decode is.
 */
export function firstViewGate(i: FirstViewInputs): { open: boolean; hint: string } {
  const stripsDone = filmstripSettled(i.filmstrip)
  if (stripsDone && i.tilesSettled && i.previewSettled) return { open: true, hint: '' }
  if (!stripsDone) {
    const { done, total } = i.filmstrip
    return {
      open: false,
      hint:
        total > 1
          ? `กำลังเตรียมภาพตัวอย่างวิดีโอ… (${Math.min(done + 1, total)}/${total})`
          : 'กำลังเตรียมภาพตัวอย่างวิดีโอ…'
    }
  }
  if (!i.tilesSettled) return { open: false, hint: 'กำลังโหลดภาพตัวอย่าง…' }
  return { open: false, hint: 'กำลังโหลดตัวอย่างเล่น…' }
}

/**
 * Counts consecutive animation frames on which nothing was loading.
 *
 * A single zero is not proof: right after the strips land, the lanes have not
 * run their first paint yet, so for a frame or two NOTHING is subscribed and
 * the count reads 0 for the wrong reason. Requiring a short run of zeros lets
 * the lanes subscribe first.
 */
export function createSettleDetector(framesNeeded = 3): (loading: number) => boolean {
  let zeros = 0
  return (loading: number): boolean => {
    zeros = loading === 0 ? zeros + 1 : 0
    return zeros >= framesNeeded
  }
}

/** The bits of an HTMLVideoElement `waitForFirstFrame` reads. */
export interface FrameSource {
  readyState: number
  seeking: boolean
  error: unknown
  addEventListener: (type: string, fn: () => void) => void
  removeEventListener: (type: string, fn: () => void) => void
}

/** HTMLMediaElement.HAVE_CURRENT_DATA — a frame is decoded for the position. */
const HAVE_CURRENT_DATA = 2

/**
 * Resolves once `video` has a decoded frame at the position it was sent to,
 * or has failed — an error is a settled state too, and the editor shows it.
 * The player seeks to the first scene's in-point on load, so the frame that
 * counts is the one after that seek.
 */
export function waitForFirstFrame(video: FrameSource, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const shown = (): boolean =>
      !!video.error || (video.readyState >= HAVE_CURRENT_DATA && !video.seeking)
    const events = ['seeked', 'loadeddata', 'error'] as const
    const done = (): void => {
      for (const e of events) video.removeEventListener(e, check)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const check = (): void => {
      if (shown()) done()
    }
    if (signal?.aborted) return resolve()
    for (const e of events) video.addEventListener(e, check)
    signal?.addEventListener('abort', done)
    check()
  })
}
