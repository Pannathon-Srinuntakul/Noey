import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import { paintSeekProgress } from '../../../lib/seekProgress'
import { BASE_PX_PER_SEC, clamp, fmtTime, fmtTimeTenths } from '../../../lib/timelineMath'
import {
  createTimelineViewportStore,
  type TimelineViewportStore
} from '../../../lib/timelineViewport'
import { HEADER_COL_PX, MAX_PX_PER_SEC, MIN_LANE_PX, MIN_PX_PER_SEC, TAIL_PX } from '../constants'
import { followScrollLeft } from '../previewMath'
import type { WorkingCut } from '../types'

export interface TimelineViewportApi {
  pxPerSec: number
  setPxPerSec: Dispatch<SetStateAction<number>>
  /** pxPerSec for window-level drag handlers, which outlive a render. */
  pxPerSecRef: RefObject<number>
  viewportRef: RefObject<HTMLDivElement | null>
  playheadRef: RefObject<HTMLDivElement | null>
  playheadLineRef: RefObject<HTMLDivElement | null>
  seekbarRef: RefObject<HTMLInputElement | null>
  timeLabelRef: RefObject<HTMLSpanElement | null>
  /** Set while the seekbar is being dragged, so paintTime leaves it alone. */
  isScrubbingSeekbarRef: RefObject<boolean>
  viewportStore: TimelineViewportStore
  getContentWidthPx: () => number
  paintTime: (t: number) => void
  followPlayhead: (t: number) => void
  resumeFollow: () => void
  revealPlayhead: (t: number) => void
  onViewportScroll: () => void
  timeAtClientX: (clientX: number, maxSec?: number) => number
  fitToScreen: () => void
  queueScrollShift: (px: number) => void
}

/**
 * Where the timeline is looking and how time is drawn on it: the zoom, the
 * one scroll container, auto-follow of the playhead, and the playhead, seekbar
 * and clock painted straight to the DOM — never through React state, which
 * would re-render the whole editor per frame.
 */
