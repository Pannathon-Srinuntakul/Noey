/**
 * Can this browser actually do the work?
 *
 * The whole point of the web build is that rendering happens on the viewer's
 * own machine, so a browser that cannot encode video cannot run the app at all.
 * Rather than let someone edit for ten minutes and fail at export, the shell
 * checks up front.
 *
 * It does not stop at asking the API. `VideoEncoder.isConfigSupported()` can
 * report a codec the machine then fails to actually open — the desktop build
 * hit the same class of thing and answers it the same way, by running a
 * throwaway half-second encode before trusting a hardware encoder
 * (`_detect_hw_encoder` in `ffmpeg_bin.py`). So this runs a real 6-frame encode
 * and only reports success if bytes come out.
 */

export interface Capabilities {
  ok: boolean
  /** Missing pieces, in words the shell can show. */
  missing: string[]
  videoCodec: 'avc' | 'vp9' | 'vp8' | null
  hasAudioEncoder: boolean
  hasOpfs: boolean
  hasServiceWorker: boolean
  /** Milliseconds for the probe encode — a rough speed signal. */
  probeMs: number | null
}

/** Portrait short-form is what this app makes; probe at that shape. */
const PROBE_WIDTH = 360
const PROBE_HEIGHT = 640
const PROBE_FRAMES = 6

const VIDEO_CANDIDATES: { codec: string; label: Capabilities['videoCodec'] }[] = [
  // H.264 first: it is what every social platform ingests happily.
  { codec: 'avc1.42001f', label: 'avc' },
  { codec: 'vp09.00.10.08', label: 'vp9' },
  { codec: 'vp8', label: 'vp8' }
]

async function probeVideoEncoder(): Promise<{
  codec: Capabilities['videoCodec']
  ms: number | null
}> {
  if (typeof VideoEncoder === 'undefined') return { codec: null, ms: null }

  for (const candidate of VIDEO_CANDIDATES) {
    const config: VideoEncoderConfig = {
      codec: candidate.codec,
      width: PROBE_WIDTH,
      height: PROBE_HEIGHT,
      bitrate: 2_000_000,
      framerate: 30
    }
    try {
      const support = await VideoEncoder.isConfigSupported(config)
      if (!support.supported) continue
    } catch {
      continue
    }

    // Claimed support is not proof. Encode a few real frames.
    const started = performance.now()
    let chunks = 0
    let failed = false
    const encoder = new VideoEncoder({
      output: () => {
        chunks += 1
      },
      error: () => {
        failed = true
      }
    })
    try {
      encoder.configure(config)
      const canvas = new OffscreenCanvas(PROBE_WIDTH, PROBE_HEIGHT)
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('no 2d context')
      for (let i = 0; i < PROBE_FRAMES; i++) {
        ctx.fillStyle = i % 2 === 0 ? '#204060' : '#a0c0e0'
        ctx.fillRect(0, 0, PROBE_WIDTH, PROBE_HEIGHT)
        const frame = new VideoFrame(canvas, { timestamp: (i * 1e6) / 30, duration: 1e6 / 30 })
        encoder.encode(frame, { keyFrame: i === 0 })
        frame.close()
      }
      await encoder.flush()
    } catch {
      failed = true
    } finally {
      try {
        encoder.close()
      } catch {
        // already closed
      }
    }

    if (!failed && chunks > 0) {
      return { codec: candidate.label, ms: Math.round(performance.now() - started) }
    }
  }
  return { codec: null, ms: null }
}

/**
 * Whether the output can carry sound.
 *
 * `ensureAacEncoder` runs FIRST so the WASM fallback is registered before the
 * question is asked: a browser whose `AudioEncoder` has no AAC would otherwise
 * be turned away at the door for a gap the fallback closes. Asking mediabunny
 * rather than `AudioEncoder` directly is what makes the registered encoder
 * count.
 */
