/**
 * Thumbnail strip for a single video file (R4 screen 3's ภาพหนึ่งแถว lane).
 *
 * One offscreen `<video>` seeked tile by tile — a `<video>` cannot serve two
 * seeks at once, so the captures are strictly sequential. Tiles arrive as they
 * are decoded rather than all at the end, so the lane fills in visibly instead
 * of staying blank for several seconds.
 *
 * This is deliberately NOT the TimelineEditor's filmstrip machinery: that one
 * caches per source clip and windows to what is on screen because it draws many
 * clips. Here there is exactly one file and a fixed number of tiles.
 */
import { useEffect, useState } from 'react'

/** Tall enough to read at lane height, small enough that 12 of them are cheap. */
const TILE_HEIGHT = 96

export interface FilmstripTile {
  /** Seconds into the video this tile was captured at. */
  atSec: number
  /** data: URL, ready for an <img src>. */
  url: string
}

async function seekTo(video: HTMLVideoElement, sec: number): Promise<void> {
  if (Math.abs(video.currentTime - sec) < 0.01) return
  await new Promise<void>((resolve) => {
    const done = (): void => {
      video.removeEventListener('seeked', done)
      resolve()
    }
    video.addEventListener('seeked', done)
    video.currentTime = sec
  })
}

/**
 * `count` evenly spaced thumbnails across `durationSec`. Re-runs when the src
 * or duration changes; a run in flight is abandoned rather than cancelled —
 * the element is torn down, so its pending seek resolves into nothing.
 */
export function useFilmstrip(src: string | null, durationSec: number, count = 12): FilmstripTile[] {
  const [tiles, setTiles] = useState<FilmstripTile[]>([])

  useEffect(() => {
    if (!src || durationSec <= 0 || count <= 0) return

    let cancelled = false
    const video = document.createElement('video')
    video.src = src
    video.muted = true
    video.preload = 'auto'
    video.crossOrigin = 'anonymous'

    const run = async (): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        video.addEventListener('loadeddata', () => resolve(), { once: true })
        video.addEventListener('error', () => reject(new Error('filmstrip load failed')), {
          once: true
        })
      })
      if (cancelled) return

      const ratio = (video.videoWidth || 9) / (video.videoHeight || 16)
      const canvas = document.createElement('canvas')
      canvas.height = TILE_HEIGHT
      canvas.width = Math.max(1, Math.round(TILE_HEIGHT * ratio))
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      // Accumulated locally and published whole each time, so the previous
      // video's tiles are replaced by the first capture rather than cleared up
      // front — clearing would mean a setState in the effect body.
      const out: FilmstripTile[] = []
      for (let i = 0; i < count; i++) {
        if (cancelled) return
        // Sample at the middle of each slice, not its edge: the first frame of
        // a cut is often a transition frame and reads as a black tile.
        const at = ((i + 0.5) / count) * durationSec
        await seekTo(video, Math.min(durationSec - 0.05, Math.max(0, at)))
        if (cancelled) return
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        out.push({ atSec: at, url: canvas.toDataURL('image/jpeg', 0.6) })
        setTiles([...out])
      }
    }

    void run().catch(() => undefined)
    return () => {
      cancelled = true
      video.removeAttribute('src')
      video.load()
    }
  }, [src, durationSec, count])

  return tiles
}
