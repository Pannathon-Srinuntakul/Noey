/**
 * Decode an audio track packet by packet into an `AudioBuffer`.
 *
 * The old path was `blob.arrayBuffer()` → `decodeAudioData`: the WHOLE source
 * video read into memory, then the whole track decoded at native rate before
 * a resample — multi-gigabyte for a 2 h talking-head clip, on a phone. Here
 * the demuxer reads only the audio packets it needs, each one is decoded and
 * dropped, and the samples land in a buffer sized up front from the track's
 * duration (or the requested range). Peak memory is the OUTPUT, nothing else.
 *
 * Returns null where the streamed path cannot apply — no audio track, or a
 * codec this browser's `AudioDecoder` will not open — so the caller can fall
 * back to `decodeAudioData` on an audio-only demux (`media.demuxAudioOnly`).
 */

import { ALL_FORMATS, AudioSampleSink, BlobSource, Input, type InputAudioTrack } from 'mediabunny'
import { PcmAssembler, framesFor } from './pcm'

export interface DecodeRange {
  sampleRate: number
  /** 1 = mono mix, 2 = stereo, 'source' = the track's own layout capped at two. */
  channels: 1 | 2 | 'source'
  /** Source-clock window; the whole track when omitted. */
  startSec?: number
  endSec?: number
  signal?: AbortSignal
}

export interface AudioSource {
  sampleRate: number
  channels: number
  durationSec: number
  decode(range: DecodeRange): Promise<AudioBuffer>
  close(): void
}

/**
 * Open a source's audio track once, for several range decodes.
 *
 * `render-timeline` decodes every cut's own window from the clip it comes
 * from; opening the container per cut would re-read the index each time.
 */
export async function openAudioSource(blob: Blob): Promise<AudioSource | null> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) })
  let track: InputAudioTrack | null
  try {
    track = await input.getPrimaryAudioTrack()
    if (!track || !(await track.canDecode())) {
      input.dispose()
      return null
    }
  } catch {
    input.dispose()
    return null
  }
  const sampleRate = await track.getSampleRate()
  const channels = await track.getNumberOfChannels()
  const durationSec = await track.computeDuration()
  const audioTrack = track

  return {
    sampleRate,
    channels,
    durationSec,
    decode: (range) => decodeTrack(audioTrack, { sampleRate, channels, durationSec }, range),
    close: () => input.dispose()
  }
}

/** One-shot: open, decode, close. */
export async function decodeAudioStreamed(
  blob: Blob,
  range: DecodeRange
): Promise<AudioBuffer | null> {
  const source = await openAudioSource(blob)
  if (!source) return null
  try {
    return await source.decode(range)
  } finally {
    source.close()
  }
}

async function decodeTrack(
  track: InputAudioTrack,
  info: { sampleRate: number; channels: number; durationSec: number },
  range: DecodeRange
): Promise<AudioBuffer> {
  const start = Math.max(0, range.startSec ?? 0)
  const end = range.endSec ?? info.durationSec
  const outFrames = Math.max(1, framesFor(end - start, range.sampleRate))
  const dstChannels =
    range.channels === 'source' ? Math.min(2, Math.max(1, info.channels)) : range.channels

  // Written straight into the AudioBuffer's own channel storage. `getChannelData`
  // is a view onto it until the buffer is first played, so this is the one
  // place a full-size copy is avoided.
  const buffer = new AudioBuffer({
    length: outFrames,
    numberOfChannels: dstChannels,
    sampleRate: range.sampleRate
  })
  const out: Float32Array[] = []
  for (let c = 0; c < dstChannels; c++) out.push(buffer.getChannelData(c))

  // The assembly is set up from the FIRST DECODED sample, not the track's
  // metadata: an HE-AAC track declares half the rate its decoder produces
  // (SBR doubles it), and building the resampler on the declared figure
  // would play such a clip at half speed.
  let assembler: PcmAssembler | null = null
  let srcRate = info.sampleRate
  let srcChannels = Math.max(1, info.channels)
  const planar: Float32Array[] = []

  const sink = new AudioSampleSink(track)
  for await (const sample of sink.samples(start, end)) {
    try {
      if (range.signal?.aborted) throw new DOMException('ยกเลิกแล้ว', 'AbortError')
      if (!assembler) {
        srcRate = sample.sampleRate || srcRate
        srcChannels = Math.max(1, sample.numberOfChannels || srcChannels)
        assembler = new PcmAssembler({ srcRate, dstRate: range.sampleRate, out })
      }
      const frames = sample.numberOfFrames
      const chans = Math.max(1, Math.min(sample.numberOfChannels, srcChannels))
      for (let c = 0; c < srcChannels; c++) {
        if (!planar[c] || planar[c].length !== frames) planar[c] = new Float32Array(frames)
        // A sample with fewer channels than the first one (it happens on odd
        // encodes) copies what it has and leaves the rest silent.
        if (c < chans) sample.copyTo(planar[c], { planeIndex: c, format: 'f32-planar' })
        else planar[c].fill(0)
      }
      // The sample's clock is the track's; the assembly's zero is `start`.
      const atSrcFrame = Math.round((sample.timestamp - start) * srcRate)
      assembler.push(planar.slice(0, srcChannels), atSrcFrame)
    } finally {
      sample.close()
    }
  }
  assembler?.finish()
  return buffer
}
