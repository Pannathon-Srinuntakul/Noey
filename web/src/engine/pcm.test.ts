/**
 * The streamed audio path's arithmetic, exercised without a browser.
 *
 * `decodeAudioData` gave every caller a correct buffer for free; the streamed
 * decoder rebuilds that from packets, and the ways it could be subtly wrong
 * (a sample-exact drift after a gap, a resampler that aliases, a boundary
 * glitch between packets) all survive a code review. So they are measured.
 */
import { describe, expect, it } from 'vitest'
import { PcmAssembler, framesFor, wav16Bytes, wav16Chunks } from './pcm'

function sine(freq: number, rate: number, frames: number, phase0 = 0): Float32Array {
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i++) out[i] = Math.sin(phase0 + (2 * Math.PI * freq * i) / rate)
  return out
}

function rms(a: Float32Array, from = 0, to = a.length): number {
  let s = 0
  for (let i = from; i < to; i++) s += a[i] * a[i]
  return Math.sqrt(s / Math.max(1, to - from))
}

/** Feed `signal` to an assembler in packet-sized chunks, as the decoder would. */
function run(
  signal: Float32Array[],
  srcRate: number,
  dstRate: number,
  outFrames: number,
  chunk = 1024
): Float32Array[] {
  const out = signal.map(() => new Float32Array(outFrames))
  const a = new PcmAssembler({ srcRate, dstRate, out })
  const n = signal[0].length
  for (let at = 0; at < n; at += chunk) {
    a.push(
      signal.map((ch) => ch.subarray(at, Math.min(n, at + chunk))),
      at
    )
  }
  return a.finish()
}

describe('PcmAssembler at the same rate', () => {
  it('copies samples through untouched', () => {
    const src = sine(1000, 48000, 5000)
    const [out] = run([src], 48000, 48000, 5000, 700)
    expect(out).toEqual(src)
  })

  it('fills a gap with silence and keeps what follows on the clock', () => {
    const out = [new Float32Array(10)]
    const a = new PcmAssembler({ srcRate: 8000, dstRate: 8000, out })
    a.push([Float32Array.of(1, 1)], 0)
    a.push([Float32Array.of(2, 2)], 5) // frames 2..4 are a hole
    a.finish()
    expect(Array.from(out[0])).toEqual([1, 1, 0, 0, 0, 2, 2, 0, 0, 0])
  })

  it('trims the head of a chunk that overlaps what was already placed', () => {
    const out = [new Float32Array(6)]
    const a = new PcmAssembler({ srcRate: 8000, dstRate: 8000, out })
    a.push([Float32Array.of(1, 2, 3)], 0)
    a.push([Float32Array.of(9, 9, 4, 5)], 1) // 9,9 re-cover frames 1..2
    a.finish()
    expect(Array.from(out[0])).toEqual([1, 2, 3, 4, 5, 0])
  })

  it('drops a chunk that starts before zero, keeping only its in-range tail', () => {
    // An edit list can put the first packet's timestamp below the window.
    const out = [new Float32Array(4)]
    const a = new PcmAssembler({ srcRate: 8000, dstRate: 8000, out })
    a.push([Float32Array.of(7, 7, 1, 2)], -2)
    a.finish()
    expect(Array.from(out[0])).toEqual([1, 2, 0, 0])
  })

  it('never writes past the output length', () => {
    const out = [new Float32Array(3)]
    const a = new PcmAssembler({ srcRate: 8000, dstRate: 8000, out })
    a.push([Float32Array.of(1, 2, 3, 4, 5)], 0)
    expect(Array.from(a.finish()[0])).toEqual([1, 2, 3])
  })

  it('mixes stereo to mono as the mean, and doubles mono to stereo', () => {
    const mono = [new Float32Array(2)]
    new PcmAssembler({ srcRate: 8000, dstRate: 8000, out: mono }).push(
      [Float32Array.of(1, 0.5), Float32Array.of(0, 0.5)],
      0
    )
    expect(Array.from(mono[0])).toEqual([0.5, 0.5])

    const stereo = [new Float32Array(2), new Float32Array(2)]
    new PcmAssembler({ srcRate: 8000, dstRate: 8000, out: stereo }).push([Float32Array.of(1, 2)], 0)
    expect(Array.from(stereo[0])).toEqual([1, 2])
    expect(Array.from(stereo[1])).toEqual([1, 2])
  })
})