export function useTimelineViewport({
  editorPhase,
  viewMode,
  cuts,
  videoDuration,
  currentTimeRef,
  getActiveDurationSec,
  getAxisDurationSec,
  onPaint
}: {
  editorPhase: 'loading' | 'preparing' | 'ready'
  viewMode: 'source' | 'edited'
  cuts: WorkingCut[]
  videoDuration: number
  currentTimeRef: RefObject<number>
  /** The playhead's domain — see the editor's getActiveDurationSec. */
  getActiveDurationSec: () => number
  /** The axis the lanes are drawn to — see the editor's getAxisDurationSec. */
  getAxisDurationSec: () => number
  /** Called after every paint with the time painted: the one way the moving
   * clock reaches React, for whatever must re-render when it crosses into
   * something new. Runs per frame while playing, so it must stay cheap and a
   * stable function (useStableCallback). */
  onPaint: (t: number) => void
}): TimelineViewportApi {
  // Zoom — px per second of timeline. State (not a constant) because of the
  // px/วิ slider, พอดีจอ and Alt+wheel. Filmstrip tile math stays anchored to
  // BASE_PX_PER_SEC so zooming never regenerates thumbnails.
  const [pxPerSec, setPxPerSec] = useState(BASE_PX_PER_SEC)
  const pxPerSecRef = useRef(BASE_PX_PER_SEC)
  useEffect(() => {
    pxPerSecRef.current = pxPerSec
  }, [pxPerSec])
  // The one scroll container (ruler + lanes share it; labels are sticky-left).
  const viewportRef = useRef<HTMLDivElement>(null)
  // Playhead line + transport widgets, all painted imperatively per frame.
  const playheadRef = useRef<HTMLDivElement>(null)
  /** The playhead's visible rule, drawn on its own layer ABOVE the scene
   * blocks and trim handles — see the playhead markup. */
  const playheadLineRef = useRef<HTMLDivElement>(null)
  const seekbarRef = useRef<HTMLInputElement>(null)
  const timeLabelRef = useRef<HTMLSpanElement>(null)
  // Scroll is published to the lanes imperatively so it never re-renders the
  // timeline; the store is per-mount so nothing survives a close/reopen.
  const viewportStore = useMemo(() => createTimelineViewportStore(), [])

  /** Width of the drawable timeline content (excludes the sticky label column). */
  function getContentWidthPx(): number {
    const axis = getAxisDurationSec()
    // Room to scroll past the end, like any editor. A left-edge trim keeps the
    // handle under the pointer by scrolling (trimCut); with only a short tail
    // the scroll ran out near the end — the voiceover lane can already reach
    // past the last scene — and the handle drifted off the pointer.
    const tail = Math.max(TAIL_PX, Math.round((viewportRef.current?.clientWidth ?? 0) / 2))
    return Math.max(axis * pxPerSec, MIN_LANE_PX) + tail
  }

  /** Paint the playhead line + transport clock + seekbar for time `t` — all
   * imperative; React hears about it only through `onPaint`. */
  function paintTime(t: number) {
    const px = pxPerSecRef.current
    if (playheadRef.current) {
      playheadRef.current.style.transform = `translateX(${HEADER_COL_PX + t * px}px)`
    }
    if (playheadLineRef.current) {
      playheadLineRef.current.style.transform = `translateX(${HEADER_COL_PX + t * px}px)`
    }
    if (seekbarRef.current && !isScrubbingSeekbarRef.current) {
      seekbarRef.current.value = String(t)
      // The value is written straight to the DOM, so the played-portion fill
      // has to be pushed the same way — React never re-renders this input.
      paintSeekProgress(seekbarRef.current)
    }
    if (timeLabelRef.current) {
      // The clock reads in tenths, so most frames would write the same text
      // again; a DOM write it does not need is skipped.
      const label = `${fmtTimeTenths(t)} / ${fmtTime(getActiveDurationSec())}`
      if (timeLabelRef.current.textContent !== label) timeLabelRef.current.textContent = label
    }
    onPaint(t)
  }
  const isScrubbingSeekbarRef = useRef(false)

  /**
   * Whether the timeline follows the playhead — the way a normal editor does
   * it: on while playing, off the moment the user scrolls or zooms the
   * timeline by hand, and back on only with the next press of play.
   *
   * It used to come back by itself after four seconds, and on every scene
   * click and every source load — so the view was yanked away from wherever
   * the user had scrolled to look, often while they were about to click
   * there (owner, 2026-09-21).
   */
  const followOnRef = useRef(false)

  /** Turn the follow on — play calls this, nothing else. */
  function resumeFollow(): void {
    followOnRef.current = true
  }

  /** Set while this hook itself writes scrollLeft, so the scroll event it
   * causes is not mistaken for the user scrolling. */
  const autoScrollingRef = useRef(false)

  function scrollToPlayhead(t: number): void {
    const el = viewportRef.current
    if (!el) return
    const next = followScrollLeft(
      HEADER_COL_PX + t * pxPerSecRef.current,
      el.scrollLeft,
      el.clientWidth,
      HEADER_COL_PX
    )
    if (next === null || next === el.scrollLeft) return
    autoScrollingRef.current = true
    el.scrollLeft = next
    // Cleared after the scroll event this write queues has been delivered.
    requestAnimationFrame(() => {
      autoScrollingRef.current = false
    })
  }

  /** While playing: keep the playhead on screen a page at a time. */
  function followPlayhead(t: number): void {
    if (followOnRef.current) scrollToPlayhead(t)
  }

  /** Bring the playhead on screen once, without turning the follow on — for a
   * view switch, where the whole axis changes under the user. */
  function revealPlayhead(t: number): void {
    scrollToPlayhead(t)
  }

  /** One scroll listener for the viewport: a scroll this hook did not cause
   * is the user looking around, and turns the follow off. */
  function onViewportScroll(): void {
    if (autoScrollingRef.current) return
    followOnRef.current = false
  }

  // Zooming (the slider, พอดีจอ, Alt+wheel) is the user arranging the view
  // too, and the follow would undo it on the next frame.
  useEffect(() => {
    followOnRef.current = false
  }, [pxPerSec])

  /** clientX → timeline seconds, via the scroll container's content box —
   * clamped to the playhead's domain, or to `maxSec` when the caller is
   * about to move into another one (a click on another file's lane: clamped
   * to the file on screen, 0:45 on a 60 s file opened it at 0:20). */
  function timeAtClientX(clientX: number, maxSec?: number): number {
    const el = viewportRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    const contentX = clientX - rect.left + el.scrollLeft - HEADER_COL_PX
    return clamp(contentX / pxPerSecRef.current, 0, maxSec ?? getActiveDurationSec())
  }

  /**
   * Alt+wheel zoom, anchored so the time under the cursor stays put.
   *
   * Bound natively rather than through `onWheel`: React registers its root
   * wheel listener as PASSIVE, so `preventDefault` inside a synthetic handler
   * is ignored (Chrome logs "Unable to preventDefault inside passive event
   * listener") and the browser scrolls the viewport underneath the zoom — the
   * anchor arithmetic then lands the wrong time under the pointer.
   */
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    function onWheel(e: WheelEvent): void {
      if (!e.altKey) return
      e.preventDefault()
      const node = viewportRef.current
      if (!node) return
      const anchorTime = timeAtClientX(e.clientX)
      const factor = Math.pow(1.0015, -e.deltaY)
      const next = clamp(pxPerSecRef.current * factor, MIN_PX_PER_SEC, MAX_PX_PER_SEC)
      const rect = node.getBoundingClientRect()
      const pointerVX = e.clientX - rect.left
      setPxPerSec(next)
      // scrollLeft so that anchorTime lands back under the pointer.
      requestAnimationFrame(() => {
        node.scrollLeft = Math.max(0, HEADER_COL_PX + anchorTime * next - pointerVX)
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  function fitToScreen() {
    const el = viewportRef.current
    const dur = getAxisDurationSec()
    if (!el || dur <= 0) return
    const usable = Math.max(el.clientWidth - HEADER_COL_PX - TAIL_PX, 120)
    setPxPerSec(clamp(usable / dur, MIN_PX_PER_SEC, MAX_PX_PER_SEC))
    el.scrollLeft = 0
  }

  // Zoom or view-mode change moves where the playhead must be drawn.
  useEffect(() => {
    paintTime(currentTimeRef.current)
  }, [pxPerSec, viewMode, editorPhase, cuts, videoDuration])

  // Publish the scroll position to the filmstrip lanes.
  //
  // Deliberately NOT React state: a `setState` per scroll frame re-renders a
  // 4,000-line timeline to move some thumbnails, which is most of what made
  // scrolling stutter. The lanes subscribe and redraw their own canvas; nothing
  // else in the tree hears about it. A ResizeObserver covers the window being
  // resized without a scroll, which would otherwise leave lanes drawn to the
  // old viewport width.
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const publish = (): void => {
      viewportStore.set({ scrollLeft: el.scrollLeft, viewportWidth: el.clientWidth })
    }
    publish()
    el.addEventListener('scroll', publish, { passive: true })
    const ro = new ResizeObserver(publish)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', publish)
      ro.disconnect()
    }
  }, [viewportStore, editorPhase, viewMode])

  /**
   * Scroll owed to a left-edge trim (see trimCut in the editor): the block
   * grows to the right, and the lane scrolls by the same amount so the
   * handle stays under the pointer. Applied once the cut list that caused
   * it has rendered, before paint, so the grown block is never shown
   * unscrolled.
   */
  const pendingScrollShiftPxRef = useRef(0)
  function queueScrollShift(px: number): void {
    pendingScrollShiftPxRef.current += px
  }
  useLayoutEffect(() => {
    const shift = pendingScrollShiftPxRef.current
    if (shift === 0) return
    pendingScrollShiftPxRef.current = 0
    const el = viewportRef.current
    if (el) el.scrollLeft += shift
  }, [cuts])

  return {
    pxPerSec,
    setPxPerSec,
    pxPerSecRef,
    viewportRef,
    playheadRef,
    playheadLineRef,
    seekbarRef,
    timeLabelRef,
    isScrubbingSeekbarRef,
    viewportStore,
    getContentWidthPx,
    paintTime,
    followPlayhead,
    resumeFollow,
    revealPlayhead,
    onViewportScroll,
    timeAtClientX,
    fitToScreen,
    queueScrollShift
  }
}
