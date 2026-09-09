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
 * involved, so a scroll costs one `drawImage` per visible slot and nothing else.
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

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !viewport) return

    // Tiles this lane is currently waiting on. Each decode notifies once and
    // triggers exactly one redraw, so a lane fills in progressively without
    // ever touching React.
    const pending = new Map<string, () => void>()
    let raf = 0
    let disposed = false

    const draw = (): void => {
      if (disposed) return
      const p = propsRef.current
      const ctx = canvas.getContext('2d')
      if (!ctx || !p.strip || p.strip.count <= 0) {
        // Still coming: a flat wash keeps the lane visibly "loading" instead
        // of visibly "broken". Failed or absent: collapse as before.
        if (ctx && p.pending && p.laneWidthPx > 0 && p.heightPx > 0) {
          canvas.width = Math.min(p.laneWidthPx, 4000)
          canvas.height = p.heightPx
          canvas.style.width = `${canvas.width}px`
          canvas.style.height = `${canvas.height}px`
          ctx.fillStyle = 'rgb(243 242 242 / 0.05)'
          ctx.fillRect(0, 0, canvas.width, canvas.height)
          return
        }
        canvas.width = 0
        canvas.height = 0
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
        canvas.width = 0
        canvas.height = 0
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
        canvas.width = 0
        canvas.height = 0
        return
      }

      // Back the canvas with the slot grid it actually draws — starting at the
      // first slot's real x rather than the window's, so the strip is anchored
      // to the lane and does not crawl while scrolling.
      const originX = slots[0]!.x
      const cssWidth = slots.at(-1)!.x + slots.at(-1)!.width - originX
      const dpr = window.devicePixelRatio || 1
      canvas.style.left = `${originX}px`
      canvas.style.width = `${cssWidth}px`
      canvas.style.height = `${p.heightPx}px`
      canvas.width = Math.max(1, Math.ceil(cssWidth * dpr))
      canvas.height = Math.max(1, Math.ceil(p.heightPx * dpr))

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, cssWidth, p.heightPx)

      const wanted = new Set<string>()
      for (const slot of slots) {
        const url = p.strip.urlFor(slot.tileIndex)
        wanted.add(url)
        const img = getDecodedFilmstripImage(url)
        if (!img) {
          if (!pending.has(url)) {
            const off = subscribeFilmstripImage(url, schedule, () => undefined)
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

    schedule()
    const unsub = viewport.subscribe(schedule)
    return () => {
      disposed = true
      unsub()
      if (raf) cancelAnimationFrame(raf)
      for (const off of pending.values()) off()
      pending.clear()
    }
    // The draw reads live props through `propsRef`, but a change to any of
    // these changes the PICTURE, so it must repaint — hence they are deps even
    // though the closure does not capture them.
  }, [viewport, strip, pending, sourceStartSec, laneWidthPx, heightPx, laneLeftPx, pxPerSec])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute top-0"
      style={{ opacity }}
    />
  )
})
