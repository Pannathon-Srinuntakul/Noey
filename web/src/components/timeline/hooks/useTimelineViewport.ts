import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import type { DragScroller } from '../../../lib/pointerDrag'
import { paintSeekProgress } from '../../../lib/seekProgress'
import { BASE_PX_PER_SEC, clamp, fmtTime, fmtTimeTenths } from '../../../lib/timelineMath'
import {
  createTimelineViewportStore,
  type TimelineViewportStore
} from '../../../lib/timelineViewport'
import {
  DRAG_AUTOSCROLL_EDGE_PX,
  DRAG_AUTOSCROLL_MAX_PX,
  FLASH_MS,
  HEADER_COL_PX,
  MAX_PX_PER_SEC,
  MIN_LANE_PX,
  MIN_PX_PER_SEC,
  TAIL_PX
} from '../constants'
import { followScrollLeft } from '../previewMath'
import type { WorkingCut } from '../types'
import {
  anchoredScrollLeft,
  autoScrollStep,
  centreTime,
  centredScrollLeft,
  edgeHint,
  fitPxPerSec,
  flashKeyframes,
  leadPxFor,
  pinchFactor,
  rangeZoom,
  timeFromScroll
} from '../viewportMath'

export interface TimelineViewportApi {
  pxPerSec: number
  /** Manual zoom (the slider): also forgets the fit-toggle memory. */
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
  /** The off-screen playhead pill (Playhead.tsx): paintTime sets its
   * `data-side` to 'left' | 'right' or removes it. */
  edgeHintRef: RefObject<HTMLDivElement | null>
  viewportStore: TimelineViewportStore
  getContentWidthPx: () => number
  paintTime: (t: number) => void
  followPlayhead: (t: number) => void
  resumeFollow: () => void
  revealPlayhead: (t: number) => void
  revealAndFlashCut: (cutId: string) => void
  /** Scroll to the first, ring every one — a batch delete, a paste, a multi-move. */
  revealAndFlashCuts: (cutIds: string[]) => void
  onViewportScroll: () => void
  timeAtClientX: (clientX: number, maxSec?: number) => number
  fitToScreen: () => void
  /** Whether the view is the fit view (fitToScreen / fitToggle) and nothing
   * has zoomed or scrolled it since. */
  isFitted: boolean
  /** Fit ⇄ the zoom before the fit (Premiere \, Resolve Shift+Z). */
  fitToggle: () => void
  /** Zoom by `factor` about `anchorSec` — the playhead when on screen, else
   * the centre of the view — so the thing being looked at stays put. */
  zoomAround: (factor: number, anchorSec?: number) => void
  /** Zoom so [inSec, outSec] fills the view with `padPx` either side ('พอดีฉาก'). */
  zoomToRange: (inSec: number, outSec: number, padPx?: number) => void
  queueScrollShift: (px: number) => void
  /** Edge auto-scroll for a drag (lib/pointerDrag's scroller slot). */
  dragScroll: DragScroller
  /** A touch-first pointer (matchMedia 'pointer: coarse'). */
  coarse: boolean
  /** Phone-width touch: the playhead is pinned and the strip scrolls under it. */
  touchScrub: boolean
  /** Padding before time 0 that pins the playhead at the centre (touchScrub
   * only; 0 on desktop). The editor applies it as padding-left on the
   * timeline content and hands it to everything that draws on the axis. */
  leadPx: number
}

/** matchMedia that is safe where it does not exist (tests, old engines). */
function mediaMatches(query: string): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query).matches
    : false
}

function prefersReducedMotion(): boolean {
  return mediaMatches('(prefers-reduced-motion: reduce)')
}

/** Follow one media query as React state. */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => mediaMatches(query))
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(query)
    const onChange = (): void => setMatches(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])
  return matches
}

/** The pointer's pinch can only be told from a two-finger scroll by its
 * change in distance; below this it is a scroll and the zoom leaves it be. */
