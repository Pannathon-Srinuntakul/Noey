/**
 * Ask the sidecar to extract every source clip's thumbnail strip, once.
 *
 * The strips are JPEG tiles on disk under `<projectDir>/filmstrip/<clipId>/`,
 * addressed through `media://` exactly like any other project file. ffmpeg does
 * the decode in its own process — a 4:52 source is one 14-second pass, against
 * roughly 90 seconds of blocked main thread for the old in-renderer version —
 * and a re-open costs one ffprobe per clip because the sidecar keeps a manifest
 * and honours it.
 *
 * A failure is deliberately soft: the lanes stay empty and the editor works.
 * The filmstrip is orientation, not data — nothing about the cut depends on it.
 */
import { useEffect, useState } from 'react'
import { resetDecodedFilmstripImages } from './filmstripImageCache'

export interface FilmstripStrip {
  /** Tiles extracted for this source. */
  count: number
  /** Seconds one tile advances. */
  tileSec: number
  tileWidth: number
  tileHeight: number
  /** `media://` URL of one tile, 0-based. */
  urlFor: (tileIndex: number) => string
}

/** What one clip needs for its strip: the id the cuts refer to, and its file. */
export interface FilmstripSourceClip {
  id: string
  file: string
}

interface SidecarStripRow {
  id?: string
  count?: number
  tileSec?: number
  tileWidth?: number
  tileHeight?: number
}

export type FilmstripStripMap = Record<string, FilmstripStrip>

export function useFilmstripStrips(
  localUid: string | null,
  clips: FilmstripSourceClip[]
): FilmstripStripMap {
  const [strips, setStrips] = useState<FilmstripStripMap>({})

  // The clip list is rebuilt on every render by its caller, so depend on its
  // CONTENT — an array identity dep would re-run the extraction every render.
  const clipsKey = clips.map((c) => `${c.id}:${c.file}`).join('|')

  useEffect(() => {
    if (!localUid || clips.length === 0) return
    let cancelled = false

    void (async () => {
      try {
        const projectDir = await window.noey.projects.dir(localUid)
        if (cancelled) return
        const res = await window.noey.sidecar.filmstrip.run({
          projectDir,
          clips: clips.map((c) => ({ id: c.id, file: c.file }))
        })
        if (cancelled) return

        const rows = ((res as { filmstrips?: SidecarStripRow[] }).filmstrips ?? []).filter(
          (r): r is Required<SidecarStripRow> =>
            typeof r.id === 'string' &&
            typeof r.count === 'number' &&
            r.count > 0 &&
            typeof r.tileSec === 'number' &&
            r.tileSec > 0 &&
            typeof r.tileWidth === 'number' &&
            typeof r.tileHeight === 'number'
        )

        // A re-extract reuses the same file names, and `media://` is served
        // no-store, but a bitmap already decoded in this session would survive
        // it — the same staleness class the media protocol's own comments warn
        // about. Dropping the decodes is cheap and removes the question.
        resetDecodedFilmstripImages()

        const next: FilmstripStripMap = {}
        for (const r of rows) {
          next[r.id] = {
            count: r.count,
            tileSec: r.tileSec,
            tileWidth: r.tileWidth,
            tileHeight: r.tileHeight,
            // Tile names are `t_%05d.jpg` from 1 — the sidecar deliberately does
            // not ship the list, which would be hundreds of redundant strings.
            urlFor: (i: number) =>
              window.noey.media.urlFor(
                localUid,
                `filmstrip/${r.id}/t_${String(i + 1).padStart(5, '0')}.jpg`
              )
          }
        }
        setStrips(next)
      } catch {
        // Soft failure: no strips, empty lanes, editor still fully usable.
      }
    })()

    return () => {
      cancelled = true
    }
  }, [localUid, clipsKey])

  return strips
}
