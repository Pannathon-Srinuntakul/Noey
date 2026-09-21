/**
 * One source clip's thumbnail lane, drawn into a canvas.
 *
 * Replaces the `<img>`-per-tile lanes the editor used to build in the renderer:
 * a hidden `<video>` was seeked tile by tile (~150 ms each, on the main thread),
 * each frame went through a synchronous `canvas.toDataURL`, and every single
 * tile pushed a `data:` URL into React state — one full timeline re-render per
 * thumbnail, hundreds of DOM nodes and tens of megabytes of base64 for a
 * five-minute source. That is the "แก้ไขวิดีโอแล้วมันกระตุก" report (2026-09-07).
 *
 * Now the `filmstrip` job (engine/jobs/filmstrip.ts — WebCodecs, no ffmpeg)
 * extracts the strip once and this component draws the decoded JPEGs into ONE
 * canvas per lane. Scrolling
 * calls a draw function directly through `TimelineViewportContext`; React is not
 * involved, so a scroll costs at most one `drawImage` per visible slot — and
 * nothing at all while the slots it would draw are the ones already painted.
 *
 * The canvas is sized to the VISIBLE window, not to the whole lane: at 160 px/s
 * a five-minute source is 46,000 px wide, past Chromium's canvas limit and
 * pointless to back with pixels. The window arithmetic is
 * `lib/filmstripGeometry.ts` (unit-tested, ported from FreeCut, MIT).
 */
import { memo, useContext, useEffect, useRef } from 'react'
import {
  computeCoverRect,
  computeFilmstripSlots,
  computeFilmstripWindow
} from '../lib/filmstripGeometry'
import { getDecodedFilmstripImage, subscribeFilmstripImage } from '../lib/filmstripImageCache'
import { TimelineViewportContext } from '../lib/timelineViewport'
import type { FilmstripStrip } from '../lib/useFilmstripStrips'

/** Painted either side of the viewport so a short scroll never shows a gap. */
const OVERSCAN_PX = 400

/**
 * Size the backing store, and leave it blank with an identity transform.
 *
 * Assigning `width` or `height` resets the canvas and throws its pixels away
 * even when the value is unchanged, so each is written only when it differs.
 * A canvas that keeps its size also keeps its last frame and transform, so it
 * is cleared here — all of it, in device pixels: the store is rounded UP from
 * the CSS size, and nothing should hang on how a CSS-pixel clear rounds its
 * last column at a fractional DPR.
 */
function resetCanvas(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
): void {
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
}

/** Drop the backing store, once — writing 0x0 over 0x0 still resets the canvas. */
function collapseCanvas(canvas: HTMLCanvasElement): void {
  if (canvas.width !== 0) canvas.width = 0
  if (canvas.height !== 0) canvas.height = 0
}

interface Props {
  strip: FilmstripStrip | null
  /** True while the strip is still being extracted — draws a quiet wash so an
   * in-flight lane is distinguishable from a failed one (which stays empty). */
  pending?: boolean
  /** Seconds into the source that this lane's x=0 shows. */
  sourceStartSec: number
  /** Lane width in px at the current zoom. */
  laneWidthPx: number
  /** Lane height in px. */
  heightPx: number
  /** Where the lane's left edge sits inside the scrolling content, in px. */
  laneLeftPx: number
  pxPerSec: number
  /** 0–1. The lane is a backdrop for the cut blocks drawn on top of it. */
  opacity?: number
}