const PINCH_MIN_DELTA_PX = 6
/** After the last user scroll in touch-scrub mode, the playhead paint may
 * write scrollLeft again (until then it would fight the finger). */
const TOUCH_SCRUB_IDLE_MS = 150

/**
 * Where the timeline is looking and how time is drawn on it: the zoom, the
 * one scroll container, auto-follow of the playhead, and the playhead, seekbar
 * and clock painted straight to the DOM — never through React state, which
 * would re-render the whole editor per frame.
 *
 * Two timeline models live here. Desktop: the timeline is static and the
 * playhead moves over it, the view following a page at a time while playing.
 * Phone-width touch (`touchScrub`): the playhead is pinned at the centre and
 * the strip scrolls under it — a swipe IS a scrub (CapCut mobile), and the
 * view follows every frame by scrolling.
 */
export function useTimelineViewport({
  editorPhase,
  viewMode,
  cuts,
  videoDuration,
  currentTimeRef,
  getActiveDurationSec,
  getAxisDurationSec,
  onPaint,
  onTouchScrub
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
  /** Touch-scrub mode: the user scrolled the strip, and the playhead is now
   * over `t`. The player pauses, scrubs, and resumes once the scrolling
   * stops. Stable function (useStableCallback). */
  onTouchScrub?: (t: number) => void
}): TimelineViewportApi {
  // Zoom — px per second of timeline. State (not a constant) because of the
  // px/วิ slider, พอดีจอ and the wheel/pinch zoom. Filmstrip tile math stays
  // anchored to BASE_PX_PER_SEC so zooming never regenerates thumbnails.
  const [pxPerSec, setPxPerSecRaw] = useState(BASE_PX_PER_SEC)
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
  const edgeHintRef = useRef<HTMLDivElement | null>(null)
  // Scroll is published to the lanes imperatively so it never re-renders the
  // timeline; the store is per-mount so nothing survives a close/reopen.
  const viewportStore = useMemo(() => createTimelineViewportStore(), [])

  // ---- touch model ---------------------------------------------------------
  const coarse = useMediaQuery('(pointer: coarse)')
  const narrow = useMediaQuery('(max-width: 1023px)')
  const touchScrub = coarse && narrow
  const touchScrubRef = useRef(touchScrub)
  touchScrubRef.current = touchScrub
  // The lead depends on the viewport width, which only the DOM knows; kept as
  // state (it is layout the editor renders) and refreshed by the resize
  // observer below.
  const [leadPx, setLeadPx] = useState(0)
  const leadPxRef = useRef(0)
  leadPxRef.current = leadPx
  useLayoutEffect(() => {
    const el = viewportRef.current
    const next = leadPxFor(el?.clientWidth ?? 0, HEADER_COL_PX, touchScrub)
    if (next !== leadPxRef.current) {
      leadPxRef.current = next
      setLeadPx(next)
    }
  }, [touchScrub, editorPhase, viewMode])

  /** Width of the drawable timeline content (excludes the sticky label column). */
  function getContentWidthPx(): number {
    const axis = getAxisDurationSec()
    const clientWidth = viewportRef.current?.clientWidth ?? 0
    // Room to scroll past the end, like any editor. A left-edge trim keeps the
    // handle under the pointer by scrolling (trimCut); with only a short tail
    // the scroll ran out near the end — the voiceover lane can already reach
    // past the last scene — and the handle drifted off the pointer. In
    // touch-scrub mode the last second must be able to reach the pinned
    // playhead at the centre, so the tail is at least half the viewport plus
    // the lead.
    const tail = Math.max(
      TAIL_PX,
      Math.round(clientWidth / 2),
      touchScrubRef.current ? Math.round(clientWidth / 2) + leadPxRef.current : 0
    )
    return Math.max(axis * pxPerSec, MIN_LANE_PX) + tail
  }

  /** Content x of time `t` — where the playhead and every guide draw. */
  function xOfTime(t: number, px = pxPerSecRef.current): number {
    return HEADER_COL_PX + leadPxRef.current + t * px
  }

  /** Paint the playhead line + transport clock + seekbar for time `t` — all
   * imperative; React hears about it only through `onPaint`. */
  function paintTime(t: number): void {
    const px = pxPerSecRef.current
    const x = xOfTime(t, px)
    const transform = `translateX(${x}px)`
    const head = playheadRef.current
    if (head) {
      head.style.transform = transform
      // The head is a slider to assistive tech (Playhead.tsx puts the role on
      // it); its value is written here, the one place the clock is painted.
      head.setAttribute('aria-valuenow', String(Math.round(t * 1000) / 1000))
      head.setAttribute('aria-valuemax', String(Math.round(getActiveDurationSec() * 1000) / 1000))
      head.setAttribute('aria-valuetext', fmtTimeTenths(t))
    }
    if (playheadLineRef.current) {
      playheadLineRef.current.style.transform = transform
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
    const el = viewportRef.current
    if (el && touchScrubRef.current) {
      // Pinned playhead: the strip scrolls so `t` sits under it — unless the
      // finger is the one scrolling right now, in which case the scroll IS
      // the source of `t` and writing it back would fight the swipe.
      if (!touchScrubLiveRef.current && !pinchRef.current) {
        const next = centredScrollLeft(t, px)
        if (Math.abs(el.scrollLeft - next) >= 0.5) {
          autoScrollingRef.current = true
          el.scrollLeft = next
          requestAnimationFrame(() => {
            autoScrollingRef.current = false
          })
        }
      }
    }
    const hint = edgeHintRef.current
    if (hint && el) {
      const side = touchScrubRef.current
        ? null
        : edgeHint(x, el.scrollLeft, el.clientWidth, HEADER_COL_PX)
      if (side) {
        if (hint.dataset.side !== side) hint.dataset.side = side
      } else if (hint.dataset.side !== undefined) {
        delete hint.dataset.side
      }
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

  /** Write scrollLeft as the hook's own scroll (see autoScrollingRef). */
  function autoScrollTo(el: HTMLElement, next: number): void {
    if (next === el.scrollLeft) return
    autoScrollingRef.current = true
    el.scrollLeft = next
    // Cleared after the scroll event this write queues has been delivered.
    requestAnimationFrame(() => {
      autoScrollingRef.current = false
    })
  }

  function scrollToPlayhead(t: number): void {
    const el = viewportRef.current
    if (!el) return
    if (touchScrubRef.current) {
      // The pinned model centres on every paint; a reveal is the same write.
      autoScrollTo(el, centredScrollLeft(t, pxPerSecRef.current))
      return
    }
    const next = followScrollLeft(xOfTime(t), el.scrollLeft, el.clientWidth, HEADER_COL_PX)
    if (next === null) return
    autoScrollTo(el, next)
  }

  /** While playing: keep the playhead on screen a page at a time. Not while
   * a drag is auto-scrolling — nothing else may move the lane under a drag. */
  function followPlayhead(t: number): void {
    if (dragActiveRef.current) return
    if (followOnRef.current) scrollToPlayhead(t)
  }

  /** Bring the playhead on screen once, without turning the follow on — for a
   * view switch, where the whole axis changes under the user. */
  function revealPlayhead(t: number): void {
    if (dragActiveRef.current) return
    scrollToPlayhead(t)
  }

  /** The block's ring. Nothing under prefers-reduced-motion (the reveal
   * scroll still happens — that is the end state, not an animation). */
  function flash(node: HTMLElement): void {
    const keyframes = flashKeyframes(prefersReducedMotion())
    if (keyframes.length === 0) return
    node.animate?.(keyframes, { duration: FLASH_MS, easing: 'ease-out' })
  }

  /** Nudge the view so `node` is on screen: a block already in view is not
   * moved, a block wider than the view is pulled only far enough to show its
   * LEFT edge (scrolling to its right edge would hide its start). */
  function revealNode(el: HTMLElement, node: HTMLElement): void {
    const view = el.getBoundingClientRect()
    const box = node.getBoundingClientRect()
    // The sticky label column covers the left of the viewport — a block
    // under it is not on screen.
    const left = view.left + HEADER_COL_PX + 8
    const right = view.right - 8
    let delta = 0
    if (box.left < left) delta = box.left - left
    else if (box.right > right) delta = Math.min(box.right - right, box.left - left)
    if (delta !== 0) autoScrollTo(el, el.scrollLeft + delta)
  }

  /**
   * Bring scene blocks on screen and flash their borders — the answer an
   * edit owes the eye. An added scene, an undone one or an AI re-edit could
   * all land off screen, and the editor went on looking exactly as it did
   * before (the edit had happened; nothing said so).
   *
   * It NUDGES, the way `scrollIntoView({ block: 'nearest' })` does: a block
   * already in view is not moved, so this never yanks the view away from what
   * the user was looking at. The scroll is the hook's own, so the follow stays
   * off (autoScrollingRef). With several ids the view goes to the FIRST and
   * every one gets the ring.
   *
   * Deferred two frames: the cut list that produced the block has to render
   * and lay out before there is a node to scroll to.
   */
  function revealAndFlashCuts(cutIds: string[]): void {
    if (cutIds.length === 0) return
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const el = viewportRef.current
        if (!el) return
        const nodes = cutIds
          .map((id) => el.querySelector<HTMLElement>(`[data-cut-id="${id}"]`))
          .filter((n): n is HTMLElement => !!n)
        if (nodes.length === 0) return
        revealNode(el, nodes[0])
        // A ring rather than a class: nothing about this belongs in React
        // state, and the block is memo()'d on props that did not change.
        for (const node of nodes) flash(node)
      })
    )
  }

  function revealAndFlashCut(cutId: string): void {
    revealAndFlashCuts([cutId])
  }

  // ---- touch scrub: the user's scroll IS the scrub --------------------------
  /** Set from the first user scroll event in touch-scrub mode until the
   * scrolling has been idle for TOUCH_SCRUB_IDLE_MS. */
  const touchScrubLiveRef = useRef(false)
  const touchScrubIdleTimerRef = useRef<number | undefined>(undefined)
  const onTouchScrubRef = useRef(onTouchScrub)
  onTouchScrubRef.current = onTouchScrub
  useEffect(() => () => window.clearTimeout(touchScrubIdleTimerRef.current), [])

  /** One scroll listener for the viewport: a scroll this hook did not cause
   * is the user looking around, and turns the follow off (and, on a phone,
   * moves the playhead). */
  function onViewportScroll(): void {
    if (autoScrollingRef.current) return
    followOnRef.current = false
    clearFit()
    const el = viewportRef.current
    if (!el || !touchScrubRef.current || pinchRef.current) return
    touchScrubLiveRef.current = true
    window.clearTimeout(touchScrubIdleTimerRef.current)
    touchScrubIdleTimerRef.current = window.setTimeout(() => {
      touchScrubLiveRef.current = false
    }, TOUCH_SCRUB_IDLE_MS)
    onTouchScrubRef.current?.(
      clamp(timeFromScroll(el.scrollLeft, pxPerSecRef.current), 0, getActiveDurationSec())
    )
  }

  // Zooming (the slider, พอดีจอ, the wheel) is the user arranging the view
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
    const contentX = clientX - rect.left + el.scrollLeft - HEADER_COL_PX - leadPxRef.current
    return clamp(contentX / pxPerSecRef.current, 0, maxSec ?? getActiveDurationSec())
  }

  // ---- fit memory (fit ⇄ previous zoom) ------------------------------------
  const [isFitted, setIsFitted] = useState(false)
  const isFittedRef = useRef(false)
  /** The zoom and scroll before the last fit, restored by the next fitToggle. */
  const fitMemoryRef = useRef<{ pxPerSec: number; scrollLeft: number } | null>(null)

  function clearFit(): void {
    fitMemoryRef.current = null
    if (isFittedRef.current) {
      isFittedRef.current = false
      setIsFitted(false)
    }
  }

  function markFitted(): void {
    if (!isFittedRef.current) {
      isFittedRef.current = true
      setIsFitted(true)
    }
  }

  /** The public zoom setter: a manual zoom, so the fit memory is dropped.
   * Stable, like the state setter it wraps — the toolbar takes it as a prop. */
  const setPxPerSec = useCallback<Dispatch<SetStateAction<number>>>((v) => {
    clearFit()
    setPxPerSecRaw(v)
    // clearFit only touches refs and a state setter, so the first render's copy is the one.
  }, [])

  /** Set the zoom and, once the wider lanes have rendered, the scroll that
   * goes with it. A scroll this hook wrote, so the follow is not switched off
   * by it (the zoom effect above already did that on purpose). */
  function applyZoom(nextPxPerSec: number, scrollLeft: number): void {
    const el = viewportRef.current
    setPxPerSecRaw(nextPxPerSec)
    // Pinned playhead: the paint effect centres on it after the zoom, and an
    // anchored scroll would only pull the head off centre.
    if (touchScrubRef.current) return
    requestAnimationFrame(() => {
      if (el) autoScrollTo(el, Math.max(0, scrollLeft))
    })
  }

  function fitToScreen(): void {
    const el = viewportRef.current
    const dur = getAxisDurationSec()
    if (!el || dur <= 0) return
    // The tail keeps the end grabbable; in touch mode the lead pads the start.
    const next = fitPxPerSec(
      el.clientWidth - leadPxRef.current,
      dur,
      HEADER_COL_PX,
      TAIL_PX,
      MIN_PX_PER_SEC,
      MAX_PX_PER_SEC
    )
    markFitted()
    applyZoom(next, 0)
  }

  function fitToggle(): void {
    const el = viewportRef.current
    if (!el) return
    if (isFittedRef.current) {
      const memory = fitMemoryRef.current
      clearFit()
      if (memory) applyZoom(memory.pxPerSec, memory.scrollLeft)
      return
    }
    fitMemoryRef.current = { pxPerSec: pxPerSecRef.current, scrollLeft: el.scrollLeft }
    fitToScreen()
  }

  /** Whether the playhead is inside the drawable part of the view. */
  function playheadOnScreen(el: HTMLElement): boolean {
    const x = xOfTime(currentTimeRef.current)
    return x >= el.scrollLeft + HEADER_COL_PX && x <= el.scrollLeft + el.clientWidth
  }

  function zoomAround(factor: number, anchorSec?: number): void {
    const el = viewportRef.current
    if (!el) return
    const px = pxPerSecRef.current
    const anchor =
      anchorSec ??
      (playheadOnScreen(el)
        ? currentTimeRef.current
        : centreTime(el.scrollLeft, el.clientWidth, px, HEADER_COL_PX, leadPxRef.current))
    const next = clamp(px * factor, MIN_PX_PER_SEC, MAX_PX_PER_SEC)
    if (next === px) return
    const pointerVX = xOfTime(anchor, px) - el.scrollLeft
    clearFit()
    applyZoom(next, anchoredScrollLeft(anchor, next, pointerVX, HEADER_COL_PX, leadPxRef.current))
  }

  function zoomToRange(inSec: number, outSec: number, padPx = 24): void {
    const el = viewportRef.current
    if (!el || !(outSec > inSec)) return
    const r = rangeZoom(
      inSec,
      outSec,
      el.clientWidth,
      HEADER_COL_PX,
      padPx,
      MIN_PX_PER_SEC,
      MAX_PX_PER_SEC,
      leadPxRef.current
    )
    clearFit()
    applyZoom(r.pxPerSec, r.scrollLeft)
  }

  /**
   * Wheel zoom and horizontal wheel scroll, anchored so the time under the
   * cursor stays put. ⌘/Ctrl+wheel is how CapCut, Resolve and Descript zoom
   * (a trackpad pinch arrives as Ctrl+wheel); Alt+wheel is kept from before.
   * Shift+wheel, or a wheel that is mostly horizontal, scrolls the lanes; a
   * plain vertical wheel is left to the page, since the lanes sit inside one.
   *
   * Bound natively rather than through `onWheel`: React registers its root
   * wheel listener as PASSIVE, so `preventDefault` inside a synthetic handler
   * is ignored (Chrome logs "Unable to preventDefault inside passive event
   * listener") and the browser scrolls the viewport underneath the zoom — the
   * anchor arithmetic then lands the wrong time under the pointer. And the
   * page would zoom on ⌘/Ctrl+wheel.
   */
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    function onWheel(e: WheelEvent): void {
      const node = viewportRef.current
      if (!node) return
      if (e.ctrlKey || e.metaKey || e.altKey) {
        e.preventDefault()
        const anchorTime = timeAtClientX(e.clientX)
        const rect = node.getBoundingClientRect()
        const pointerVX = e.clientX - rect.left
        const factor = Math.pow(1.0015, -e.deltaY)
        const next = clamp(pxPerSecRef.current * factor, MIN_PX_PER_SEC, MAX_PX_PER_SEC)
        if (next === pxPerSecRef.current) return
        clearFit()
        // scrollLeft so that anchorTime lands back under the pointer.
        applyZoom(
          next,
          anchoredScrollLeft(anchorTime, next, pointerVX, HEADER_COL_PX, leadPxRef.current)
        )
        return
      }
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault()
        node.scrollLeft += e.deltaX || e.deltaY
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  // ---- touch pinch zoom ----------------------------------------------------
  /** The two-finger gesture in progress, or null. While set, a scroll event
   * is the pinch moving the strip, not a scrub. */
  const pinchRef = useRef<{
    startPx: number
    d0: number
    anchorSec: number
    anchorVX: number
    frame: number
  } | null>(null)
  // The gesture listeners bind once (a re-bind mid-pinch would drop the
  // fingers it is tracking) and reach the newest render's helpers here.
  const pinchHelpersRef = useRef({ timeAtClientX, applyZoom, clearFit })
  pinchHelpersRef.current = { timeAtClientX, applyZoom, clearFit }
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const pointers = new Map<number, { x: number; y: number }>()
    const dist = (): number => {
      const [a, b] = [...pointers.values()]
      return Math.hypot(b.x - a.x, b.y - a.y)
    }
    const midX = (): number => {
      const [a, b] = [...pointers.values()]
      return (a.x + b.x) / 2
    }
    function onDown(e: PointerEvent): void {
      if (e.pointerType !== 'touch') return
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pointers.size === 2 && !pinchRef.current) {
        const node = viewportRef.current
        if (!node) return
        const rect = node.getBoundingClientRect()
        const x = midX()
        pinchRef.current = {
          startPx: pxPerSecRef.current,
          d0: dist(),
          anchorSec: pinchHelpersRef.current.timeAtClientX(x),
          anchorVX: x - rect.left,
          frame: 0
        }
        // The finger under the pinch is not a scrub.
        touchScrubLiveRef.current = false
        window.clearTimeout(touchScrubIdleTimerRef.current)
      }
    }
    function onMove(e: PointerEvent): void {
      if (!pointers.has(e.pointerId)) return
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      const g = pinchRef.current
      if (!g || pointers.size < 2) return
      e.preventDefault()
      if (g.frame) return
      g.frame = requestAnimationFrame(() => {
        g.frame = 0
        if (pointers.size < 2 || pinchRef.current !== g) return
        const d1 = dist()
        if (Math.abs(d1 - g.d0) < PINCH_MIN_DELTA_PX) return
        const next = clamp(g.startPx * pinchFactor(g.d0, d1), MIN_PX_PER_SEC, MAX_PX_PER_SEC)
        if (next === pxPerSecRef.current) return
        pinchHelpersRef.current.clearFit()
        pinchHelpersRef.current.applyZoom(
          next,
          anchoredScrollLeft(g.anchorSec, next, g.anchorVX, HEADER_COL_PX, leadPxRef.current)
        )
      })
    }
    function onUp(e: PointerEvent): void {
      if (!pointers.delete(e.pointerId)) return
      if (pointers.size < 2 && pinchRef.current) {
        if (pinchRef.current.frame) cancelAnimationFrame(pinchRef.current.frame)
        pinchRef.current = null
      }
    }
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      pinchRef.current = null
    }
  }, [editorPhase])

  // ---- drag auto-scroll ----------------------------------------------------
  /** Set between dragScroll.begin() and end(): the lane may be scrolled by the
   * drag alone. */
  const dragActiveRef = useRef(false)
  const dragScroll = useMemo<DragScroller>(
    () => ({
      begin: () => {
        dragActiveRef.current = true
      },
      tick: (clientX) => {
        const el = viewportRef.current
        if (!el || !dragActiveRef.current) return
        const rect = el.getBoundingClientRect()
        const step = autoScrollStep(
          clientX,
          rect.left + HEADER_COL_PX,
          rect.right,
          DRAG_AUTOSCROLL_EDGE_PX,
          DRAG_AUTOSCROLL_MAX_PX,
          el.scrollLeft,
          el.scrollWidth - el.clientWidth
        )
        if (step !== 0) autoScrollTo(el, el.scrollLeft + step)
      },
      end: () => {
        dragActiveRef.current = false
      },
      scrollLeft: () => viewportRef.current?.scrollLeft ?? 0
    }),
    []
  )

  // Zoom, lead or view-mode change moves where the playhead must be drawn.
  useEffect(() => {
    paintTime(currentTimeRef.current)
  }, [pxPerSec, leadPx, viewMode, editorPhase, cuts, videoDuration])

  // Publish the scroll position to the filmstrip lanes.
  //
  // Deliberately NOT React state: a `setState` per scroll frame re-renders a
  // 4,000-line timeline to move some thumbnails, which is most of what made
  // scrolling stutter. The lanes subscribe and redraw their own canvas; nothing
  // else in the tree hears about it. A ResizeObserver covers the window being
  // resized without a scroll, which would otherwise leave lanes drawn to the
  // old viewport width — and re-derives the touch lead, which is half of it.
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const publish = (): void => {
      const lead = leadPxFor(el.clientWidth, HEADER_COL_PX, touchScrubRef.current)
      if (lead !== leadPxRef.current) {
        leadPxRef.current = lead
        setLeadPx(lead)
      }
      viewportStore.set({ scrollLeft: el.scrollLeft, viewportWidth: el.clientWidth, leadPx: lead })
    }
    publish()
    el.addEventListener('scroll', publish, { passive: true })
    const ro = new ResizeObserver(publish)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', publish)
      ro.disconnect()
    }
  }, [viewportStore, editorPhase, viewMode, touchScrub])

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
    edgeHintRef,
    viewportStore,
    getContentWidthPx,
    paintTime,
    followPlayhead,
    resumeFollow,
    revealPlayhead,
    revealAndFlashCut,
    revealAndFlashCuts,
    onViewportScroll,
    timeAtClientX,
    fitToScreen,
    isFitted,
    fitToggle,
    zoomAround,
    zoomToRange,
    queueScrollShift,
    dragScroll,
    coarse,
    touchScrub,
    leadPx
  }
}
