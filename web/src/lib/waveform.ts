/** Shared audio waveform decoding — Web Audio API, no extra dependency needed.
 * Used by TimelineEditor's music track and the wizard's MusicRangePicker. */

export interface WaveformPeaks {
  peaks: number[]
  durationSec: number
}

/**
 * Peaks already computed this session, by source URL. A five-minute stereo
 * track is ~100 MB of Float32 PCM to decode; the editor used to redo it on
 * every mount (leave the editor, come back, decode again), and the decode
 * ran on after the screen that asked for it had gone.
 */
const cache = new Map<string, Promise<WaveformPeaks>>()

/** Test seam. */
export function resetWaveformCache(): void {
  cache.clear()
}

/** Fetch + decode an audio source into a max-per-bucket peak array for a
 * waveform canvas. `src` can be any fetchable URL — a media:// URL (project
 * file) or a blob: object URL (a File not yet on disk anywhere).
 *
 * `signal` aborts the FETCH; a decode already under way finishes (Web Audio
 * cannot be cancelled) but its result still goes into the cache for the
 * next caller. A blob: URL is never cached — the caller revokes it. */
export async function decodeAudioPeaks(
  src: string,
  buckets = 400,
  signal?: AbortSignal
): Promise<WaveformPeaks> {
  const cacheable = !src.startsWith('blob:') && buckets === 400
  const hit = cacheable ? cache.get(src) : undefined
  if (hit) return hit
  const work = (async () => {
    const buf = await (await fetch(src, { signal })).arrayBuffer()
    const audioCtx = new AudioContext()
    try {
      const audioBuf = await audioCtx.decodeAudioData(buf)
      return { peaks: peaksOf(audioBuf.getChannelData(0), buckets), durationSec: audioBuf.duration }
    } finally {
      void audioCtx.close()
    }
  })()
  if (cacheable) {
    cache.set(src, work)
    // A failed decode must not poison the cache: the next caller retries.
    work.catch(() => cache.delete(src))
  }
  return work
}

/** Max |sample| per bucket. Exported for its test. */
export function peaksOf(channel: Float32Array, buckets: number): number[] {
  const step = Math.max(1, Math.floor(channel.length / buckets))
  const peaks: number[] = []
  for (let i = 0; i < channel.length; i += step) {
    let max = 0
    for (let j = i; j < Math.min(i + step, channel.length); j++) {
      const v = Math.abs(channel[j])
      if (v > max) max = v
    }
    peaks.push(max)
  }
  return peaks
}