async function probeAudioEncoder(): Promise<boolean> {
  try {
    const { canEncodeAudio, ensureAacEncoder } = await import('../engine/media')
    await ensureAacEncoder()
    if (await canEncodeAudio('aac')) return true
  } catch {
    // fall through to the native probe below
  }
  if (typeof AudioEncoder === 'undefined') return false
  for (const codec of ['mp4a.40.2', 'opus']) {
    try {
      const support = await AudioEncoder.isConfigSupported({
        codec,
        sampleRate: 48000,
        numberOfChannels: 2,
        bitrate: 192_000
      })
      if (support.supported) return true
    } catch {
      // try the next one
    }
  }
  return false
}

/**
 * Where a passing probe is remembered for the rest of the session.
 *
 * The probe is a real encode plus, on a browser without native AAC, a WASM
 * fetch — half a second to a few seconds on every page open, for an answer
 * that does not change between reloads of the same build in the same
 * browser. The key names both: a new build (the module's hashed URL changes)
 * or a different browser re-probes. Only `ok: true` is cached — a refusal is
 * cheap to repeat and must not outlive whatever the user changes to fix it.
 * Storage access can throw (private windows, blocked site data), and the
 * probe is the fallback, so every touch is wrapped.
 */
export const CAPABILITY_CACHE_PREFIX = 'noey.capabilities.v1'

export function capabilityCacheKey(
  ua = typeof navigator !== 'undefined' ? navigator.userAgent : '',
  build = import.meta.url
): string {
  // The pathname of a Vite build's module carries its content hash; the
  // origin does not matter and the query (dev server timestamps) must not.
  let buildId = build
  try {
    buildId = new URL(build).pathname
  } catch {
    // not a URL in a test runner; use it as given
  }
  return `${CAPABILITY_CACHE_PREFIX}:${buildId}:${ua}`
}

export function readCachedCapabilities(key: string): Capabilities | null {
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Capabilities>
    if (parsed.ok !== true || !Array.isArray(parsed.missing)) return null
    return parsed as Capabilities
  } catch {
    return null
  }
}

export function writeCachedCapabilities(key: string, caps: Capabilities): void {
  if (!caps.ok) return
  try {
    sessionStorage.setItem(key, JSON.stringify(caps))
  } catch {
    // no storage, no cache — the probe runs again next time
  }
}

export async function detectCapabilities(): Promise<Capabilities> {
  const key = capabilityCacheKey()
  const cached = readCachedCapabilities(key)
  if (cached) return cached
  const caps = await probeCapabilities()
  writeCachedCapabilities(key, caps)
  return caps
}

async function probeCapabilities(): Promise<Capabilities> {
  const missing: string[] = []

  // Not just "is there an OPFS" — can this browser WRITE to it? Safari has
  // the directory API and no `createWritable`, so the old check let an iPhone
  // all the way to "เริ่มตัดต่อ" before failing on the first write. The probe
  // resolves to the worker fallback where that is what works.
  let hasOpfs = typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory
  if (hasOpfs) {
    const { writeCapability } = await import('./opfsWrite')
    hasOpfs = (await writeCapability()) !== 'none'
  }
  if (!hasOpfs) missing.push('ที่เก็บไฟล์ของเว็บ')

  const hasServiceWorker = typeof navigator !== 'undefined' && 'serviceWorker' in navigator
  if (!hasServiceWorker) missing.push('การเล่นไฟล์ในเครื่อง')

  const { codec, ms } = await probeVideoEncoder()
  if (!codec) missing.push('การประมวลผลวิดีโอ')

  const hasAudioEncoder = await probeAudioEncoder()
  if (!hasAudioEncoder) missing.push('การประมวลผลเสียง')

  return {
    ok: missing.length === 0,
    missing,
    videoCodec: codec,
    hasAudioEncoder,
    hasOpfs,
    hasServiceWorker,
    probeMs: ms
  }
}
