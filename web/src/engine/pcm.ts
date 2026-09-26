/**
 * PCM assembly: decoded audio chunks → one fixed-length, fixed-rate buffer.
 *
 * `decodeAudioData` needs the WHOLE file in an ArrayBuffer and then decodes
 * the whole track at its native rate before resampling — for a 2 h source
 * video that is a multi-gigabyte read plus ~2.7 GB of transient PCM, on the
 * tab with the least memory to spare. The streamed path decodes packet by
 * packet instead, and this module is the part that turns those packets into
 * the buffer everything downstream expects: it puts each chunk on one
 * contiguous clock (gaps become silence, overlaps are trimmed), mixes it to
 * the wanted channel count and resamples it straight into a preallocated
 * output. Nothing here touches the DOM, which is what makes it testable.
 *
 * The resampler is a windowed-sinc polyphase FIR. A plain linear interpolation
 * would have been ten lines, and would also have aliased everything above 8 kHz
 * into the 16 kHz speech track the transcriber reads — and imaged iPhone
 * footage's 44.1 kHz audio on its way to the 48 kHz mix. Same-rate input is
 * copied through untouched, so the common 48 kHz case stays exact.
 */

export interface PcmAssemblerOptions {
  srcRate: number
  dstRate: number
  /**
   * The output arrays, one per destination channel, each already sized to the
   * wanted length. Preallocated by the caller so an `AudioBuffer`'s own channel
   * storage can be written directly — a second full-size copy would undo half
   * the point.
   */
  out: Float32Array[]
}

/** Half the FIR length, scaled with the decimation ratio so a downsample keeps its stop band. */
function halfTapsFor(srcRate: number, dstRate: number): number {
  return Math.min(32, 8 * Math.ceil(Math.max(1, srcRate / dstRate)))
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b]
  return a
}

/**
 * Coefficient table: one FIR per phase. Output frame n sits at source position
 * n·M/L; its fractional part selects the phase, so the table has L rows.
 */
function buildTable(srcRate: number, dstRate: number, half: number): Float32Array[] {
  const g = gcd(srcRate, dstRate)
  const phases = dstRate / g
  const taps = 2 * half
  // Cut-off just under the narrower of the two Nyquists, in cycles per source
  // sample; the 0.9 leaves the transition band room inside the stop band.
  const fc = 0.5 * Math.min(1, dstRate / srcRate) * 0.9
  const table: Float32Array[] = []
  for (let p = 0; p < phases; p++) {
    const frac = p / phases
    const row = new Float32Array(taps)
    let sum = 0
    for (let k = 0; k < taps; k++) {
      const x = k - half + 1 - frac
      const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x)
      // Hann over the tap span.
      const w = 0.5 + 0.5 * Math.cos((Math.PI * x) / half)
      row[k] = sinc * w
      sum += row[k]
    }
    // Unity DC gain per phase, so a level does not wobble with the phase.
    for (let k = 0; k < taps; k++) row[k] /= sum
    table.push(row)
  }
  return table
}

export class PcmAssembler {
  private readonly srcRate: number
  private readonly dstRate: number
  private readonly dstChannels: number
  private readonly out: Float32Array[]
  private readonly outFrames: number

  /** Next SOURCE frame the assembly expects; chunks are placed against it. */
  private expected = 0

  // Resampler state. `history` holds the last `taps - 1` mixed source frames
  // per channel so a chunk boundary is invisible to the filter; `srcIndex` is
  // the absolute source index of history[0]; `nextOut` the next output frame.
  private readonly passthrough: boolean
  private readonly half: number
  private readonly table: Float32Array[]
  private readonly phases: number
  private readonly step: number
  private history: Float32Array[]
  private historyLen = 0
  private srcIndex = 0
  private nextOut = 0

  constructor(opts: PcmAssemblerOptions) {
    this.srcRate = opts.srcRate
    this.dstRate = opts.dstRate
    this.out = opts.out
    this.dstChannels = opts.out.length
    this.outFrames = opts.out[0]?.length ?? 0
    this.passthrough = this.srcRate === this.dstRate
    this.half = this.passthrough ? 0 : halfTapsFor(this.srcRate, this.dstRate)
    this.table = this.passthrough ? [] : buildTable(this.srcRate, this.dstRate, this.half)
    const g = gcd(this.srcRate, this.dstRate)
    this.phases = this.dstRate / g
    this.step = this.srcRate / g
    this.history = []
    for (let c = 0; c < this.dstChannels; c++) this.history.push(new Float32Array(0))
  }

  /** Output frames written so far (the rest of `out` is still silence). */
  get producedFrames(): number {
    return this.passthrough ? Math.min(this.outFrames, this.expected) : this.nextOut
  }

  /**
   * Place a planar chunk whose first frame is source frame `atSrcFrame`.
   *
   * Timestamps in a real file are not a perfect ladder: an edit list can start
   * the track below zero, a decoder can hand back a packet that overlaps the
   * previous one by a few frames, and a concatenated recording can have a
   * hole. Rather than trust each chunk's position, the assembly keeps its own
   * clock — the frame it expects next — and reconciles: a chunk ahead of it
   * gets silence before it, a chunk behind it loses its already-covered head.
   */
  push(chunk: Float32Array[], atSrcFrame: number): void {
    const frames = chunk[0]?.length ?? 0
    if (frames === 0) return
    let offset = 0
    if (atSrcFrame > this.expected) {
      this.feedSilence(atSrcFrame - this.expected)
    } else if (atSrcFrame < this.expected) {
      offset = this.expected - atSrcFrame
      if (offset >= frames) return
    }
    this.feed(this.mix(chunk, offset, frames - offset))
  }

