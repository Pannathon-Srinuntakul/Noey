/** Duration/dimension lookup for a clip the wizard has just been handed.
 *
 * The ENGINE answers first (see `probeClipDeep` below): it demuxes the
 * container in a few milliseconds and, unlike a media element, it also answers
 * for a codec this browser cannot decode — which is the case that matters,
 * because an HEVC clip must be recognised before the wizard decides what to do
 * with it. A hidden `<video>` is the fallback.
 */
import type { WizardFile } from './wizardState'

export interface ClipMeta {
  durationSec: number | null
  width: number | null
  height: number | null
  sizeBytes: number | null
  /** The source's video codec, when known. */
  codec?: string | null
  /**
   * Whether this browser can actually decode the pictures.
   *
   * Separate from "did the metadata parse": an HEVC clip reports its duration
   * and size everywhere and decodes only where the platform has an HEVC
   * decoder. Undefined means not established.
   */
  decodable?: boolean
}

const UNKNOWN: ClipMeta = { durationSec: null, width: null, height: null, sizeBytes: null }

/**
 * How long to wait on a `<video>` element before giving up on it.
 *
 * It is not enough to handle `error`: handed an HEVC file, Chrome fires
 * NEITHER `loadedmetadata` NOR `error` — it just never settles (measured
 * 2026-09-08). Without a deadline the promise hangs forever and the clip row
 * spins on "กำลังอ่านข้อมูลคลิป…" with no way out.
 */
const ELEMENT_PROBE_TIMEOUT_MS = 4000

function fromFileObject(file: File): Promise<ClipMeta> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.muted = true
    let settled = false

    const finish = (meta: ClipMeta): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      video.src = ''
      URL.revokeObjectURL(url)
      resolve(meta)
    }

    const timer = setTimeout(
      () => finish({ ...UNKNOWN, sizeBytes: file.size }),
      ELEMENT_PROBE_TIMEOUT_MS
    )

    video.addEventListener(
      'loadedmetadata',
      () => {
        finish({
          durationSec: Number.isFinite(video.duration) ? video.duration : null,
          width: video.videoWidth || null,
          height: video.videoHeight || null,
          sizeBytes: file.size
        })
      },
      { once: true }
    )
    // A codec Chromium cannot decode still has a real size — report what we
    // know rather than dropping the row's whole meta line.
    video.addEventListener('error', () => finish({ ...UNKNOWN, sizeBytes: file.size }), {
      once: true
    })
    video.src = url
  })
}

async function fromSidecar(path: string): Promise<ClipMeta> {
  try {
    const evt = await window.noey.sidecar.probe(path)
    const num = (v: unknown): number | null => (typeof v === 'number' && v > 0 ? v : null)
    return {
      durationSec: num(evt.duration),
      width: num(evt.width),
      height: num(evt.height),
      sizeBytes: null
    }
  } catch {
    return UNKNOWN
  }
}

export function probeClip(clip: WizardFile): Promise<ClipMeta> {
  return clip.file ? fromFileObject(clip.file) : fromSidecar(clip.path)
}

/**
 * The same lookup, plus whether the engine can decode the clip.
 *
 * Goes through `sidecar.probe` rather than a `<video>` element because only
 * the engine can answer the decode question; the element's `loadedmetadata`
 * fires for files it will never be able to play.
 */
export async function probeClipDeep(clip: WizardFile): Promise<ClipMeta> {
  const num = (v: unknown): number | null => (typeof v === 'number' && v > 0 ? v : null)

  // The engine goes FIRST. It answers in a few milliseconds, it is the only
  // one that knows the codec, and unlike the media element it always answers —
  // so a clip the element would stall on still gets a row that fills in.
  let engine: ClipMeta | null = null
  try {
    const evt = await window.noey.sidecar.probe(clip.path)
    engine = {
      durationSec: num(evt.duration),
      width: num(evt.width),
      height: num(evt.height),
      sizeBytes: clip.file?.size ?? null,
      codec: (evt as { codec?: string | null }).codec ?? null,
      decodable: (evt as { decodable?: boolean }).decodable
    }
  } catch {
    engine = null
  }

  // Nothing left to ask once the engine has answered in full.
  if (engine?.durationSec && engine.width && engine.height) return engine

  const base = await probeClip(clip)
  if (!engine) return base
  return {
    ...engine,
    durationSec: engine.durationSec ?? base.durationSec,
    width: engine.width ?? base.width,
    height: engine.height ?? base.height,
    sizeBytes: engine.sizeBytes ?? base.sizeBytes
  }
}
