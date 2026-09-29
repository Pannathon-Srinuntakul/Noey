/**
 * Audio: the mix, and the WAV the speech modes upload.
 *
 * `mix_audio_layers` in `dub_render.py` is an ffmpeg filter chain; the same
 * thing here is an `OfflineAudioContext` graph, and the parameter meanings are
 * carried over one for one because the editor's controls were designed against
 * them:
 *
 *   trim-in / trim-out   where the track starts and stops INSIDE the file
 *   offset               where the track starts on the OUTPUT clock
 *   volume               a plain gain on the music only
 *
 * Order matters and is the same: trim first, then place, then attenuate. The
 * desktop's `-ss`/`-to` seek on the INPUT rather than using an `atrim` filter
 * so the stream still starts at zero for the delay that follows; slicing the
 * decoded buffer here has exactly that property.
 *
 * The VO/music sum is a plain addition. The desktop's `amix` passes
 * `normalize=0` deliberately — normalising halves the voiceover the moment a
 * music bed appears — so nothing is scaled here either.
 */

import { demuxAudioOnly, encodeVideo, openVideo, probeSource, remuxWithAudio } from './media'
import { decodeAudioStreamed } from './audioStream'
import { wav16Bytes, wav16Chunks } from './pcm'
import { blobForPath } from './jobs/probe'

/** Everything downstream (the mux, the encoder) works at this rate. */
export const MIX_SAMPLE_RATE = 48000
const MIX_CHANNELS = 2

/** ElevenLabs Scribe's fast path — matches `audio_extract.py`. */
export const STT_SAMPLE_RATE = 16000

/** Decode any audio-bearing blob at the mix's rate. */
export async function decodeBlob(blob: Blob, signal?: AbortSignal): Promise<AudioBuffer> {
  return decode(blob, MIX_SAMPLE_RATE, MIX_CHANNELS, signal)
}

/**
 * Three ways in, cheapest first.
 *
 *   streamed     packets decoded one at a time into a buffer sized from the
 *                track (`audioStream.ts`). Memory is the output alone. Mono
 *                is mixed down here when asked for.
 *   audio-only   the track packet-copied into a small MP4, then
 *                `decodeAudioData` — for a codec the streamed decoder will not
 *                open. Whole-file, but the file is the audio, not the video.
 *   whole blob   the original path, kept for the audio-only file (a music bed,
 *                a voiceover) whose whole size IS its audio, and for a
 *                container the muxer cannot carry.
 *
 * `decodeAudioData` returns the file's own channel count; `channels` only
 * bounds the streamed result. Callers that need one layout mix down after.
 */
async function decode(
  blob: Blob,
  sampleRate: number,
  channels: 1 | 2,
  signal?: AbortSignal
): Promise<AudioBuffer> {
  try {
    const streamed = await decodeAudioStreamed(blob, { sampleRate, channels, signal })
    if (streamed) return streamed
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err
    logDecode(`streamed decode failed, falling back: ${String(err)}`)
  }
  const audioOnly = await demuxAudioOnly(blob, signal)
  const bytes = await (audioOnly ?? blob).arrayBuffer()
  // A one-frame context just to decode; the real graph is built after.
  const probe = new OfflineAudioContext(channels, 1, sampleRate)
  return probe.decodeAudioData(bytes)
}

function logDecode(line: string): void {
  if (typeof window === 'undefined' || !window.noey?.log) return
  void window.noey.log.write('audio', line)
}

export interface MusicMixOptions {
  musicPath: string
  volume: number
  offsetSec: number
  trimInSec: number
  trimOutSec: number | null
  width: number
  height: number
  fps: number
}

/**
 * Put a music bed under an already-rendered silent video.
 *
 * The picture is COPIED, not re-encoded — `remuxWithAudio` carries the encoded
 * packets across, which is what the desktop's `vcodec=copy` does. A re-encode
 * of an 8 s clip took 46 s and cost a generation of quality every time someone
 * nudged the volume; the copy takes under 2 s and costs nothing. The re-encode
 * survives only as the fallback for a file whose packets cannot be copied.
 */
export async function mixMusicOnto(
  video: Blob,
  opts: MusicMixOptions,
  signal?: AbortSignal
): Promise<Blob> {
  const info = await probeSource(video)
  const music = await decode(await blobForPath(opts.musicPath), MIX_SAMPLE_RATE, MIX_CHANNELS)

  const audio = await renderMix({
    durationSec: info.durationSec,
    music,
    musicVolume: opts.volume,
    musicOffsetSec: opts.offsetSec,
    musicTrimInSec: opts.trimInSec,
    musicTrimOutSec: opts.trimOutSec,
    voice: null
  })

  const copied = await remuxWithAudio(video, audio)
  if (copied) return copied

  const reader = await openVideo(video)
  const frames = Math.max(1, Math.round(info.durationSec * opts.fps))
  // Sequential, like every other full-clip pass in the engine — a seek per
  // frame is roughly 13x slower on a long source.
  const stamps: number[] = []
  for (let f = 0; f < frames; f++) stamps.push(f / opts.fps)
  const pass = reader.framesAt(stamps)
  try {
    const out = await encodeVideo(
      frames,
      async (ctx) => {
        const frame = (await pass.next()).value ?? null
        if (!frame) return false
        ctx.drawImage(frame, 0, 0, opts.width, opts.height)
        return true
      },
      { width: opts.width, height: opts.height, fps: opts.fps, audio, signal }
    )
    if (!out) throw new Error('ผสมเสียงไม่สำเร็จ')
    return out
  } finally {
    await pass.return(undefined).catch(() => undefined)
    reader.close()
  }
}

