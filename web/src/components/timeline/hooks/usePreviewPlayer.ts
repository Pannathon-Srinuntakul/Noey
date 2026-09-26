import { useEffect, useRef, useState } from 'react'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import { editorApi, formatUserError, type CaptionLine } from '../../../lib/editorApi'
import { bindPointerDrag, NO_SCROLLER, type DragScroller } from '../../../lib/pointerDrag'
import {
  clamp,
  computeEditedDuration,
  computeEditedSegments,
  findSegmentAt,
  type EditedSegment
} from '../../../lib/timelineMath'
import {
  quantizeToFrame,
  snapScrub,
  type SnapHit,
  type SnapTarget
} from '../../../lib/timelineSnap'
import { FRAME_SEC, PLAY_AROUND_POST_SEC, PLAY_AROUND_PRE_SEC } from '../constants'
import {
  canSkim,
  playAroundRange,
  rangeStop,
  sceneRange,
  scrubSnapDecision,
  type PlayRange
} from '../playRange'
import { editedTimeIn, resolveEditedPosition, sceneIsOver } from '../previewMath'
import type { WorkingCut } from '../types'
import type { TimelineViewportApi } from './useTimelineViewport'

/** What the scrub needs to snap the playhead to an edge: the editor builds
 * the targets for the view on screen and draws the guide through `report`. */
export interface ScrubSnap {
  active: boolean
  targets: SnapTarget[]
  tolSec: number
  report(hit: SnapHit | null): void
}

/** Where a view was left, so switching back lands on the same frame. The
 * selection is not part of it: it is what the user picked to edit, and a
 * view switch does not pick anything. */
interface ViewModePlaybackState {
  /** On that view's clock (edited sequence, or the file's own). */
  currentTime: number
  previewSource: string | null
  editedActiveCutId: string | null
  /** The frame on screen, source-local — the edited view re-resolves its
   * scene from this, since the cut list may have changed in between. */
  sourceTime: number | null
  wasPlaying: boolean
}

export interface PreviewPlayerApi {
  videoARef: RefObject<HTMLVideoElement | null>
  videoBRef: RefObject<HTMLVideoElement | null>
  captionOverlayRef: RefObject<HTMLDivElement | null>
  holdFrameRef: RefObject<HTMLCanvasElement | null>
  playRangeRef: RefObject<{ in: number; out: number } | null>
  editedActiveCutIdRef: RefObject<string | null>
  resumePlaybackRef: RefObject<boolean>
  isSourceSwapPendingRef: RefObject<boolean>
  isPlaying: boolean
  setIsPlaying: Dispatch<SetStateAction<boolean>>
  previewSrc: string | null
  setPreviewSrc: Dispatch<SetStateAction<string | null>>
  activeVideo: () => HTMLVideoElement | null
  loadPreviewFor: (sourceId: string) => Promise<void>
  selectCut: (cut: WorkingCut) => void
  showCutFrame: (cut: WorkingCut, localSec: number) => void
  applyScrubTime: (sec: number, seekVideo: boolean) => void
  /** A jump a button or a key made: seek AND bring the playhead back on
   * screen. See jumpTo. */
  jumpTo: (sec: number) => void
  /** Put the playhead on a scene's first frame and select it — a double-click
   * on the block, an angle thumbnail, a voiceover line. */
  goToCutStart: (cut: WorkingCut) => void
  /** L / K / J: play–faster, stop, one second back. */
  shuttleFaster: () => void
  shuttleStop: () => void
  shuttleBack: () => void
  /** The shuttle's current speed — the music track has to follow it. */
  playbackRateRef: RefObject<number>
  pauseForScrub: () => void
  resumeAfterScrub: () => void
  onRulerPointerDown: (e: React.PointerEvent) => void
  onLaneBackgroundPointerDown: (e: React.PointerEvent) => void
  onSourceLanePointerDown: (sourceId: string, e: React.PointerEvent) => void
  togglePlay: () => void
  nudgePlayhead: (deltaSec: number) => void
  switchViewMode: (next: 'source' | 'edited') => void
  syncCaptionOverlay: () => void
  isActiveVideoEvent: (e: React.SyntheticEvent<HTMLVideoElement>) => boolean
  onTimeUpdate: () => void
  onVideoLoadedMetadata: () => void
  syncTimeFromVideo: () => void
  onVideoEnded: () => void
  onVideoPaused: () => void
  // ---- hover skim (FCP skimmer / CapCut preview axis) ----
  /** Show the frame under the pointer without moving the playhead; null =
   * the pointer left, put the playhead's frame back. */
  skimTo: (sec: number | null) => void
  setSkimEnabled: (v: boolean) => void
  // ---- play a range / a scene / around a cut, loop ----
  playRange: (inSec: number, outSec: number, opts?: { loop?: boolean }) => void
  /** Drop the active range (playback goes on to the end as usual). */
  stopRange: () => void
  playScene: (cutId: string) => void
  /** ±1 s around `sec` (Shift+K on the nearest cut). */
  playAround: (sec: number) => void
  isLooping: boolean
  /** Loop the active range when one is set, else the whole sequence. */
  setLoop: (v: boolean) => void
  // ---- two-up preview for a roll / slip ----
  beginTwoUp: (cut: WorkingCut, outgoing?: WorkingCut) => void
  /** Outgoing frame (source-local, left pane) and incoming frame (right pane). */
  paintTwoUp: (leftSec: number, rightSec: number) => void
  endTwoUp: () => void
  twoUp: boolean
  /** The element holding the incoming (right) frame while `twoUp` is on. */
  twoUpIncoming: 'A' | 'B'
  // ---- touch scrub (the viewport's swipe = scrub) ----
  onTouchScrub: (t: number) => void
}

/**
 * The preview: two <video> elements (the next edited-mode scene waits,
 * pre-seeked, in the hidden one), the playback frame loop, scrubbing, the
 * caption overlay, switching between the edited and source views, and every
 * other way the clock moves.
 *
 * The editor owns the state these share with the timeline — the cut list,
 * the selection, the view, which source is loaded — and passes it in with its
 * setters. `syncMusicAudio` has to be a stable wrapper over the newest render
 * (useStableCallback): the frame loop outlives the render that started it.
 *
 * The clock itself is not React state. It lives in `currentTimeRef` and is
 * painted to the DOM (viewport.paintTime); a state copy re-rendered the whole
 * editor on every seek and every `timeupdate`. The layout of the cut list —
 * `editedSegments`, `editedInById`, `editedDur` — comes in memoized, so the
 * frame loop and the scrub read it instead of rebuilding it per frame.
 */
/** `HTMLMediaElement.src` reads back as an absolute URL. Resolve a relative
 * one the same way before comparing, or equal sources never compare equal. */
/** The speeds L steps through. No 4x: the music track is a plain <audio> that
 * has to keep up, and past 2x it audibly gives up. */
const SHUTTLE_RATES = [1, 1.5, 2]
/** After the last touch-scrub event, playback resumes (if it was playing). */
const TOUCH_SCRUB_RESUME_MS = 150

function absoluteUrl(src: string): string {
  try {
    return new URL(src, document.baseURI).href
  } catch {
    return src
  }
}

