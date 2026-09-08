/**
 * Mono 16-bit PCM WAV assembly for the voiceover recorder.
 *
 * `MediaRecorder` gives us one WebM/Opus blob per line. ffmpeg could stitch
 * those, but the gaps between lines matter — the AI plans the cut against the
 * voiceover's timing — so the join is done here where the exact sample counts
 * are known, and the result handed to the existing render path as one file.
 *
 * Mono and 16-bit because this is speech destined for a mux: a stereo or
 * float32 master would be larger for no audible gain.
 */

export const VO_SAMPLE_RATE = 48_000

/** Silence inserted between two spoken lines, so they do not run together. */
export const LINE_GAP_SEC = 0.35

export interface WavPlan {
  /** Where each line starts in the assembled file, seconds. */
  lineStarts: number[]
  totalSec: number
}

/**
 * Where every line lands once the takes are laid end to end with a fixed gap.
 * Split out from the encoder so the timing can be checked without audio.
 */
export function planLineLayout(durations: number[], gapSec = LINE_GAP_SEC): WavPlan {
  const lineStarts: number[] = []
  let cursor = 0
  durations.forEach((d, i) => {
    lineStarts.push(cursor)
    cursor += Math.max(0, d)
    if (i < durations.length - 1) cursor += gapSec
  })
  return { lineStarts, totalSec: cursor }
}

/** Interleave nothing — mono only. Values outside [-1, 1] are clipped. */
function writeSamples(view: DataView, offset: number, samples: Float32Array): number {
  let pos = offset
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    // Asymmetric scaling: 32767 up, 32768 down — the full int16 range.
    view.setInt16(pos, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    pos += 2
  }
  return pos
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
}

/**
 * Concatenate mono float PCM chunks into one 16-bit WAV, separated by silence.
 *
 * Returns the bytes plus the layout, so the caller can persist where each line
 * begins without measuring the file again.
 */
export function encodeVoiceoverWav(
  chunks: Float32Array[],
  sampleRate = VO_SAMPLE_RATE,
  gapSec = LINE_GAP_SEC
): { bytes: Uint8Array; plan: WavPlan } {
  const gapSamples = Math.round(gapSec * sampleRate)
  const totalSamples =
    chunks.reduce((sum, c) => sum + c.length, 0) + gapSamples * Math.max(0, chunks.length - 1)

  const dataBytes = totalSamples * 2
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // PCM header size
  view.setUint16(20, 1, true) // format: PCM
  view.setUint16(22, 1, true) // channels: mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate (mono, 2 bytes/sample)
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)

  let offset = 44
  chunks.forEach((chunk, i) => {
    offset = writeSamples(view, offset, chunk)
    if (i < chunks.length - 1) {
      // The buffer is already zero-filled, so silence is just a skip.
      offset += gapSamples * 2
    }
  })

  return {
    bytes: new Uint8Array(buffer),
    plan: planLineLayout(
      chunks.map((c) => c.length / sampleRate),
      gapSec
    )
  }
}