export interface MixSpec {
  durationSec: number
  /** Decoded music, or null when there is no bed. */
  music: AudioBuffer | null
  musicVolume: number
  musicOffsetSec: number
  musicTrimInSec: number
  musicTrimOutSec: number | null
  /** Decoded voiceover, or null. Placed at 0 and never attenuated. */
  voice: AudioBuffer | null
}

/** Build the output's audio track. Length is the VIDEO's — `-shortest`. */
export async function renderMix(spec: MixSpec): Promise<AudioBuffer | null> {
  if (!spec.music && !spec.voice) return null

  const frames = Math.ceil(spec.durationSec * MIX_SAMPLE_RATE)
  const ctx = new OfflineAudioContext(MIX_CHANNELS, frames, MIX_SAMPLE_RATE)

  if (spec.voice) {
    const src = ctx.createBufferSource()
    src.buffer = spec.voice
    src.connect(ctx.destination)
    src.start(0)
  }

  if (spec.music) {
    const src = ctx.createBufferSource()
    src.buffer = spec.music
    const gain = ctx.createGain()
    gain.gain.value = spec.musicVolume
    src.connect(gain).connect(ctx.destination)

    // Trim inside the file, then place on the output clock.
    const offset = Math.max(0, spec.musicTrimInSec)
    const end =
      spec.musicTrimOutSec !== null && spec.musicTrimOutSec > offset
        ? spec.musicTrimOutSec
        : spec.music.duration
    src.start(Math.max(0, spec.musicOffsetSec), offset, Math.max(0, end - offset))
  }

  return ctx.startRendering()
}

/**
 * The same WAV as a stream, with its size known up front.
 *
 * The file is produced in slices from the decoded samples as the writer
 * pulls, so a long track exists in memory once (the samples), not twice.
 */
export async function speechWavStream(
  source: Blob,
  signal?: AbortSignal
): Promise<{ stream: ReadableStream<Uint8Array>; bytes: number }> {
  const samples = await monoSamples(await decode(source, STT_SAMPLE_RATE, 1, signal))

  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i])
    if (a > peak) peak = a
  }
  // Leave 1.5 dB of headroom, the same margin loudnorm's TP=-1.5 keeps.
  const gain = peak > 0 ? Math.min(8, 0.84 / peak) : 1

  const chunks = wav16Chunks(samples, gain, STT_SAMPLE_RATE)
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks.next()
      if (next.done) controller.close()
      else controller.enqueue(next.value)
    }
  })
  return { stream, bytes: wav16Bytes(samples.length) }
}

/**
 * One channel of samples. The streamed decoder already hands back mono; the
 * `decodeAudioData` fallback returns the file's own layout, and the mix-down
 * is the Web Audio one so the two paths agree.
 */
async function monoSamples(decoded: AudioBuffer): Promise<Float32Array> {
  if (decoded.numberOfChannels === 1) return decoded.getChannelData(0)
  const ctx = new OfflineAudioContext(1, decoded.length, decoded.sampleRate)
  const src = ctx.createBufferSource()
  src.buffer = decoded
  src.connect(ctx.destination)
  src.start(0)
  return (await ctx.startRendering()).getChannelData(0)
}

/** Decode a file already in the project store. */
export async function decodeStored(
  path: string,
  sampleRate = MIX_SAMPLE_RATE
): Promise<AudioBuffer | null> {
  // `blobForPath`, not a bare store read. The store is a CACHE in front of the
  // server, so on a project opened in another browser the music is on the
  // server and absent here — and returning null in that case produced a
  // finished final.mp4 with the music bed silently missing, no error anywhere.
  // Failing loudly is the right answer: a render that quietly drops a layer
  // the editor still shows is worse than one that stops.
  const file = await blobForPath(path)
  return decode(file, sampleRate, MIX_CHANNELS)
}

export interface SourceAudioCut {
  /** Decoded audio of the clip this cut comes from, or null when it has none. */
  buffer: AudioBuffer | null
  sourceIn: number
  /** The cut's length AFTER frame quantisation — what the picture actually is. */
  durationSec: number
}

/**
 * The original audio, cut and joined to match the picture.
 *
 * This is what `trim_media` keeps and `concat_stream_copy` joins on the
 * desktop: the speech modes are built on what is being said, so the audio has
 * to be sliced by the same cut list rather than replaced.
 *
 * Each slice is placed at its cut's OUTPUT offset using the frame-quantised
 * duration, not the requested one. The desktop had to measure each rendered
 * clip to avoid drift over a long render (`timeline_render.py` comments on
 * exactly this); quantising up front makes the two agree by construction.
 */
export async function concatSourceAudio(cuts: SourceAudioCut[]): Promise<AudioBuffer | null> {
  const total = cuts.reduce((n, c) => n + c.durationSec, 0)
  if (total <= 0 || cuts.every((c) => !c.buffer)) return null

  const ctx = new OfflineAudioContext(
    MIX_CHANNELS,
    Math.ceil(total * MIX_SAMPLE_RATE),
    MIX_SAMPLE_RATE
  )
  let offset = 0
  for (const cut of cuts) {
    if (cut.buffer && cut.durationSec > 0) {
      const src = ctx.createBufferSource()
      src.buffer = cut.buffer
      src.connect(ctx.destination)
      // A cut that runs past the end of its source simply stops there, the
      // same as ffmpeg's trim — the picture keeps its last frame.
      src.start(offset, Math.max(0, cut.sourceIn), cut.durationSec)
    }
    offset += cut.durationSec
  }
  return ctx.startRendering()
}