describe('PcmAssembler resampling', () => {
  it('48 kHz → 16 kHz keeps a 1 kHz tone (speech band) intact', () => {
    const seconds = 0.5
    const src = sine(1000, 48000, 48000 * seconds)
    const [out] = run([src], 48000, 16000, 16000 * seconds)
    const want = sine(1000, 16000, 16000 * seconds)
    // Skip the filter's warm-up at either end.
    let err = 0
    for (let i = 200; i < out.length - 200; i++) err = Math.max(err, Math.abs(out[i] - want[i]))
    expect(err).toBeLessThan(0.02)
  })

  it('48 kHz → 16 kHz removes a 10 kHz tone instead of aliasing it into the band', () => {
    // Above the 8 kHz output Nyquist: linear interpolation would fold this
    // down to 6 kHz at nearly full level and hand the transcriber noise.
    const src = sine(10000, 48000, 48000)
    const [out] = run([src], 48000, 16000, 16000)
    expect(rms(out, 200, out.length - 200)).toBeLessThan(0.03)
  })

  it('44.1 kHz → 48 kHz keeps a 1 kHz tone intact (iPhone footage into the mix)', () => {
    const src = sine(1000, 44100, 44100)
    const [out] = run([src], 44100, 48000, 48000)
    const want = sine(1000, 48000, 48000)
    let err = 0
    for (let i = 200; i < out.length - 200; i++) err = Math.max(err, Math.abs(out[i] - want[i]))
    expect(err).toBeLessThan(0.02)
  })

  it('44.1 kHz → 48 kHz keeps DC at unity across every phase', () => {
    const src = new Float32Array(44100).fill(0.5)
    const [out] = run([src], 44100, 48000, 48000)
    for (let i = 100; i < out.length - 100; i++) expect(Math.abs(out[i] - 0.5)).toBeLessThan(1e-3)
  })

  it('is the same whatever the packet size — no seam at a chunk boundary', () => {
    const src = sine(440, 44100, 22050)
    const a = run([src], 44100, 48000, 24000, 1024)[0]
    const b = run([src], 44100, 48000, 24000, 333)[0]
    let diff = 0
    for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i] - b[i]))
    expect(diff).toBeLessThan(1e-5)
  })

  it('fills the requested length even when the source is short', () => {
    const [out] = run([sine(440, 44100, 4410)], 44100, 48000, 9600)
    expect(out.length).toBe(9600)
    // The second half had no source: silence, not garbage.
    expect(rms(out, 6000)).toBe(0)
  })
})

describe('framesFor', () => {
  it('rounds up and is safe against float noise', () => {
    expect(framesFor(1, 48000)).toBe(48000)
    expect(framesFor(0.1 + 0.2, 10)).toBe(3)
    expect(framesFor(-1, 48000)).toBe(0)
  })
})

describe('wav16Chunks', () => {
  it('writes a valid 16-bit mono header and the samples after it', () => {
    const chunks = [...wav16Chunks(Float32Array.of(0, 0.5, -0.5, 1), 1, 16000, 3)]
    const total = chunks.reduce((n, c) => n + c.byteLength, 0)
    expect(total).toBe(wav16Bytes(4))
    const header = chunks[0]
    const view = new DataView(header.buffer)
    expect(String.fromCharCode(...header.subarray(0, 4))).toBe('RIFF')
    expect(String.fromCharCode(...header.subarray(8, 12))).toBe('WAVE')
    expect(view.getUint16(22, true)).toBe(1) // mono
    expect(view.getUint32(24, true)).toBe(16000)
    expect(view.getUint32(40, true)).toBe(8)
    // Two data chunks for 4 frames at 3 per chunk.
    expect(chunks.length).toBe(3)
    const data = new DataView(chunks[1].buffer)
    expect(data.getInt16(0, true)).toBe(0)
    // `setInt16` truncates, as the original `encodeWav16` did.
    expect(data.getInt16(2, true)).toBe(Math.trunc(0.5 * 0x7fff))
    expect(data.getInt16(4, true)).toBe(-0x4000)
  })

  it('applies the gain and clamps', () => {
    const chunks = [...wav16Chunks(Float32Array.of(0.9), 2, 16000)]
    expect(new DataView(chunks[1].buffer).getInt16(0, true)).toBe(0x7fff)
  })
})