export function usePreviewPlayer({
  uid,
  cuts,
  cutsRef,
  editedSegments,
  editedInById,
  editedDur,
  editorPhase,
  viewMode,
  viewModeRef,
  setViewMode,
  setSelectedId,
  previewSource,
  setPreviewSource,
  setVideoDuration,
  currentTimeRef,
  captionLinesRef,
  captionsOnOutputClock,
  isCutBlockEditingRef,
  getSourceDurationSec,
  getActiveDurationSec,
  viewport: { paintTime, followPlayhead, resumeFollow, revealPlayhead, timeAtClientX, pxPerSec },
  getScrubSnap,
  dragScroll = NO_SCROLLER,
  syncMusicAudio,
  setError,
  setErrorRetry
}: {
  uid: string
  cuts: WorkingCut[]
  cutsRef: RefObject<WorkingCut[]>
  /** `cuts` laid out on the edited clock — computeEditedSegments(cuts). */
  editedSegments: EditedSegment[]
  /** Each cut's start on the edited clock, by id. */
  editedInById: Map<string, number>
  /** computeEditedDuration(cuts). */
  editedDur: number
  editorPhase: 'loading' | 'preparing' | 'ready'
  viewMode: 'source' | 'edited'
  viewModeRef: RefObject<'source' | 'edited'>
  setViewMode: Dispatch<SetStateAction<'source' | 'edited'>>
  setSelectedId: Dispatch<SetStateAction<string | null>>
  previewSource: string | null
  setPreviewSource: Dispatch<SetStateAction<string | null>>
  setVideoDuration: Dispatch<SetStateAction<number>>
  currentTimeRef: RefObject<number>
  captionLinesRef: RefObject<CaptionLine[] | null>
  captionsOnOutputClock: boolean
  /** Set while a scene block is dragged: the playhead then stops moving the selection. */
  isCutBlockEditingRef: RefObject<boolean>
  getSourceDurationSec: (sourceId: string | null) => number
  getActiveDurationSec: () => number
  viewport: Pick<
    TimelineViewportApi,
    | 'paintTime'
    | 'followPlayhead'
    | 'resumeFollow'
    | 'revealPlayhead'
    | 'timeAtClientX'
    | 'pxPerSec'
  >
  /** Snap targets for the scrub, read once per drag frame (the playhead
   * snaps to cut edges, voiceover lines, markers — MANDATORY #2). */
  getScrubSnap?: () => ScrubSnap
  /** The viewport's edge auto-scroll, so a scrub past the edge scrolls. */
  dragScroll?: DragScroller
  syncMusicAudio: (t: number, allowPlay: boolean) => void
  setError: Dispatch<SetStateAction<string | null>>
  setErrorRetry: Dispatch<SetStateAction<'save' | null>>
}): PreviewPlayerApi {
  // Caption overlay on the preview. Painted imperatively from the rAF loop like
  // the playhead is — a React re-render per frame would fight the video.
  const captionOverlayRef = useRef<HTMLDivElement | null>(null)
  // The last frame, held on screen while another source file loads — see
  // holdFrame.
  const holdFrameRef = useRef<HTMLCanvasElement | null>(null)
  const holdTimerRef = useRef<number | undefined>(undefined)

  // Two <video> elements so the "next" edited-mode segment can be pre-seeked in the
  // background (hidden) and swapped in instantly — avoids the seek/reload freeze that
  // otherwise shows up as a stutter on every cut boundary during playback.
  const videoARef = useRef<HTMLVideoElement>(null)
  const videoBRef = useRef<HTMLVideoElement>(null)
  const activeVideoKeyRef = useRef<'A' | 'B'>('A')
  const bufferPrimedKeyRef = useRef<string | null>(null)
  const isScrubbingRef = useRef(false)
  const wasPlayingBeforeScrubRef = useRef(false)
  const isSourceSwapPendingRef = useRef(false)
  const previewCache = useRef<Map<string, { src: string; cleanup: () => void }>>(new Map())
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  // The src an instant buffer swap just handed to setPreviewSrc. The swap has
  // already set the source, duration and playback, so the previewSrc effect
  // must not redo its "already loaded" path — that re-seeks the video that just
  // started playing, a stall exactly where the swap was meant to be seamless.
  // A URL rather than a flag: a same-source swap does not re-run the effect,
  // and a flag left set would then skip a later real load.
  const swappedInSrcRef = useRef<string | null>(null)
  // Live previewSrc for the rAF-driven swap, whose closure can be a render old.
  const previewSrcRef = useRef(previewSrc)
  previewSrcRef.current = previewSrc
  // The seek a source load owes: where the new file must land (`in`,
  // source-local) once it has loaded. The previewSrc effect applies it.
  const playRangeRef = useRef<{ in: number; out: number } | null>(null)
  // Whether a pending source load starts playing when it lands. False until
  // something asks to play: opening the editor used to start playback by
  // itself, because the first load found this left at true (owner,
  // 2026-09-21: "เปิดมาแล้วมันเล่นเอง").
  const resumePlaybackRef = useRef(false)
  const editedActiveCutIdRef = useRef<string | null>(null)
  // Set by the `pause` the browser fires just before `ended` when playback
  // runs off the end of the file — see onVideoPaused.
  const endedWhilePlayingRef = useRef(false)
  const sourceViewStateRef = useRef<ViewModePlaybackState | null>(null)
  const editedViewStateRef = useRef<ViewModePlaybackState | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  // The range playback stops at (play scene / play around / I–O). On the
  // active view's clock. Any user seek, a play toggle or a view switch drops
  // it — Premiere/FCP behaviour.
  const activeRangeRef = useRef<PlayRange | null>(null)
  const [isLooping, setIsLooping] = useState(false)
  const isLoopingRef = useRef(false)
  // Hover skim: the frame under the pointer, shown without moving the clock.
  const skimEnabledRef = useRef(true)
  // undefined = nothing pending; null = a restore to the playhead's frame.
  const skimPendingRef = useRef<number | null | undefined>(undefined)
  const skimFrameRef = useRef(0)
  /** The element shows a skimmed frame, not the playhead's. Its `seeked` /
   * `timeupdate` must not be read back as the clock — they were, so hovering
   * the timeline dragged the playhead along (measured 2026-09-27). */
  const skimShowingRef = useRef(false)
  // Two-up (roll / slip): which element was active when it began, so it can
  // be put back, and the last frame each pane was asked for.
  const [twoUp, setTwoUp] = useState(false)
  // Which element shows the INCOMING (right) frame: the active one at
  // beginTwoUp. PreviewPane lays the halves out from this, since the two
  // <video> elements are absolutely positioned and would ignore flex order.
  const [twoUpIncoming, setTwoUpIncoming] = useState<'A' | 'B'>('B')
  const twoUpRef = useRef<{
    leftSec: number | null
    rightSec: number | null
    frame: number
  } | null>(null)
  // Touch scrub: a swipe on the strip. Paused on the first event, resumed
  // once the scrolling has been quiet for a moment.
  const touchScrubTimerRef = useRef<number | undefined>(undefined)
  const touchScrubFrameRef = useRef(0)
  const touchScrubTRef = useRef(0)

  useEffect(() => {
    // Captured now: the refs are cleared by React before this cleanup runs.
    const elements = [videoARef.current, videoBRef.current]
    return () => {
      previewCache.current.forEach((v) => v.cleanup())
      previewCache.current.clear()
      window.clearTimeout(holdTimerRef.current)
      window.clearTimeout(touchScrubTimerRef.current)
      cancelAnimationFrame(skimFrameRef.current)
      cancelAnimationFrame(touchScrubFrameRef.current)
      if (twoUpRef.current?.frame) cancelAnimationFrame(twoUpRef.current.frame)
      // Release the decoders: an element that leaves the DOM with a src keeps
      // its buffers until GC gets round to it (useFilmstrip does the same).
      for (const v of elements) {
        if (!v) continue
        v.pause()
        v.removeAttribute('src')
        v.load()
      }
    }
  }, [])

  useEffect(() => {
    applyVideoVisibility()
  }, [])

  // Keep the hidden buffer video pre-seeked to whatever cut plays next. The
  // active scene moving is covered by setActiveCut, which primes too — it is
  // no longer the selection, which stays where the user put it.
  useEffect(() => {
    if (viewMode !== 'edited' || editorPhase !== 'ready') return
    primeNextSegment()
  }, [viewMode, editorPhase, cuts])

  // The cut list changed under the preview — a delete, an undo, a reorder, an
  // AI re-edit, a trim. Put the player back on a scene that exists: it used to
  // keep pointing at a deleted one, so the preview went on showing footage
  // that is no longer in the edit and the next play jumped to 0:00 and
  // skipped scene 1. A scene that still exists keeps its frame; only its
  // place on the clock moves.
  useEffect(() => {
    if (viewMode !== 'edited' || editorPhase !== 'ready') return
    if (isSourceSwapPendingRef.current || isScrubbingRef.current) return
    // Mid-trim the element shows the edge being dragged (showCutFrame), not
    // the playhead's frame: the clock keeps its time, and seeking it back
    // here would fight the drag frame by frame. The commit runs this again.
    if (isCutBlockEditingRef.current) return
    const v = activeVideo()
    if (!v || !previewSrc) return
    const activeId = editedActiveCutIdRef.current
    const active = cuts.find((c) => c.id === activeId)
    // A skimmed frame is not the playhead's either: fall back to the clock.
    const shownTime =
      !skimShowingRef.current && active && active.source === previewSource ? v.currentTime : null
    const pos = resolveEditedPosition(editedSegments, activeId, shownTime, currentTimeRef.current)
    if (!pos) {
      editedActiveCutIdRef.current = null
      return
    }
    if (
      pos.seg.cut.id === activeId &&
      shownTime !== null &&
      Math.abs(pos.local - shownTime) <= 0.1
    ) {
      currentTimeRef.current = pos.t
      paintTime(pos.t)
      return
    }
    goToEditedPosition(pos.seg.cut, pos.local, pos.t)
  }, [cuts])

  // Smooth playhead — rAF paints the positioned playhead + transport directly
  // (no React re-render per frame).
  // One frame of the playback clock. Kept in a ref so the rAF loop below
  // binds once per play: it used to depend on `cuts` and `pxPerSec` too, so a
  // trim or a zoom during playback cancelled and restarted the loop on every
  // frame of the gesture.
  const playbackStep = (): void => {
    const v = activeVideo()
    if (v && !v.paused && !isScrubbingRef.current && !isSourceSwapPendingRef.current) {
      // Neither the selection nor the active scene is re-derived from `t`
      // here: `t` is computed FROM the active scene, and the selection is
      // the user's (see syncTimeFromVideo).
      const t =
        viewMode === 'edited'
          ? editedTimeOfVideo(v)
          : clamp(v.currentTime, 0, getActiveDurationSec())
      // The range's end comes before the scene's: a scene that ends where
      // the range does must not advance to the next one.
      if (enforceRange(v, t)) return
      if (viewMode === 'edited' && maybeAdvanceEditedSegment(v)) return
      currentTimeRef.current = t
      paintTime(t)
      followPlayhead(t)
      syncMusicAudio(t, true)
      syncCaptionOverlay()
    }
  }
  const playbackStepRef = useRef(playbackStep)
  playbackStepRef.current = playbackStep
  useEffect(() => {
    if (!isPlaying) return
    let raf = 0
    const tick = () => {
      playbackStepRef.current()
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [isPlaying])

  function currentEditedCut(): WorkingCut | null {
    return cuts.find((c) => c.id === editedActiveCutIdRef.current) ?? null
  }

  /** The edited-clock time of the frame `v` shows, through the active scene.
   * With no active scene the clock stays where it is — it used to fall to
   * 0:00, which is how a deleted scene sent the next play to the start. */
  function editedTimeOfVideo(v: HTMLVideoElement): number {
    const cut = currentEditedCut()
    const editedIn = cut ? editedInById.get(cut.id) : undefined
    if (!cut || editedIn === undefined) return clamp(currentTimeRef.current, 0, editedDur)
    return clamp(editedTimeIn(editedIn, cut, v.currentTime), 0, editedDur)
  }

  /** Make `id` the scene the edited preview plays, and pre-seek the one
   * after it. The selection is not touched: it follows the user's clicks
   * only, never the playhead. */
  function setActiveCut(id: string): void {
    if (editedActiveCutIdRef.current === id) return
    editedActiveCutIdRef.current = id
    primeNextSegment()
  }

  /**
   * Hold the frame on screen while the active <video> loads another file.
   * A new src blanks the element to its black background until the new file
   * has decoded a frame, so every switch of source file flashed black. The
   * frame is copied onto a canvas over the videos and taken away once the new
   * file has seeked (releaseHeldFrame), or after a few seconds whatever
   * happens.
   */
  function holdFrame(v: HTMLVideoElement): void {
    const c = holdFrameRef.current
    if (!c || v.readyState < 2 || !v.videoWidth || !v.videoHeight) return
    try {
      if (c.width !== v.videoWidth) c.width = v.videoWidth
      if (c.height !== v.videoHeight) c.height = v.videoHeight
      c.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height)
    } catch {
      return
    }
    c.style.opacity = '1'
    window.clearTimeout(holdTimerRef.current)
    holdTimerRef.current = window.setTimeout(releaseHeldFrame, 4000)
  }

  function releaseHeldFrame(): void {
    window.clearTimeout(holdTimerRef.current)
    const c = holdFrameRef.current
    if (c && c.style.opacity !== '0') c.style.opacity = '0'
  }

  /** Start loading another source file for the active <video>, to land on
   * source-local `local` (see playRangeRef). It keeps playing across the load
   * exactly when it was playing before — a keyboard or caption jump into a
   * scene from another file used to stop playback. The old element is
   * paused at once: left running, it played footage past the scene's
   * out-point, and its `timeupdate`s could advance past the scene being
   * loaded. */
  function beginSourceLoad(sourceId: string, local: number, out: number): void {
    const v = activeVideo()
    // A load already on its way has paused the element; whether it resumes
    // is what it owes.
    const wasPlaying = isSourceSwapPendingRef.current ? resumePlaybackRef.current : !!v && !v.paused
    isSourceSwapPendingRef.current = true
    resumePlaybackRef.current = wasPlaying
    playRangeRef.current = { in: local, out }
    if (v && wasPlaying) v.pause()
    void loadPreviewFor(sourceId)
  }

  /** Put the edited preview on `cut` at source-local `local` (= `t` on the
   * edited clock), loading its file when it is not the one on screen. */
  function goToEditedPosition(cut: WorkingCut, local: number, t: number): void {
    setActiveCut(cut.id)
    skimShowingRef.current = false
    currentTimeRef.current = t
    paintTime(t)
    if (previewSource !== cut.source) {
      beginSourceLoad(cut.source, local, cut.out)
      return
    }
    const v = activeVideo()
    if (v) v.currentTime = local
  }

  function activeVideo(): HTMLVideoElement | null {
    return activeVideoKeyRef.current === 'A' ? videoARef.current : videoBRef.current
  }

  function inactiveVideo(): HTMLVideoElement | null {
    return activeVideoKeyRef.current === 'A' ? videoBRef.current : videoARef.current
  }

  /** Imperative opacity/z-index swap — no React re-render, so the switch itself is instant. */
  function applyVideoVisibility() {
    const a = videoARef.current
    const b = videoBRef.current
    const aIsActive = activeVideoKeyRef.current === 'A'
    if (a) {
      a.style.opacity = aIsActive ? '1' : '0'
      a.style.zIndex = aIsActive ? '2' : '1'
    }
    if (b) {
      b.style.opacity = aIsActive ? '0' : '1'
      b.style.zIndex = aIsActive ? '1' : '2'
    }
  }

  function bufferKeyFor(cut: WorkingCut): string {
    return `${cut.id}:${cut.source}:${cut.in}`
  }

  function isBufferReadyFor(next: WorkingCut): boolean {
    const buf = inactiveVideo()
    if (!buf) return false
    return bufferPrimedKeyRef.current === bufferKeyFor(next) && buf.readyState >= 2
  }

  /** Look ahead to the cut after the currently active one and pre-seek the hidden video to it. */
  function primeNextSegment() {
    if (viewModeRef.current !== 'edited') return
    const list = cutsRef.current
    const idx = list.findIndex((c) => c.id === editedActiveCutIdRef.current)
    if (idx < 0) return
    const next = list[idx + 1]
    const buf = inactiveVideo()
    if (!next || !buf) return
    const key = bufferKeyFor(next)
    if (bufferPrimedKeyRef.current === key) return
    bufferPrimedKeyRef.current = key
    void (async () => {
      try {
        const src = await ensureSourceSrc(next.source)
        if (bufferPrimedKeyRef.current !== key) return
        const seekTo = () => {
          if (bufferPrimedKeyRef.current !== key) return
          buf.currentTime = next.in
        }
        // `.src` reads back resolved, while web media URLs are relative
        // (`/media/...`) — compared raw they never match, and assigning the
        // same URL again reloads the buffer from scratch on every prime.
        if (buf.src !== absoluteUrl(src)) {
          buf.src = src
          buf.addEventListener('loadedmetadata', seekTo, { once: true })
        } else if (buf.readyState >= 1) {
          seekTo()
        } else {
          buf.addEventListener('loadedmetadata', seekTo, { once: true })
        }
      } catch {
        if (bufferPrimedKeyRef.current === key) bufferPrimedKeyRef.current = null
      }
    })()
  }

  /** Seek the active <video> to a position on the active timeline domain.
   * Source mode is local to the active file, so no clip-boundary crossing —
   * cross-file moves happen only through a click on another file's lane
   * (onSourceLanePointerDown). */
  function seekActiveTime(t: number) {
    if (viewMode !== 'edited') {
      const v = activeVideo()
      if (v) v.currentTime = clamp(t, 0, getActiveDurationSec())
      return
    }
    const seg = findSegmentAt(editedSegments, t)
    if (!seg) return
    const localTime = clamp(seg.cut.in + (t - seg.editedIn), seg.cut.in, seg.cut.out)
    setActiveCut(seg.cut.id)
    if (previewSource !== seg.cut.source) {
      beginSourceLoad(seg.cut.source, localTime, seg.cut.out)
    } else {
      const v = activeVideo()
      if (v) v.currentTime = localTime
    }
  }

  /**
   * While playing in edited mode: once the active cut's out-point is reached,
   * jump to the next cut. Only ever called for an element that is playing
   * (or has just ended while playing) — see onTimeUpdate: a paused seek that
   * landed near an out-point used to advance to the next scene and START
   * playback, so frame-stepping across a cut or dragging a right trim handle
   * played the clip.
   */
  function maybeAdvanceEditedSegment(v: HTMLVideoElement): boolean {
    const cut = currentEditedCut()
    if (!cut) return false
    if (!sceneIsOver(v.currentTime, cut, v.duration)) return false
    // The scene after this one in PLAY order — editedSegments, not the raw
    // cut list, so a scene with no segment (skipped) is jumped over.
    const idx = editedSegments.findIndex((s) => s.cut.id === cut.id)
    const next = editedSegments[idx + 1]?.cut
    if (!next) {
      const dur = computeEditedDuration(cuts)
      if (isLoopingRef.current && !activeRangeRef.current) {
        // Loop the whole sequence: back to the start, still playing.
        applyScrubTimeRef.current(0, true)
        if (isSourceSwapPendingRef.current) resumePlaybackRef.current = true
        else if (v.paused) void v.play()
        return true
      }
      v.pause()
      setIsPlaying(false)
      currentTimeRef.current = dur
      paintTime(dur)
      return true
    }
    // The selection stays: the scene playing is not the scene being edited.
    editedActiveCutIdRef.current = next.id
    resumePlaybackRef.current = true
    playRangeRef.current = { in: next.in, out: next.out }

    if (isBufferReadyFor(next)) {
      // Instant swap: the hidden buffer is already seeked & decoded at next.in.
      const buf = inactiveVideo()!
      v.pause()
      activeVideoKeyRef.current = activeVideoKeyRef.current === 'A' ? 'B' : 'A'
      applyVideoVisibility()
      void buf.play()
      setVideoDuration(buf.duration || 0)
      setPreviewSource(next.source)
      const swappedSrc = buf.currentSrc || buf.src
      // Only a value that will re-run the effect is recorded; see swappedInSrcRef.
      swappedInSrcRef.current = swappedSrc !== previewSrcRef.current ? swappedSrc : null
      setPreviewSrc(swappedSrc)
      bufferPrimedKeyRef.current = null
    } else if (previewSource !== next.source) {
      isSourceSwapPendingRef.current = true
      // Stop the old file where the scene ended — see beginSourceLoad.
      v.pause()
      void loadPreviewFor(next.source)
    } else {
      v.currentTime = next.in
      if (v.paused) void v.play()
    }
    primeNextSegment()
    return true
  }

  /** Move the playhead. The selection does not follow it — it used to, so
   * scrubbing or playing past a scene selected it, and the inspector swapped
   * lines under the caret (owner, 2026-09-21). */
  function applyScrubTime(sec: number, seekVideo: boolean) {
    const dur = getActiveDurationSec()
    const t = clamp(sec, 0, dur)
    // A deliberate move: whatever frame the skimmer left on screen is over.
    skimShowingRef.current = false
    currentTimeRef.current = t
    paintTime(t)
    if (seekVideo) seekActiveTime(t)
    syncMusicAudio(t, false)
  }

  /**
   * Move the playhead the way a BUTTON or a KEY does, as opposed to a drag:
   * seek, then bring the playhead back on screen if the jump took it out of
   * the view (revealPlayhead nudges — it never recentres).
   *
   * Every user-initiated jump goes through here. revealPlayhead used to be
   * called from exactly one place, the view switch, so Home/End, a caption
   * jump, the seek bar and the cut jumps all moved the playhead while the
   * timeline sat perfectly still — which reads as a button that did nothing.
   */
  function jumpTo(sec: number): void {
    activeRangeRef.current = null
    applyScrubTime(sec, true)
    // After the clamp, not the asked-for value.
    revealPlayhead(currentTimeRef.current)
  }

  /**
   * Put the playhead on a scene's first frame and select it — what a
   * double-click on a block, an angle thumbnail or a voiceover line means:
   * "show me this one". A single click still only selects (see selectCut).
   */
  function goToCutStart(cut: WorkingCut): void {
    setSelectedId(cut.id)
    if (viewModeRef.current === 'edited') {
      const t = editedInById.get(cut.id)
      if (t === undefined) return
      jumpTo(t)
      return
    }
    if (previewSource !== cut.source) {
      // Another file: the load lands on the frame and paints the clock itself.
      showCutFrame(cut, cut.in)
      revealPlayhead(cut.in)
      return
    }
    jumpTo(cut.in)
  }

  // ---- shuttle (J K L) -------------------------------------------------------
  // Forward speeds only: a <video> has no reverse — a negative playbackRate is
  // ignored by every browser we ship on — so J steps BACK instead of playing
  // backwards.
  const playbackRateRef = useRef(1)

  function isPlayingNow(): boolean {
    // Mid-load the element is paused on purpose; what it owes is the truth.
    if (isSourceSwapPendingRef.current) return resumePlaybackRef.current
    const v = activeVideo()
    return !!v && !v.paused
  }

  function setPlaybackRate(rate: number): void {
    playbackRateRef.current = rate
    for (const el of [videoARef.current, videoBRef.current]) {
      if (!el) continue
      // defaultPlaybackRate too: loading another file resets playbackRate to
      // it, and the edited view loads one per change of source.
      el.defaultPlaybackRate = rate
      el.playbackRate = rate
    }
  }

  /** L — play, then step the speed up on each further press. */
  function shuttleFaster(): void {
    if (!isPlayingNow()) {
      setPlaybackRate(1)
      togglePlay()
      return
    }
    const idx = SHUTTLE_RATES.indexOf(playbackRateRef.current)
    setPlaybackRate(SHUTTLE_RATES[idx + 1] ?? SHUTTLE_RATES[SHUTTLE_RATES.length - 1])
  }

  /** K — stop, and drop back to normal speed. */
  function shuttleStop(): void {
    setPlaybackRate(1)
    if (isPlayingNow()) togglePlay()
  }

  /** J — one second back, stopped. */
  function shuttleBack(): void {
    setPlaybackRate(1)
    if (isPlayingNow()) togglePlay()
    jumpTo(currentTimeRef.current - 1)
  }

  function pauseForScrub() {
    const v = activeVideo()
    // A scrub is a user seek: the play range it interrupts is over.
    activeRangeRef.current = null
    if (!isScrubbingRef.current && v) {
      wasPlayingBeforeScrubRef.current = !v.paused
    }
    isScrubbingRef.current = true
    resumePlaybackRef.current = false
    setIsPlaying(false)
    if (v && !v.paused) v.pause()
  }

  function resumeAfterScrub() {
    isScrubbingRef.current = false
    if (!wasPlayingBeforeScrubRef.current) return
    // A scrub that ended in another file's scene: the element still holds the
    // old file, so the load resumes playback when it lands.
    if (isSourceSwapPendingRef.current) resumePlaybackRef.current = true
    else void activeVideo()?.play()
  }

  // The CURRENT render's scrub function. The drag's listeners live across
  // renders; calling the pointerdown render's copy kept reading the
  // previewSource it saw then, so scrubbing across a change of source file
  // reloaded the preview on every move and seeked the wrong file.
  const applyScrubTimeRef = useRef(applyScrubTime)
  applyScrubTimeRef.current = applyScrubTime

  /**
   * One scrub frame: the time under the pointer, on the frame grid, pulled
   * onto a nearby edge (cut, voiceover line, marker, playhead of the other
   * view…) unless Alt or Shift says not to (MANDATORY #2). Snap targets are
   * exact, so quantizing first never moves a snapped value off its edge.
   */
  function scrubFrame(clientX: number, mods: { altKey: boolean; shiftKey: boolean }): void {
    const t = quantizeToFrame(timeAtClientX(clientX))
    const snap = getScrubSnap?.()
    const { sec, hit } = snap
      ? scrubSnapDecision(
          t,
          { active: snap.active, altKey: mods.altKey, shiftKey: mods.shiftKey },
          snap.targets,
          snap.tolSec,
          snapScrub
        )
      : { sec: t, hit: null }
    snap?.report(hit)
    applyScrubTimeRef.current(sec, true)
  }

  /** Ruler / playhead-grip drag: scrub while moving, commit + resume on
   * release. On the shared binder (lib/pointerDrag): one seek per frame with
   * the newest pointer — every move used to seek the video, set state and
   * read layout, which is most of why scrubbing felt sticky — plus edge
   * auto-scroll through `dragScroll` and Escape, which just ends it (a scrub
   * has no start state to put back). */
  function onRulerPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return
    pauseForScrub()
    scrubFrame(e.clientX, { altKey: e.altKey, shiftKey: e.shiftKey })
    bindPointerDrag({
      e,
      pxPerSec,
      scroller: dragScroll,
      onFrame: (f) => scrubFrame(f.clientX, f),
      onEnd: () => {
        getScrubSnap?.().report(null)
        resumeAfterScrub()
      }
    })
  }

  /** Click on empty lane background = move the playhead there. Blocks and
   * handles stopPropagation, so anything that reaches this IS background. */
  function onLaneBackgroundPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest('[data-cut-block]') || target.closest('[data-trim-handle]')) return
    onRulerPointerDown(e)
  }

  /** Resolve (and cache) the playable src for a source clip — shared by preview and filmstrip generation. */
  async function ensureSourceSrc(sourceId: string): Promise<string> {
    const cached = previewCache.current.get(sourceId)
    if (cached) return cached.src
    const r = await editorApi.resolveSourcePreviewSrc(uid, sourceId)
    previewCache.current.set(sourceId, r)
    return r.src
  }

  async function loadPreviewFor(sourceId: string) {
    try {
      const src = await ensureSourceSrc(sourceId)
      setPreviewSrc(src)
      setPreviewSource(sourceId)
    } catch (e) {
      setError(formatUserError(e))
      setErrorRetry(null)
    }
  }

  /**
   * Select a scene — and only that, the way a normal editor does it. A click
   * used to move the playhead to the scene's start, seek (or load) the
   * preview and scroll the timeline to it, so grabbing a trim handle first
   * jumped the preview, and clicking a scene to look at it lost your place
   * (owner, 2026-09-21).
   *
   * One exception, in the SOURCE view: a scene in another file's lane loads
   * that file, parked on the scene's first frame. There the preview is one
   * file's own clock, so the file on screen IS the context — leaving the old
   * one up showed a different clip than the selection, and [ / ] (which act
   * on the frame on screen) silently did nothing. The edited clock is not
   * touched.
   */
  function selectCut(cut: WorkingCut): void {
    setSelectedId(cut.id)
    if (viewModeRef.current === 'source' && previewSource !== cut.source) {
      showCutFrame(cut, cut.in)
    }
  }

  /**
   * Show source-local `localSec` of `cut` in the preview — a trim drag keeps
   * the edge being trimmed on screen. In the edited view that scene becomes
   * the one the preview is on, so the clock reads the frame through it and
   * the playhead sits on the edge.
   */
  function showCutFrame(cut: WorkingCut, localSec: number): void {
    if (viewModeRef.current === 'edited') setActiveCut(cut.id)
    if (previewSource !== cut.source) {
      // Every drag frame lands here until the file has loaded; the load seeks
      // to the newest edge (playRangeRef), not the first.
      if (isSourceSwapPendingRef.current) {
        playRangeRef.current = { in: localSec, out: cut.out }
        return
      }
      beginSourceLoad(cut.source, localSec, cut.out)
      return
    }
    const v = activeVideo()
    if (v) v.currentTime = localSec
  }

  // Once the preview video src swaps in, seek + play the pending range.
  useEffect(() => {
    // Consumed on every run, so a swap that never re-ran this effect cannot
    // leave a stale URL behind to skip a later load of that same file.
    const swappedIn = swappedInSrcRef.current
    swappedInSrcRef.current = null
    if (previewSrc && swappedIn === previewSrc) return
    const v = activeVideo()
    if (!v || !playRangeRef.current || !previewSrc) return
    // Resolved for the comparison only — see primeNextSegment.
    const absSrc = absoluteUrl(previewSrc)
    if (v.src !== absSrc) {
      holdFrame(v)
      v.src = previewSrc
    }
    // Named so the cleanup can drop it: a once-listener left on the element
    // by a load that was superseded released the NEXT load's held frame early.
    const onFirstSeeked = (): void => {
      requestAnimationFrame(() => requestAnimationFrame(releaseHeldFrame))
    }
    const onLoaded = () => {
      const range = playRangeRef.current
      if (!range) {
        releaseHeldFrame()
        return
      }
      v.currentTime = range.in
      // The held frame goes once the new file shows its own: `seeked`, then
      // two frames for the compositor to put it on screen.
      v.addEventListener('seeked', onFirstSeeked, { once: true })
      setVideoDuration(v.duration || 0)
      // The exact moment the load was asked for: `range.in` through the
      // active scene. It used to paint the scene's START, so a scrub, a view
      // switch or a jump into another file's scene lost its offset in it.
      const cutId = editedActiveCutIdRef.current
      let activeT = range.in
      if (viewModeRef.current === 'edited') {
        const seg = cutId
          ? computeEditedSegments(cutsRef.current).find((s) => s.cut.id === cutId)
          : undefined
        activeT = seg ? editedTimeIn(seg.editedIn, seg.cut, range.in) : currentTimeRef.current
      }
      currentTimeRef.current = activeT
      paintTime(activeT)
      isSourceSwapPendingRef.current = false
      if (resumePlaybackRef.current) void v.play()
    }
    if (v.readyState >= 1 && v.src === absSrc) onLoaded()
    else v.addEventListener('loadedmetadata', onLoaded, { once: true })
    return () => {
      v.removeEventListener('loadedmetadata', onLoaded)
      v.removeEventListener('seeked', onFirstSeeked)
    }
  }, [previewSrc, editorPhase])

  /** Source-absolute time of whatever the active <video> is showing — the clock
   * caption lines are timed against. The <video> is always seeked to a
   * source-local position, so this is just its currentTime. */
  function activeSourceTime(): number | null {
    const v = activeVideo()
    if (!v) return null
    return v.currentTime
  }

  /** Paint the caption line under the playhead onto the preview overlay. */
  function syncCaptionOverlay(): void {
    const el = captionOverlayRef.current
    if (!el) return
    const lines = captionLinesRef.current
    // Output-clock lines mean nothing against a raw source file: in the source
    // view the clock is the FILE's, so they showed other moments' text over
    // footage that may not even be in the clip. Nothing to show there.
    const t =
      lines && lines.length > 0
        ? captionsOnOutputClock
          ? viewModeRef.current === 'edited'
            ? currentTimeRef.current
            : null
          : activeSourceTime()
        : null
    const line = t === null ? undefined : lines!.find((l) => t >= l.start && t < l.end)
    const text = line?.text ?? ''
    if (el.textContent !== text) el.textContent = text
  }

  function syncTimeFromVideo() {
    syncCaptionOverlay()
    if (isScrubbingRef.current || isSourceSwapPendingRef.current) return
    const v = activeVideo()
    if (!v) return
    // A skimmed frame, or the edge a trim is showing (showCutFrame), is not
    // where the playhead is. Playback ends a skim: the frames are the clock's.
    if (!v.paused) skimShowingRef.current = false
    else if (skimShowingRef.current || isCutBlockEditingRef.current) return
    let t: number
    if (viewMode === 'edited') {
      if (!currentEditedCut()) return
      t = editedTimeOfVideo(v)
    } else {
      t = clamp(v.currentTime, 0, getActiveDurationSec())
    }
    currentTimeRef.current = t
    paintTime(t)
  }
  function isActiveVideoEvent(e: React.SyntheticEvent<HTMLVideoElement>): boolean {
    return e.currentTarget === activeVideo()
  }

  function onVideoLoadedMetadata() {
    const v = activeVideo()
    if (!v) return
    setVideoDuration(v.duration || 0)
    if (!isScrubbingRef.current && !isSourceSwapPendingRef.current) syncTimeFromVideo()
  }

  /** `timeupdate` also fires when a seek completes on a PAUSED element, and
   * from the old element while another file is being loaded — neither is
   * playback reaching an out-point, so neither may advance the scene. */
  function onTimeUpdate() {
    const v = activeVideo()
    if (
      v &&
      !v.paused &&
      !isScrubbingRef.current &&
      !isSourceSwapPendingRef.current &&
      !isCutBlockEditingRef.current
    ) {
      // The source view has no frame loop of its own past the rAF tick; the
      // range end is enforced here too so a paused tab still stops.
      const t =
        viewMode === 'edited'
          ? editedTimeOfVideo(v)
          : clamp(v.currentTime, 0, getActiveDurationSec())
      if (enforceRange(v, t)) return
      if (viewMode === 'edited' && maybeAdvanceEditedSegment(v)) return
    }
    syncTimeFromVideo()
  }

  /** The element ran off the end of its FILE. In the edited view, while
   * playing, that is a scene ending where its file ends — the next scene
   * plays, rather than the whole preview stopping there. `ended` also fires
   * for a paused seek to the end of the file; that is only a seek. */
  function onVideoEnded() {
    const v = activeVideo()
    const wasPlaying = endedWhilePlayingRef.current
    endedWhilePlayingRef.current = false
    if (viewMode === 'edited') {
      if (
        wasPlaying &&
        v &&
        !isScrubbingRef.current &&
        !isSourceSwapPendingRef.current &&
        maybeAdvanceEditedSegment(v)
      )
        return
      setIsPlaying(false)
      return
    }
    if (wasPlaying && isLoopingRef.current && !activeRangeRef.current && v) {
      // Loop the file: back to the start, still playing.
      applyScrubTime(0, true)
      void v.play()
      return
    }
    setIsPlaying(false)
    const dur = getActiveDurationSec()
    currentTimeRef.current = dur
    paintTime(dur)
  }

  /** The element paused. Not while a source load that resumes is pending:
   * that pause is the old file being stopped (beginSourceLoad), and the
   * transport should keep reading "playing" across the swap. Nor when it is
   * playback reaching the end of the file: the browser pauses the element
   * just before `ended`, and onVideoEnded decides whether the edit goes on. */
  function onVideoPaused() {
    const v = activeVideo()
    if (v?.ended) {
      endedWhilePlayingRef.current = true
      if (viewModeRef.current === 'edited') return
    }
    if (isSourceSwapPendingRef.current && resumePlaybackRef.current) return
    setIsPlaying(false)
  }

  function captureViewModeState(m: 'source' | 'edited') {
    const v = activeVideo()
    const pending = isSourceSwapPendingRef.current
    const state: ViewModePlaybackState = {
      currentTime: currentTimeRef.current,
      previewSource,
      editedActiveCutId: m === 'edited' ? editedActiveCutIdRef.current : null,
      // Mid-load the element still shows the old file; the target is owed.
      sourceTime: pending ? (playRangeRef.current?.in ?? null) : v ? v.currentTime : null,
      wasPlaying: pending ? resumePlaybackRef.current : v ? !v.paused : isPlaying
    }
    if (m === 'source') sourceViewStateRef.current = state
    else editedViewStateRef.current = state
  }

  /**
   * Land a view where it was left. The target is resolved first and handed to
   * the load as ONE seek (playRangeRef): seeking the element before its new
   * src went in was lost when the load re-seeked, so a view on another file
   * came back at the start of its scene or at an old in-point, and a scene
   * deleted in the other view came back on screen at 0:00.
   */
  function restoreViewModeState(m: 'source' | 'edited') {
    const saved = m === 'source' ? sourceViewStateRef.current : editedViewStateRef.current
    const wasPlaying = saved?.wasPlaying ?? false
    let source: string | null
    let local: number
    let out: number
    let t: number

    if (m === 'edited') {
      // The saved frame counts only if it was of the saved scene's own file.
      const savedCut = cuts.find((c) => c.id === saved?.editedActiveCutId)
      const shown =
        saved && savedCut && savedCut.source === saved.previewSource ? saved.sourceTime : null
      const pos = resolveEditedPosition(
        editedSegments,
        saved?.editedActiveCutId ?? null,
        shown,
        saved?.currentTime ?? 0
      )
      if (!pos) return
      editedActiveCutIdRef.current = pos.seg.cut.id
      source = pos.seg.cut.source
      local = pos.local
      out = pos.seg.cut.out
      t = pos.t
    } else if (saved?.previewSource) {
      source = saved.previewSource
      out = getSourceDurationSec(source)
      local = clamp(saved.currentTime, 0, out)
      t = local
    } else {
      // First visit to source view: stay on the frame the edited view shows,
      // on its file — the two views feel continuous.
      const active = cuts.find((c) => c.id === editedActiveCutIdRef.current)
      const v = activeVideo()
      source = active?.source ?? previewSource
      out = getSourceDurationSec(source)
      local = clamp(v && source === previewSource ? v.currentTime : (active?.in ?? 0), 0, out)
      t = local
    }

    currentTimeRef.current = t
    paintTime(t)
    // After the new view has rendered: the lanes are still the old axis now.
    requestAnimationFrame(() => revealPlayhead(t))

    if (source && source !== previewSource) {
      isSourceSwapPendingRef.current = true
      resumePlaybackRef.current = wasPlaying
      playRangeRef.current = { in: local, out }
      const v = activeVideo()
      if (v && !v.paused) v.pause()
      if (!wasPlaying) setIsPlaying(false)
      void loadPreviewFor(source)
      return
    }

    const v = activeVideo()
    if (!v) return
    v.currentTime = local
    resumePlaybackRef.current = wasPlaying
    if (wasPlaying) void v.play()
    else {
      v.pause()
      setIsPlaying(false)
    }
    if (m === 'edited') primeNextSegment()
  }

  /** Switch view — each mode keeps its own playhead position and play/pause state. */
  function switchViewMode(next: 'source' | 'edited') {
    if (next === viewMode) return
    // A range is on one view's clock; it means nothing on the other.
    activeRangeRef.current = null
    captureViewModeState(viewMode)
    setViewMode(next)
    restoreViewModeState(next)
  }

  function togglePlay() {
    const v = activeVideo()
    if (!v) return
    // Play/pause by hand ends a range play (play scene, loop the I–O span).
    activeRangeRef.current = null
    // Mid-load the element is the OLD file, paused on purpose: play() on it
    // would play footage from the wrong file. The load starts or stays
    // stopped as asked.
    if (isSourceSwapPendingRef.current) {
      const play = !resumePlaybackRef.current
      resumePlaybackRef.current = play
      setIsPlaying(play)
      if (play) resumeFollow()
      return
    }
    if (!v.paused) {
      v.pause()
      return
    }
    // Every press of play turns the follow back on — and nothing else does
    // (see the viewport's followOnRef).
    resumeFollow()
    // Rewind when the PLAYHEAD is at the end of the domain being played, not
    // when the <video> element is at the end of its own file. In edited mode
    // the last cut's out-point is nowhere near the source file's duration, so
    // the old `v.currentTime >= v.duration` test never fired: pressing play at
    // the end resumed at a position the sequence had already finished on, and
    // maybeAdvanceEditedSegment paused it again on the next frame — the clip
    // looked stuck (live report 2026-08-13).
    const dur = getActiveDurationSec()
    if (dur > 0 && currentTimeRef.current >= dur - 0.05) {
      applyScrubTime(0, true)
      if (isSourceSwapPendingRef.current) {
        // The first cut lives in another source file; the previewSrc effect
        // starts playback once that file has swapped in.
        resumePlaybackRef.current = true
        return
      }
      const rewound = activeVideo()
      if (rewound) void rewound.play()
      return
    }
    void v.play()
  }

  /** ←/→ and the like: a frame step lands ON the frame grid, so repeated
   * presses from an off-grid position do not drift. (jumpTo does not
   * quantize — cut boundaries are exact.) */
  function nudgePlayhead(deltaSec: number) {
    activeRangeRef.current = null
    applyScrubTime(quantizeToFrame(currentTimeRef.current + deltaSec), true)
  }

  /** Source-lane background click: activate that file (if needed) and seek. */
  function onSourceLanePointerDown(sourceId: string, e: React.PointerEvent) {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest('[data-cut-block]') || target.closest('[data-trim-handle]')) return
    if (sourceId === previewSource) {
      onRulerPointerDown(e)
      return
    }
    // Clamped to the file clicked, not the one on screen.
    const dur = getSourceDurationSec(sourceId)
    const sec = timeAtClientX(e.clientX, dur)
    activeRangeRef.current = null
    const v = activeVideo()
    if (v && !v.paused) v.pause()
    resumePlaybackRef.current = false
    isSourceSwapPendingRef.current = true
    playRangeRef.current = { in: sec, out: dur }
    currentTimeRef.current = sec
    paintTime(sec)
    void loadPreviewFor(sourceId)
  }

  // ---- play range / scene / around / loop -----------------------------------

  /**
   * Playback reached `t` with a range set: stop at its end, or loop back to
   * its start. True when the range took over this frame. The pure decision
   * is rangeStop (playRange.ts).
   */
  function enforceRange(v: HTMLVideoElement, t: number): boolean {
    const range = activeRangeRef.current
    if (!range) return false
    const verdict = rangeStop(t, range, isLoopingRef.current, FRAME_SEC)
    if (!verdict) return false
    if (verdict === 'restart') {
      applyScrubTimeRef.current(range.in, true)
      if (isSourceSwapPendingRef.current) resumePlaybackRef.current = true
      else if (v.paused) void v.play()
      return true
    }
    activeRangeRef.current = null
    v.pause()
    setIsPlaying(false)
    applyScrubTimeRef.current(range.out, true)
    return true
  }

  /** Start playing from wherever the clock is now (after a seek). */
  function startPlayback(): void {
    resumeFollow()
    if (isSourceSwapPendingRef.current) {
      resumePlaybackRef.current = true
      setIsPlaying(true)
      return
    }
    const v = activeVideo()
    if (v) void v.play()
  }

  /** Play [inSec, outSec] on the active view's clock and stop at the end —
   * or loop it. Shift+Space on a scene, Shift+K around a cut, the I–O span. */
  function playRange(inSec: number, outSec: number, opts?: { loop?: boolean }): void {
    const dur = getActiveDurationSec()
    const start = clamp(inSec, 0, dur)
    const end = clamp(outSec, start, dur)
    if (end - start < FRAME_SEC) return
    if (isScrubbingRef.current) return
    // The seek first, then the range: applyScrubTime leaves the range alone
    // (only the user's own seeks clear it — jumpTo, a scrub, a nudge).
    applyScrubTime(start, true)
    activeRangeRef.current = { in: start, out: end, loop: opts?.loop }
    startPlayback()
  }

  function stopRange(): void {
    activeRangeRef.current = null
  }

  /** Play one scene: its edited span, or its window in its own file (loading
   * that file first when it is not the one on screen). */
  function playScene(cutId: string): void {
    const range = sceneRange(cutId, cutsRef.current, editedInById, viewModeRef.current)
    if (!range) return
    if (viewModeRef.current === 'source' && previewSource !== range.source) {
      const cut = cutsRef.current.find((c) => c.id === cutId)
      if (!cut) return
      // The load lands on the first frame; the range and the resume ride on it.
      showCutFrame(cut, cut.in)
      activeRangeRef.current = { in: range.in, out: range.out }
      resumePlaybackRef.current = true
      resumeFollow()
      setIsPlaying(true)
      return
    }
    playRange(range.in, range.out)
  }

  function playAround(sec: number): void {
    const r = playAroundRange(
      sec,
      getActiveDurationSec(),
      PLAY_AROUND_PRE_SEC,
      PLAY_AROUND_POST_SEC
    )
    playRange(r.in, r.out)
  }

  function setLoop(v: boolean): void {
    isLoopingRef.current = v
    setIsLooping(v)
  }

  // ---- hover skim ------------------------------------------------------------

  function setSkimEnabled(v: boolean): void {
    skimEnabledRef.current = v
    if (!v) skimTo(null)
  }

  /** Seek the element to `t` on the active view's clock WITHOUT loading
   * another file and without touching the clock — the skim and its restore.
   * In the edited view, only when the scene at `t` is on the file on screen;
   * the restore reads `t` through the scene the player is ON (the playhead
   * parked on a boundary belongs to the scene ending there, which the
   * segment lookup would hand to the next one). */
  function seekVideoOnScreen(t: number, restore = false): void {
    const v = activeVideo()
    if (!v) return
    let local: number
    if (viewModeRef.current === 'edited') {
      const active = restore ? currentEditedCut() : null
      const activeIn = active ? editedInById.get(active.id) : undefined
      const seg =
        active && activeIn !== undefined
          ? { cut: active, editedIn: activeIn }
          : findSegmentAt(editedSegments, t)
      if (!seg || seg.cut.source !== previewSource) return
      local = clamp(seg.cut.in + (t - seg.editedIn), seg.cut.in, seg.cut.out)
    } else {
      local = clamp(t, 0, getActiveDurationSec())
    }
    // A seek the eye cannot see is a decode for nothing.
    if (Math.abs(v.currentTime - local) < FRAME_SEC / 2) return
    v.currentTime = local
  }

  /**
   * The skimmer: hovering the timeline shows that frame in the preview while
   * the playhead stays put (FCP's skimmer, CapCut's preview axis). One seek
   * per animation frame with the newest position; never while the player is
   * busy (canSkim); never loads another file — a scene on another file just
   * does not skim. `null` (the pointer left) puts the playhead's frame back.
   */
  function skimTo(sec: number | null): void {
    if (twoUpRef.current) return
    const may = canSkim({
      playing: isPlayingNow(),
      scrubbing: isScrubbingRef.current,
      editing: isCutBlockEditingRef.current,
      swapPending: isSourceSwapPendingRef.current,
      enabled: skimEnabledRef.current || sec === null
    })
    if (!may) return
    skimPendingRef.current = sec
    if (skimFrameRef.current) return
    skimFrameRef.current = requestAnimationFrame(() => {
      skimFrameRef.current = 0
      const target = skimPendingRef.current
      skimPendingRef.current = undefined
      if (target === undefined) return
      if (target === null) {
        skimShowingRef.current = false
        seekVideoOnScreen(currentTimeRef.current, true)
      } else {
        skimShowingRef.current = true
        seekVideoOnScreen(target)
      }
    })
  }

  // ---- two-up preview (roll / slip) ------------------------------------------

  /**
   * Show two frames side by side while a junction is dragged: the outgoing
   * last frame in the inactive element, the incoming first frame in the
   * active one. The inactive element is made to hold the outgoing scene's
   * file (the pre-seeked next-scene buffer in it is spent — primeNextSegment
   * re-primes after endTwoUp). Which element is the incoming (right) pane is
   * published as `twoUpIncoming` for PreviewPane's two-up layout.
   */
  function beginTwoUp(cut: WorkingCut, outgoing?: WorkingCut): void {
    if (twoUpRef.current) return
    const v = activeVideo()
    if (v && !v.paused) v.pause()
    setIsPlaying(false)
    skimPendingRef.current = undefined
    twoUpRef.current = { leftSec: null, rightSec: null, frame: 0 }
    bufferPrimedKeyRef.current = null
    if (previewSource !== cut.source) showCutFrame(cut, cut.in)
    const buf = inactiveVideo()
    const leftSource = outgoing?.source ?? cut.source
    setTwoUpIncoming(activeVideoKeyRef.current)
    if (buf) {
      // Both panes visible; PreviewPane puts the outgoing one on the left.
      buf.style.opacity = '1'
      buf.style.zIndex = '1'
      void (async () => {
        try {
          const src = await ensureSourceSrc(leftSource)
          if (!twoUpRef.current) return
          if (buf.src !== absoluteUrl(src)) buf.src = src
          const pending = twoUpRef.current.leftSec
          if (pending !== null) {
            const seekTo = (): void => {
              buf.currentTime = pending
            }
            if (buf.readyState >= 1) seekTo()
            else buf.addEventListener('loadedmetadata', seekTo, { once: true })
          }
        } catch {
          /* the pane stays on whatever it had */
        }
      })()
    }
    setTwoUp(true)
  }

  function paintTwoUp(leftSec: number, rightSec: number): void {
    const state = twoUpRef.current
    if (!state) return
    const changed = state.leftSec !== leftSec || state.rightSec !== rightSec
    state.leftSec = leftSec
    state.rightSec = rightSec
    if (!changed || state.frame) return
    // One seek per frame per element, skipping a time it is already on.
    state.frame = requestAnimationFrame(() => {
      state.frame = 0
      if (twoUpRef.current !== state) return
      const v = activeVideo()
      const buf = inactiveVideo()
      if (state.rightSec !== null) {
        if (isSourceSwapPendingRef.current && playRangeRef.current) {
          // The incoming file is still loading: it lands on the newest frame.
          playRangeRef.current = { ...playRangeRef.current, in: state.rightSec }
        } else if (v && Math.abs(v.currentTime - state.rightSec) >= FRAME_SEC / 2) {
          v.currentTime = state.rightSec
        }
      }
      if (
        buf &&
        state.leftSec !== null &&
        buf.readyState >= 1 &&
        Math.abs(buf.currentTime - state.leftSec) >= FRAME_SEC / 2
      ) {
        buf.currentTime = state.leftSec
      }
    })
  }

  function endTwoUp(): void {
    const state = twoUpRef.current
    if (!state) return
    if (state.frame) cancelAnimationFrame(state.frame)
    twoUpRef.current = null
    applyVideoVisibility()
    setTwoUp(false)
    // The inactive element holds a file of the drag's choosing now.
    bufferPrimedKeyRef.current = null
    // Back to the playhead's frame through whatever scene is under it now.
    seekActiveTime(currentTimeRef.current)
    primeNextSegment()
  }

  // ---- touch scrub -----------------------------------------------------------

  /**
   * The strip was swiped under the pinned playhead (useTimelineViewport's
   * onTouchScrub): pause on the first event, scrub once per frame, resume
   * after the scrolling has been quiet for a moment — a swipe is a scrub,
   * exactly CapCut mobile.
   */
  function onTouchScrub(t: number): void {
    if (!isScrubbingRef.current) pauseForScrub()
    touchScrubTRef.current = t
    if (!touchScrubFrameRef.current) {
      touchScrubFrameRef.current = requestAnimationFrame(() => {
        touchScrubFrameRef.current = 0
        applyScrubTimeRef.current(touchScrubTRef.current, true)
      })
    }
    window.clearTimeout(touchScrubTimerRef.current)
    touchScrubTimerRef.current = window.setTimeout(() => {
      if (touchScrubFrameRef.current) {
        cancelAnimationFrame(touchScrubFrameRef.current)
        touchScrubFrameRef.current = 0
        applyScrubTimeRef.current(touchScrubTRef.current, true)
      }
      resumeAfterScrub()
    }, TOUCH_SCRUB_RESUME_MS)
  }

  return {
    videoARef,
    videoBRef,
    captionOverlayRef,
    holdFrameRef,
    playRangeRef,
    editedActiveCutIdRef,
    resumePlaybackRef,
    isSourceSwapPendingRef,
    isPlaying,
    setIsPlaying,
    previewSrc,
    setPreviewSrc,
    activeVideo,
    loadPreviewFor,
    selectCut,
    showCutFrame,
    applyScrubTime,
    jumpTo,
    goToCutStart,
    shuttleFaster,
    shuttleStop,
    shuttleBack,
    playbackRateRef,
    pauseForScrub,
    resumeAfterScrub,
    onRulerPointerDown,
    onLaneBackgroundPointerDown,
    onSourceLanePointerDown,
    togglePlay,
    nudgePlayhead,
    switchViewMode,
    syncCaptionOverlay,
    isActiveVideoEvent,
    onTimeUpdate,
    onVideoLoadedMetadata,
    syncTimeFromVideo,
    onVideoEnded,
    onVideoPaused,
    skimTo,
    setSkimEnabled,
    playRange,
    stopRange,
    playScene,
    playAround,
    isLooping,
    setLoop,
    beginTwoUp,
    paintTwoUp,
    endTwoUp,
    twoUp,
    twoUpIncoming,
    onTouchScrub
  }
}
