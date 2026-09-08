/** Shared audio waveform decoding — Web Audio API, no extra dependency needed.
 * Used by TimelineEditor's music track and the wizard's MusicRangePicker. */

export interface WaveformPeaks {
  peaks: number[]
  durationSec: number
}

/** Fetch + decode an audio source into a max-per-bucket peak array for a
 * waveform canvas. `src` can be any fetchable URL — a media:// URL (project
 * file) or a blob: object URL (a File not yet on disk anywhere). */
export async function decodeAudioPeaks(src: string, buckets = 400): Promise<WaveformPeaks> {
  const buf = await (await fetch(src)).arrayBuffer()
  const audioCtx = new AudioContext()
  try {
    const audioBuf = await audioCtx.decodeAudioData(buf)
    const channel = audioBuf.getChannelData(0)
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
    return { peaks, durationSec: audioBuf.duration }
  } finally {
    void audioCtx.close()
  }
}
