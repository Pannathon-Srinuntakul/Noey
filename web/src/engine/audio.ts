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

import { encodeVideo, openVideo, probeSource, remuxWithAudio } from './media'
import { blobForPath } from './jobs/probe'

/** Everything downstream (the mux, the encoder) works at this rate. */
const MIX_SAMPLE_RATE = 48000
const MIX_CHANNELS = 2

/** ElevenLabs Scribe's fast path — matches `audio_extract.py`. */
export const STT_SAMPLE_RATE = 16000

/** Decode any audio-bearing blob at the mix's rate. */
export async function decodeBlob(blob: Blob): Promise<AudioBuffer> {
  return decode(blob, MIX_SAMPLE_RATE, MIX_CHANNELS)
}

async function decode(blob: Blob, sampleRate: number, channels: number): Promise<AudioBuffer> {
  const bytes = await blob.arrayBuffer()
  // A one-frame context just to decode; the real graph is built after.
  const probe = new OfflineAudioContext(channels, 1, sampleRate)
  return probe.decodeAudioData(bytes)
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
  try {
    const frames = Math.max(1, Math.round(info.durationSec * opts.fps))
    const out = await encodeVideo(
      frames,
      async (ctx, _i, timeSec) => {
        const frame = await reader.frameAt(timeSec)
        if (!frame) return false
        ctx.drawImage(frame, 0, 0, opts.width, opts.height)
        return true
      },
      { width: opts.width, height: opts.height, fps: opts.fps, audio, signal }
    )
    if (!out) throw new Error('ผสมเสียงไม่สำเร็จ')
    return out
  } finally {
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
 * Speech audio for transcription.
 *
 * `audio_extract.py` produces mono 16 kHz PCM specifically because that is
 * Scribe's fast path. The loudness pass it also runs (`loudnorm I=-16`) has no
 * browser equivalent, so this normalises by peak instead — enough to stop a
 * quietly-recorded clip transcribing badly, without pretending to be EBU R128.
 */
export async function extractSpeechWav(source: Blob): Promise<Uint8Array> {
  const decoded = await decode(source, STT_SAMPLE_RATE, 1)

  const frames = decoded.length
  const ctx = new OfflineAudioContext(1, frames, STT_SAMPLE_RATE)
  const src = ctx.createBufferSource()
  src.buffer = decoded
  src.connect(ctx.destination)
  src.start(0)
  const mono = await ctx.startRendering()

  const samples = mono.getChannelData(0)
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i])
    if (a > peak) peak = a
  }
  // Leave 1.5 dB of headroom, the same margin loudnorm's TP=-1.5 keeps.
  const gain = peak > 0 ? Math.min(8, 0.84 / peak) : 1

  return encodeWav16(samples, gain, STT_SAMPLE_RATE)
}

/** 16-bit PCM WAV. */
function encodeWav16(samples: Float32Array, gain: number, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
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

  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i] * gain))
    view.setInt16(offset, v < 0 ? v * 0x8000 : v * 0x7fff, true)
    offset += 2
  }
  return bytes
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
