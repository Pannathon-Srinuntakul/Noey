/**
 * Ask the engine to extract every source clip's thumbnail strip, once.
 *
 * The strips are JPEG tiles on disk under `<projectDir>/filmstrip/<clipId>/`,
 * addressed through the media route exactly like any other project file.
 *
 * Two properties this hook is responsible for (owner report 2026-09-09:
 * "thumbnail ตรง timeline มันไม่แสดง ต้องรอซักพัก"):
 *
 *   - PROGRESSIVE: each clip's strip is merged into state the moment the job
 *     emits it, so lane 1 paints while lane 4 is still extracting. The old
 *     shape held every lane until the whole job resolved.
 *   - HONEST: `status` + `done/total` say whether work is still running, so
 *     the editor can gate on it — an empty lane used to be indistinguishable
 *     from a failed one.
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
  cached?: boolean
}

export type FilmstripStripMap = Record<string, FilmstripStrip>

export interface FilmstripState {
  strips: FilmstripStripMap
  status: 'idle' | 'running' | 'ready' | 'error'
  /** Clips whose strip is in hand / total clips asked for. */
  done: number
  total: number
}

function isStripRow(r: SidecarStripRow | undefined): r is Required<SidecarStripRow> {
  return (
    !!r &&
    typeof r.id === 'string' &&
    typeof r.count === 'number' &&
    r.count > 0 &&
    typeof r.tileSec === 'number' &&
    r.tileSec > 0 &&
    typeof r.tileWidth === 'number' &&
    typeof r.tileHeight === 'number'
  )
}

export function useFilmstripStrips(
  localUid: string | null,
  clips: FilmstripSourceClip[]
): FilmstripState {
  const [state, setState] = useState<FilmstripState>({
    strips: {},
    status: 'idle',
    done: 0,
    total: clips.length
  })

  // The clip list is rebuilt on every render by its caller, so depend on its
  // CONTENT — an array identity dep would re-run the extraction every render.
  const clipsKey = clips.map((c) => `${c.id}:${c.file}`).join('|')

  useEffect(() => {
    if (!localUid || clips.length === 0) return
    let cancelled = false
    const aborter = new AbortController()

    const toStrip = (r: Required<SidecarStripRow>): FilmstripStrip => {
      // A lane asks for every visible tile's URL on every paint, and building
      // one splits, encodes and joins the path. A tile's URL never changes for
      // the life of the strip, so each is built once, the first time it is
      // asked for.
      const urls = new Array<string | undefined>(r.count)
      return {
        count: r.count,
        tileSec: r.tileSec,
        tileWidth: r.tileWidth,
        tileHeight: r.tileHeight,
        // Tile names are `t_%05d.jpg` from 1 — the engine deliberately does
        // not ship the list, which would be hundreds of redundant strings.
        urlFor: (i: number) =>
          (urls[i] ??= window.noey.media.urlFor(
            localUid,
            `filmstrip/${r.id}/t_${String(i + 1).padStart(5, '0')}.jpg`
          ))
      }
    }

    const merge = (row: Required<SidecarStripRow>): void => {
      if (cancelled) return
      // A freshly EXTRACTED strip reuses the same tile names as the run it
      // replaced, and a bitmap already decoded this session would survive the
      // no-store transport — drop the decodes for that clip's generation.
      // A cached row changed nothing on disk, so its decodes stay warm; the
      // old unconditional reset threw away every decoded tile on every
      // editor open, which is why even a WARM reopen re-fetched everything.
      if (!row.cached) resetDecodedFilmstripImages()
      setState((prev) => ({
        ...prev,
        strips: { ...prev.strips, [row.id]: toStrip(row) },
        done: prev.done + 1
      }))
    }

    let unsub: (() => void) | undefined
    void (async () => {
      try {
        const projectDir = await window.noey.projects.dir(localUid)
        if (cancelled) return
        // Reset AFTER the first await, not synchronously in the effect body —
        // the render that scheduled this effect is still committing there.
        setState({ strips: {}, status: 'running', done: 0, total: clips.length })
        // Progressive: the job emits each clip's manifest as it lands.
        unsub = window.noey.sidecar.filmstrip.onProgress((evt) => {
          const row = (evt as { strip?: SidecarStripRow }).strip
          if (isStripRow(row)) merge(row)
        }, projectDir)
        const res = await window.noey.sidecar.filmstrip.run({
          projectDir,
          clips: clips.map((c) => ({ id: c.id, file: c.file })),
          // Stop with the editor: a filmstrip left running holds the project's
          // job lock, and the next render queued behind it.
          signal: aborter.signal
        })
        if (cancelled) return

        // The final result is authoritative — it repairs anything a missed
        // progress event left out, and settles `status`.
        const rows = ((res as { filmstrips?: SidecarStripRow[] }).filmstrips ?? []).filter(
          isStripRow
        )
        setState((prev) => {
          const strips = { ...prev.strips }
          for (const r of rows) strips[r.id] = toStrip(r)
          return { strips, status: 'ready', done: rows.length, total: clips.length }
        })
      } catch {
        // Soft failure: no strips, empty lanes, editor still fully usable —
        // but the state SAYS it failed instead of pretending it never ran.
        if (!cancelled) setState((prev) => ({ ...prev, status: 'error' }))
      }
    })()

    return () => {
      cancelled = true
      aborter.abort()
      unsub?.()
    }
  }, [localUid, clipsKey])

  return state
}
