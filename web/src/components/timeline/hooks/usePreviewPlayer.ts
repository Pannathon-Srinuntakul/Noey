import { useEffect, useRef, useState } from 'react'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import {
  editorApi,
  formatUserError,
  type CaptionLine,
  type EditTimeline
} from '../../../lib/editorApi'
import {
  clamp,
  computeEditedDuration,
  computeEditedSegments,
  findSegmentAt,
  type EditedSegment
} from '../../../lib/timelineMath'
import { editedTimeIn, resolveEditedPosition, sceneIsOver } from '../previewMath'
import type { WorkingCut } from '../types'
import type { TimelineViewportApi } from './useTimelineViewport'

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
function absoluteUrl(src: string): string {
  try {
    return new URL(src, document.baseURI).href
  } catch {
    return src
  }
}

export function usePreviewPlayer({
  uid,
  timeline,
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
  videoDuration,
  setVideoDuration,
  currentTimeRef,
  captionLinesRef,
  captionsOnOutputClock,
  isCutBlockEditingRef,
  getSourceDurationSec,
  getActiveDurationSec,
  viewport: { paintTime, followPlayhead, resumeFollow, revealPlayhead, timeAtClientX, pxPerSec },
  syncMusicAudio,
  setError,
  setErrorRetry
}: {
  uid: string
  timeline: EditTimeline | null
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
  videoDuration: number
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

  useEffect(() => {
    return () => {
      previewCache.current.forEach((v) => v.cleanup())
      previewCache.current.clear()
      window.clearTimeout(holdTimerRef.current)
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
    const v = activeVideo()
    if (!v || !previewSrc) return
    const activeId = editedActiveCutIdRef.current
    const active = cuts.find((c) => c.id === activeId)
    const shownTime = active && active.source === previewSource ? v.currentTime : null
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
  useEffect(() => {
    if (!isPlaying) return
    let raf = 0
    const tick = () => {
      const v = activeVideo()
      if (v && !v.paused && !isScrubbingRef.current && !isSourceSwapPendingRef.current) {
        if (viewMode === 'edited' && maybeAdvanceEditedSegment(v)) {
          raf = requestAnimationFrame(tick)
          return
        }
        // Neither the selection nor the active scene is re-derived from `t`
        // here: `t` is computed FROM the active scene, and the selection is
        // the user's (see syncTimeFromVideo).
        const t =
          viewMode === 'edited'
            ? editedTimeOfVideo(v)
            : clamp(v.currentTime, 0, getActiveDurationSec())
        currentTimeRef.current = t
        paintTime(t)
        followPlayhead(t)
        syncMusicAudio(t, true)
        syncCaptionOverlay()
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [isPlaying, previewSrc, previewSource, videoDuration, timeline, viewMode, cuts, pxPerSec])

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
    const idx = cuts.findIndex((c) => c.id === cut.id)
    const next = cuts[idx + 1]
    if (!next) {
      v.pause()
      setIsPlaying(false)
      const dur = computeEditedDuration(cuts)
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
    currentTimeRef.current = t
    paintTime(t)
    if (seekVideo) seekActiveTime(t)
    syncMusicAudio(t, false)
  }

  function pauseForScrub() {
    const v = activeVideo()
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

  /** Ruler / playhead-grip drag: scrub while moving, commit + resume on release. */
  function onRulerPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return
    e.preventDefault()
    pauseForScrub()
    applyScrubTime(timeAtClientX(e.clientX), true)
    // One seek per frame: every move used to seek the video, set state and
    // read layout, which is most of why scrubbing felt sticky.
    let lastX = e.clientX
    let frame = 0
    const onMove = (ev: PointerEvent) => {
      lastX = ev.clientX
      if (frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        applyScrubTimeRef.current(timeAtClientX(lastX), true)
      })
    }
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      if (frame) window.cancelAnimationFrame(frame)
      applyScrubTimeRef.current(timeAtClientX(ev.clientX), true)
      resumeAfterScrub()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
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
    const onLoaded = () => {
      const range = playRangeRef.current
      if (!range) {
        releaseHeldFrame()
        return
      }
      v.currentTime = range.in
      // The held frame goes once the new file shows its own: `seeked`, then
      // two frames for the compositor to put it on screen.
      v.addEventListener(
        'seeked',
        () => requestAnimationFrame(() => requestAnimationFrame(releaseHeldFrame)),
        { once: true }
      )
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
    return () => v.removeEventListener('loadedmetadata', onLoaded)
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
      viewMode === 'edited' &&
      v &&
      !v.paused &&
      !isScrubbingRef.current &&
      !isSourceSwapPendingRef.current &&
      !isCutBlockEditingRef.current &&
      maybeAdvanceEditedSegment(v)
    )
      return
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
    if (v?.ended && viewModeRef.current === 'edited') {
      endedWhilePlayingRef.current = true
      return
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
    captureViewModeState(viewMode)
    setViewMode(next)
    restoreViewModeState(next)
  }

  function togglePlay() {
    const v = activeVideo()
    if (!v) return
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

  function nudgePlayhead(deltaSec: number) {
    applyScrubTime(currentTimeRef.current + deltaSec, true)
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
    const v = activeVideo()
    if (v && !v.paused) v.pause()
    resumePlaybackRef.current = false
    isSourceSwapPendingRef.current = true
    playRangeRef.current = { in: sec, out: dur }
    currentTimeRef.current = sec
    paintTime(sec)
    void loadPreviewFor(sourceId)
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
    onVideoPaused
  }
}