export const FilmstripCanvas = memo(function FilmstripCanvas({
  strip,
  pending = false,
  sourceStartSec,
  laneWidthPx,
  heightPx,
  laneLeftPx,
  pxPerSec,
  opacity = 1
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewport = useContext(TimelineViewportContext)

  // Every value the draw reads lives in a ref so the draw function itself is
  // stable: it is called from a scroll callback and from image-decode
  // callbacks, neither of which should be re-subscribed on a prop change.
  const propsRef = useRef({
    strip,
    pending,
    sourceStartSec,
    laneWidthPx,
    heightPx,
    laneLeftPx,
    pxPerSec
  })
  propsRef.current = { strip, pending, sourceStartSec, laneWidthPx, heightPx, laneLeftPx, pxPerSec }

  // What a prop change calls: marks the picture stale, starts the tile waits
  // over and schedules one paint. Installed by the effect that owns the draw,
  // so a prop change no longer tears that effect down — the viewport
  // subscription and the draw closure live as long as the lane.
  const redrawRef = useRef<(() => void) | null>(null)
  // What a lane MOVE calls: the scroll path, not the redraw one. See the
  // laneLeftPx effect below.
  const scheduleRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !viewport) return

    // Tiles this lane is currently waiting on. Each decode notifies once and
    // triggers exactly one redraw, so a lane fills in progressively without
    // ever touching React.
    const pending = new Map<string, () => void>()
    let raf = 0
    let disposed = false
    // Set by whatever changes the picture other than a scroll: a prop, or a
    // tile that finished decoding. Nothing is painted yet, so it starts set.
    let dirty = true
    // Set by a prop change: the next draw drops every wait and asks again,
    // which is what re-running this whole effect used to do. A fresh
    // extraction of ANY clip drops every decoded tile
    // (resetDecodedFilmstripImages), so a wait taken out before it can sit on
    // an entry that is gone and will never call back. A prop change — the job
    // settling flips `pending` or hands over new strips — is where a lane asks
    // again; a scroll or a decode keeps the waits it has.
    let restartWaits = false
    // What the canvas holds now, reduced to the inputs a scroll can change.
    // The canvas already covers an overscan either side of the viewport, so
    // most scroll frames land on the same key — and would paint the same
    // pixels over again.
    let paintedKey = ''

    /** True when this frame would repaint what is already there. Otherwise it
     * records `key` as painted, and the caller must go on and paint it. */
    const alreadyPainted = (key: string): boolean => {
      if (!dirty && key === paintedKey) return true
      dirty = false
      paintedKey = key
      return false
    }

    const draw = (): void => {
      if (disposed) return
      if (restartWaits) {
        restartWaits = false
        for (const off of pending.values()) off()
        pending.clear()
      }
      const p = propsRef.current
      const ctx = canvas.getContext('2d')
      if (!ctx || !p.strip || p.strip.count <= 0) {
        // Still coming: a flat wash keeps the lane visibly "loading" instead
        // of visibly "broken". Failed or absent: collapse as before.
        if (ctx && p.pending && p.laneWidthPx > 0 && p.heightPx > 0) {
          if (alreadyPainted('wash')) return
          // Floored because the canvas truncates them on assignment anyway,
          // and resetCanvas compares against what the canvas stored.
          resetCanvas(
            canvas,
            ctx,
            Math.floor(Math.min(p.laneWidthPx, 4000)),
            Math.floor(p.heightPx)
          )
          canvas.style.width = `${canvas.width}px`
          canvas.style.height = `${canvas.height}px`
          ctx.fillStyle = 'rgb(243 242 242 / 0.05)'
          ctx.fillRect(0, 0, canvas.width, canvas.height)
          return
        }
        if (!alreadyPainted('empty')) collapseCanvas(canvas)
        return
      }

      const v = viewport.get()
      const win = computeFilmstripWindow({
        laneLeftPx: p.laneLeftPx,
        laneWidthPx: p.laneWidthPx,
        scrollLeft: v.scrollLeft,
        viewportWidth: v.viewportWidth,
        overscanPx: OVERSCAN_PX
      })
      if (!win || win.visibleEndPx <= win.visibleStartPx) {
        if (!alreadyPainted('offscreen')) collapseCanvas(canvas)
        return
      }

      // A slot is as wide as one tile's own aspect at this lane height, so the
      // strip reads as a strip of frames rather than a stretched smear.
      const slotWidthPx = Math.max(
        1,
        Math.round((p.strip.tileWidth / p.strip.tileHeight) * p.heightPx)
      )
      const slots = computeFilmstripSlots({
        window: win,
        slotWidthPx,
        sourceStartSec: p.sourceStartSec,
        pxPerSec: p.pxPerSec,
        tileSec: p.strip.tileSec,
        tileCount: p.strip.count
      })
      if (slots.length === 0) {
        if (!alreadyPainted('offscreen')) collapseCanvas(canvas)
        return
      }

      // Back the canvas with the slot grid it actually draws — starting at the
      // first slot's real x rather than the window's, so the strip is anchored
      // to the lane and does not crawl while scrolling.
      const first = slots[0]!
      const last = slots.at(-1)!
      const originX = first.x
      const cssWidth = last.x + last.width - originX
      const dpr = window.devicePixelRatio || 1
      // Slots are anchored to the lane, so with nothing dirty the same first
      // and last slot means the same tiles in the same places.
      const key = `strip:${originX}:${cssWidth}:${p.heightPx}:${dpr}:${first.tileIndex}:${last.tileIndex}`
      if (alreadyPainted(key)) return
      canvas.style.left = `${originX}px`
      canvas.style.width = `${cssWidth}px`
      canvas.style.height = `${p.heightPx}px`
      resetCanvas(
        canvas,
        ctx,
        Math.max(1, Math.ceil(cssWidth * dpr)),
        Math.max(1, Math.ceil(p.heightPx * dpr))
      )

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const wanted = new Set<string>()
      for (const slot of slots) {
        const url = p.strip.urlFor(slot.tileIndex)
        wanted.add(url)
        const img = getDecodedFilmstripImage(url)
        if (!img) {
          if (!pending.has(url)) {
            const off = subscribeFilmstripImage(url, redraw, () => undefined)
            pending.set(url, off)
          }
          continue
        }
        const x = slot.x - originX
        ctx.save()
        ctx.beginPath()
        ctx.rect(x, 0, slot.width, p.heightPx)
        ctx.clip()
        const r = computeCoverRect(img.naturalWidth, img.naturalHeight, slot.width, p.heightPx)
        ctx.drawImage(img, x + r.x, r.y, r.width, r.height)
        ctx.restore()
      }

      // Stop waiting on tiles that scrolled away — otherwise a long scroll
      // leaves a subscription per tile it passed, pinning them in the cache.
      for (const [url, off] of pending) {
        if (!wanted.has(url)) {
          off()
          pending.delete(url)
        }
      }
    }

    const schedule = (): void => {
      if (disposed || raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        draw()
      })
    }

    // The picture changed where a scroll alone would not have changed it.
    const redraw = (): void => {
      dirty = true
      schedule()
    }

    redrawRef.current = () => {
      restartWaits = true
      redraw()
    }
    scheduleRef.current = schedule
    schedule()
    const unsub = viewport.subscribe(schedule)
    return () => {
      disposed = true
      redrawRef.current = null
      scheduleRef.current = null
      unsub()
      if (raf) cancelAnimationFrame(raf)
      for (const off of pending.values()) off()
      pending.clear()
    }
  }, [viewport])

  // The draw reads live props through `propsRef`, but a change to any of
  // these changes the PICTURE, so it must repaint — hence they are deps even
  // though the effect does not read them. It no longer re-subscribes to the
  // viewport or rebuilds the draw; see redrawRef.
  useEffect(() => {
    redrawRef.current?.()
  }, [strip, pending, sourceStartSec, laneWidthPx, heightPx, pxPerSec])

  // Moving the lane only changes which lane-local slice is visible — exactly
  // what a scroll changes, and the painted key already covers it. Treating it
  // as a picture change repainted every later block on every trim frame (a
  // trim shifts all of them) and dropped their tile waits; during a left trim
  // the scroll compensation cancels the shift, so their key never changes.
  useEffect(() => {
    scheduleRef.current?.()
  }, [laneLeftPx])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute top-0"
      style={{ opacity }}
    />
  )
})