  /** Flush the filter's tail. `out` is complete afterwards. */
  finish(): Float32Array[] {
    if (!this.passthrough) this.feedSilence(2 * this.half)
    return this.out
  }

  private feedSilence(frames: number): void {
    const SLICE = 65536
    let left = frames
    while (left > 0) {
      const n = Math.min(SLICE, left)
      const silence: Float32Array[] = []
      for (let c = 0; c < this.dstChannels; c++) silence.push(new Float32Array(n))
      this.feed(silence)
      left -= n
    }
  }

  /** Channel layout: mono is the mean of every source channel, stereo takes the first two (a mono source is doubled). */
  private mix(chunk: Float32Array[], offset: number, frames: number): Float32Array[] {
    const src = chunk.length
    const mixed: Float32Array[] = []
    if (this.dstChannels === 1) {
      const m = new Float32Array(frames)
      if (src === 1) {
        m.set(chunk[0].subarray(offset, offset + frames))
      } else {
        const scale = 1 / src
        for (let c = 0; c < src; c++) {
          const ch = chunk[c]
          for (let i = 0; i < frames; i++) m[i] += ch[offset + i] * scale
        }
      }
      mixed.push(m)
    } else {
      for (let c = 0; c < this.dstChannels; c++) {
        const from = chunk[Math.min(c, src - 1)]
        mixed.push(from.subarray(offset, offset + frames))
      }
    }
    return mixed
  }

  /** Mixed, contiguous frames at the source rate → the output. */
  private feed(mixed: Float32Array[]): void {
    const frames = mixed[0].length
    if (this.passthrough) {
      const at = this.expected
      const n = Math.min(frames, this.outFrames - at)
      if (n > 0)
        for (let c = 0; c < this.dstChannels; c++) this.out[c].set(mixed[c].subarray(0, n), at)
      this.expected += frames
      return
    }
    this.expected += frames

    // Append to the history window, then run the filter over every output
    // frame whose taps are now fully available.
    const taps = 2 * this.half
    const joined: Float32Array[] = []
    for (let c = 0; c < this.dstChannels; c++) {
      const j = new Float32Array(this.historyLen + frames)
      j.set(this.history[c].subarray(0, this.historyLen), 0)
      j.set(mixed[c], this.historyLen)
      joined.push(j)
    }
    const avail = this.historyLen + frames

    // Output n reads source frames [i - half + 1, i + half] with i = floor(n·M/L).
    let n = this.nextOut
    for (;;) {
      if (n >= this.outFrames) break
      const pos = n * this.step
      const i = Math.floor(pos / this.phases)
      const phase = pos - i * this.phases
      const start = i - this.half + 1 - this.srcIndex
      if (start + taps > avail) break
      if (start < 0) {
        // Before the first frame: only happens for the first `half` outputs,
        // whose left taps read silence.
        const row = this.table[phase]
        for (let c = 0; c < this.dstChannels; c++) {
          let acc = 0
          const j = joined[c]
          for (let k = -start; k < taps; k++) acc += row[k] * j[start + k]
          this.out[c][n] = acc
        }
      } else {
        const row = this.table[phase]
        for (let c = 0; c < this.dstChannels; c++) {
          let acc = 0
          const j = joined[c]
          for (let k = 0; k < taps; k++) acc += row[k] * j[start + k]
          this.out[c][n] = acc
        }
      }
      n += 1
    }
    this.nextOut = n

    // Keep only what a later output can still read: the frames from the next
    // output's first tap onward.
    const nextPos = n * this.step
    const nextI = Math.floor(nextPos / this.phases)
    const keepFrom = Math.max(0, nextI - this.half + 1 - this.srcIndex)
    const keep = Math.max(0, avail - keepFrom)
    for (let c = 0; c < this.dstChannels; c++) {
      if (this.history[c].length < keep)
        this.history[c] = new Float32Array(Math.max(keep, taps * 2))
      this.history[c].set(joined[c].subarray(keepFrom, keepFrom + keep), 0)
    }
    this.historyLen = keep
    this.srcIndex += keepFrom
  }
}

/** Frames a span of `sec` seconds occupies at `rate`, rounded up so nothing is cut short. */
export function framesFor(sec: number, rate: number): number {
  return Math.max(0, Math.ceil(sec * rate - 1e-6))
}

/**
 * The chunks of a 16-bit mono WAV, header first. Yielded rather than built so
 * a long track streams to disk instead of existing twice in memory (the
 * float samples and the file) — 2 h at 16 kHz is 230 MB of file on top of
 * 460 MB of samples.
 */
export function* wav16Chunks(
  samples: Float32Array,
  gain: number,
  sampleRate: number,
  chunkFrames = 1 << 20
): Generator<Uint8Array> {
  const header = new Uint8Array(44)
  const view = new DataView(header.buffer)
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  yield header

  for (let from = 0; from < samples.length; from += chunkFrames) {
    const n = Math.min(chunkFrames, samples.length - from)
    const bytes = new Uint8Array(n * 2)
    const out = new DataView(bytes.buffer)
    for (let i = 0; i < n; i++) {
      const v = Math.max(-1, Math.min(1, samples[from + i] * gain))
      out.setInt16(i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true)
    }
    yield bytes
  }
}

/** Byte length of the WAV `wav16Chunks` produces for `frames` samples. */
export function wav16Bytes(frames: number): number {
  return 44 + frames * 2
}
