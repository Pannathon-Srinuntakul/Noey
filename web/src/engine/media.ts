/**
 * Reading and writing media, on top of mediabunny.
 *
 * This is the layer that stands in for ffmpeg. Two jobs:
 *
 *   - open a source and answer questions about it, or hand out decoded frames
 *     at exact times (`probeSource`, `openVideo`);
 *   - compose frames onto one canvas and encode the result (`encodeVideo`).
 *
 * The composing half is where a whole class of desktop bug disappears. The
 * ffmpeg pipeline trims each cut to its own file and concatenates them with
 * `-c copy`, so two sources of different size produced a file whose resolution
 * changed mid-stream while its header kept advertising the first one — green
 * frames and stutter, measured 2026-09-07. Here every frame is drawn onto a
 * single canvas of one fixed size, so the output cannot have two shapes.
 *
 * Rotation is likewise free: the decoder applies the display matrix, so what
 * arrives is already the size a player would show. The desktop needed
 * `display_size()` to reason about that separately.
 */

import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  CanvasSink,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  StreamTarget,
  VideoSample,
  VideoSampleSource,
  AudioBufferSource,
  canDecodeVideo,
  canEncodeAudio,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  canEncodeVideo,
  type InputVideoTrack,
  type StreamTargetChunk
} from 'mediabunny'

export interface SourceInfo {
  durationSec: number
  width: number
  height: number
  fps: number
  hasAudio: boolean
  codec: string | null
}

/**
 * Whether THIS browser can decode the source at all.
 *
 * Reading a file's metadata and decoding its pictures are different
 * capabilities: an HEVC clip from an iPhone demuxes fine everywhere, and then
 * decodes only where the platform has an HEVC decoder — Safari and macOS
 * always, Windows Chrome only with the HEVC video extension installed. Asking
 * up front is what lets the wizard say so while the user is still choosing
 * files, instead of after they have sat through a wizard and started a job.
 */
export async function canDecodeSource(info: SourceInfo): Promise<boolean> {
  if (!info.codec) return false
  try {
    return await canDecodeVideo(info.codec as Parameters<typeof canDecodeVideo>[0], {
      codedWidth: info.width,
      codedHeight: info.height
    })
  } catch {
    return false
  }
}

/** What `probe` reports. Mirrors the sidecar's `probe` event fields. */
export async function probeSource(file: Blob): Promise<SourceInfo> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) })
  try {
    const videoTrack = await input.getPrimaryVideoTrack()
    const audioTrack = await input.getPrimaryAudioTrack()
    const duration = await input.computeDuration()

    if (!videoTrack) {
      return {
        durationSec: round3(duration),
        width: 0,
        height: 0,
        fps: 0,
        hasAudio: !!audioTrack,
        codec: null
      }
    }

    // `displayWidth/Height` already account for rotation, which is what the
    // renderer and every downstream size decision actually want.
    const stats = await videoTrack.computePacketStats(120)
    return {
      durationSec: round3(duration),
      width: videoTrack.displayWidth,
      height: videoTrack.displayHeight,
      fps: Math.max(1, Math.round(stats.averagePacketRate || 30)),
      hasAudio: !!audioTrack,
      codec: await videoTrack.getCodec()
    }
  } finally {
    input.dispose()
  }
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

/**
 * Make sure an AAC encoder exists, loading a WASM one if the browser has none.
 *
 * MP4 wants AAC, and `AudioEncoder` support for it is the least even part of
 * WebCodecs — Chrome and Edge have it, and a browser that ships the video half
 * without the audio half is exactly the case that would otherwise fail deep
 * inside a finished render rather than before it started. Registering the
 * fallback is idempotent and costs nothing when the native encoder is there:
 * the WASM module is only fetched on the branch that needs it.
 */
export { canEncodeAudio }

let aacReady: Promise<void> | null = null

export function ensureAacEncoder(): Promise<void> {
  aacReady ??= (async () => {
    if (await canEncodeAudio('aac')) return
    const { registerAacEncoder } = await import('@mediabunny/aac-encoder')
    registerAacEncoder()
  })()
  return aacReady
}

/** Can this browser encode H.264 at this size? Falls back through the list. */
export async function pickVideoCodec(
  width: number,
  height: number
): Promise<'avc' | 'vp9' | 'vp8'> {
  for (const codec of ['avc', 'vp9', 'vp8'] as const) {
    if (await canEncodeVideo(codec, { width, height })) return codec
  }
  throw new Error('เบราว์เซอร์นี้ประมวลผลวิดีโอไม่ได้')
}

/**
 * A frame reader for one source.
 *
 * `frameAt(t)` returns the frame the player would show at that time, which is
 * what a trim needs: the desktop's ffmpeg `trim` filter is frame-accurate, and
 * anything looser here would drift a cut boundary.
 */
export interface VideoReader {
  track: InputVideoTrack
  width: number
  height: number
  /** Nearest decoded frame at or before `timeSec`; null past the end. */
  frameAt(timeSec: number): Promise<CanvasImageSource | null>
  /**
   * The frames at a RUN of timestamps, decoded in one sequential pass.
   *
   * `frameAt` is a random access: each call seeks, which for a render — where
   * every timestamp is one frame after the last — means re-walking the same
   * GOP over and over. Measured on a 27-cut render: 1,266 frames took 244 s
   * pulled one at a time, and the encode was only 7% of that (a second encode
   * for the per-scene clips added just 19 s). Decoding is the cost, and a
   * sequential pass is what removes it.
   *
   * Timestamps must be non-decreasing. A null means the source ended.
   */
  framesAt(timestamps: number[]): AsyncGenerator<CanvasImageSource | null>
  close(): void
}

export async function openVideo(file: Blob): Promise<VideoReader> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) })
  const track = await input.getPrimaryVideoTrack()
  if (!track) {
    input.dispose()
    throw new Error('ไฟล์นี้ไม่มีภาพวิดีโอ')
  }
  const sink = new CanvasSink(track, { poolSize: 2 })

  return {
    track,
    width: track.displayWidth,
    height: track.displayHeight,
    frameAt: async (timeSec: number) => {
      const result = await sink.getCanvas(Math.max(0, timeSec))
      return result ? result.canvas : null
    },
    framesAt: async function* (timestamps: number[]) {
      for await (const wrapped of sink.canvasesAtTimestamps(
        timestamps.map((t) => Math.max(0, t))
      )) {
        yield wrapped ? wrapped.canvas : null
      }
    },
    close: () => input.dispose()
  }
}

export interface EncodeTarget {
  /**
   * Where the muxed bytes go. A stream keeps a long encode out of memory.
   *
   * `StreamTarget` writes `{type:'write', data, position}` chunks — the same
   * protocol an OPFS `FileSystemWritableFileStream` accepts — so a writable
   * opened by `fs.openStagedWrite` can be handed straight in.
   */
  writable?: WritableStream<StreamTargetChunk>
}

export interface EncodeOptions {
  width: number
  height: number
  fps: number
  /** Bitrate in bits per second. */
  bitrate?: number
  /** Interleaved audio, already mixed to the output's length. */
  audio?: AudioBuffer | null
  signal?: AbortSignal
  /**
   * A second destination for the frame being encoded, chosen per frame.
   *
   * This is how the per-scene `clips/clip_NNN.mp4` files come out of the same
   * pass as the joined render. The desktop writes them first and concatenates
   * them; there is no concat here, so without a mirror they would need a whole
   * second decode of every source. Returning null skips the frame.
   */
  mirror?: (index: number) => ClipWriter | null
}

/**
 * A side output that receives frames already drawn for the main encode.
 *
 * Deliberately not an `encodeVideo` call: it has no frame loop of its own, it
 * just accepts samples as the main loop produces them.
 */
export interface ClipWriter {
  add(sample: VideoSample, keyFrame: boolean): Promise<void>
  finish(): Promise<Blob>
  cancel(): Promise<void>
}

export async function openClipWriter(
  width: number,
  height: number,
  fps: number,
  bitrate?: number
): Promise<ClipWriter> {
  const codec = await pickVideoCodec(width, height)
  const bufferTarget = new BufferTarget()
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: bufferTarget
  })
  const source = new VideoSampleSource({
    codec,
    bitrate: bitrate ?? QUALITY_HIGH,
    keyFrameInterval: 2,
    latencyMode: 'quality'
  })
  output.addVideoTrack(source, { frameRate: fps })
  await output.start()

  // A clip's own clock starts at zero, not at its offset in the joined render:
  // these files are handed to someone else's editor, where a first frame at
  // 4.2 s would read as four seconds of nothing.
  let index = 0

  return {
    add: async (sample: VideoSample, keyFrame: boolean) => {
      const shifted = sample.clone()
      shifted.setTimestamp(index / fps)
      index += 1
      await source.add(shifted, { keyFrame })
      shifted.close()
    },
    finish: async () => {
      source.close()
      await output.finalize()
      if (!bufferTarget.buffer) throw new Error('ประมวลผลวิดีโอไม่สำเร็จ')
      return new Blob([bufferTarget.buffer], { type: 'video/mp4' })
    },
    cancel: async () => {
      await output.cancel().catch(() => undefined)
    }
  }
}

export interface FrameComposer {
  /** Draw the frame for `index` onto `ctx`. Return false to stop early. */
  (ctx: OffscreenCanvasRenderingContext2D, index: number, timeSec: number): Promise<boolean>
}

/**
 * Render `frameCount` frames through `draw` and mux them into an MP4.
 *
 * The frame loop is deliberately double-buffered: `VideoSample` copies the
 * pixels on construction, so the canvas is free the instant it is built and the
 * previous frame's encode overlaps the next frame's draw.
 */
export async function encodeVideo(
  frameCount: number,
  draw: FrameComposer,
  opts: EncodeOptions,
  target: EncodeTarget = {},
  onProgress?: (frame: number, total: number) => void
): Promise<Blob | null> {
  const { width, height, fps } = opts
  const codec = await pickVideoCodec(width, height)

  const bufferTarget = target.writable ? null : new BufferTarget()
  const output = new Output({
    // In-memory faststart holds the WHOLE file until finalize, which defeats a
    // streamed target. moov-at-end is fine for every consumer here: the
    // service worker answers Range requests off OPFS, and a player fetching
    // from the server asks for the tail with its own Range request.
    format: new Mp4OutputFormat(target.writable ? {} : { fastStart: 'in-memory' }),
    target: target.writable
      ? new StreamTarget(target.writable, { chunked: true })
      : (bufferTarget as BufferTarget)
  })

  const videoSource = new VideoSampleSource({
    codec,
    // A quality LEVEL, not a fixed bitrate: mediabunny scales it to the frame
    // size, which is the closest thing WebCodecs offers to the desktop's
    // constant-quality encode (`cqp qp=18`). A bitrate can still be forced.
    bitrate: opts.bitrate ?? QUALITY_HIGH,
    // Offline encode: let the encoder spend time on rate control rather than
    // optimising for latency, and put a keyframe every couple of seconds so
    // seeking in the result is not miserable.
    keyFrameInterval: 2,
    latencyMode: 'quality'
  })
  output.addVideoTrack(videoSource, { frameRate: fps })

  if (opts.audio) await ensureAacEncoder()
  const audioSource = opts.audio ? new AudioBufferSource({ codec: 'aac', bitrate: 192_000 }) : null
  if (audioSource) output.addAudioTrack(audioSource)

  await output.start()

  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('เปิดพื้นที่วาดภาพไม่ได้')

  try {
    if (audioSource && opts.audio) {
      await audioSource.add(opts.audio)
      audioSource.close()
    }

    let pending: Promise<void> | null = null
    let lastMirror: ClipWriter | null = null
    for (let i = 0; i < frameCount; i++) {
      if (opts.signal?.aborted) throw new DOMException('ยกเลิกแล้ว', 'AbortError')

      const keep = await draw(ctx, i, i / fps)
      if (!keep) break

      const sample = new VideoSample(canvas, { timestamp: i / fps, duration: 1 / fps })
      const clip = opts.mirror?.(i) ?? null
      const clipFirst = clip !== lastMirror
      lastMirror = clip
      // Wait for the PREVIOUS encode, not this one — that overlap is the whole
      // point of the double buffer.
      if (pending) await pending
      pending = Promise.all([
        videoSource.add(sample, { keyFrame: i === 0 }),
        clip ? clip.add(sample, clipFirst) : Promise.resolve()
      ])
        .then(() => undefined)
        .finally(() => sample.close())

      if (onProgress && (i % 15 === 0 || i === frameCount - 1)) onProgress(i + 1, frameCount)
    }
    if (pending) await pending
    videoSource.close()
    await output.finalize()
  } catch (err) {
    await output.cancel().catch(() => undefined)
    throw err
  }

  if (!bufferTarget) return null
  if (!bufferTarget.buffer) throw new Error('ประมวลผลวิดีโอไม่สำเร็จ')
  return new Blob([bufferTarget.buffer], { type: 'video/mp4' })
}

/**
 * Swap the audio track of an already-encoded video, WITHOUT touching the
 * picture — the equivalent of the desktop's `-c:v copy`.
 *
 * A browser cannot edit a container in place, so the file has to be rebuilt;
 * what it does not have to do is re-encode. Copying the encoded video packets
 * across took a music re-mix of an 8 s clip from **46 s to under 2 s**
 * (measured 2026-09-08), and it removes the generation loss a re-encode would
 * add every time someone nudged the volume slider.
 *
 * Returns null when the packets cannot be copied (no decoder config to carry
 * over), so the caller can fall back to a real re-encode.
 */
export async function remuxWithAudio(video: Blob, audio: AudioBuffer | null): Promise<Blob | null> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(video) })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) return null
    const decoderConfig = (await track.getDecoderConfig()) as VideoDecoderConfig | null
    if (!decoderConfig) return null

    const stats = await track.computePacketStats(120)
    const bufferTarget = new BufferTarget()
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: bufferTarget
    })

    const codec = await track.getCodec()
    if (!codec) return null
    const videoSource = new EncodedVideoPacketSource(codec)
    output.addVideoTrack(videoSource, {
      frameRate: Math.max(1, Math.round(stats.averagePacketRate || 30))
    })
    if (audio) await ensureAacEncoder()
    const audioSource = audio ? new AudioBufferSource({ codec: 'aac', bitrate: 192_000 }) : null
    if (audioSource) output.addAudioTrack(audioSource)

    await output.start()
    try {
      if (audioSource && audio) {
        await audioSource.add(audio)
        audioSource.close()
      }
      const sink = new EncodedPacketSink(track)
      let first = true
      for await (const packet of sink.packets()) {
        // The decoder config rides on the FIRST packet only, exactly as the
        // encoder would have emitted it.
        await videoSource.add(packet, first ? { decoderConfig } : undefined)
        first = false
      }
      videoSource.close()
      await output.finalize()
    } catch (err) {
      await output.cancel().catch(() => undefined)
      throw err
    }

    if (!bufferTarget.buffer) return null
    return new Blob([bufferTarget.buffer], { type: 'video/mp4' })
  } finally {
    input.dispose()
  }
}

/**
 * Put an already-H.264 source into an MP4 container without re-encoding it.
 *
 * A phone often hands over H.264 inside a `.mov`. The pictures are already in
 * the format everything downstream wants, so decoding and re-encoding them
 * would spend minutes and a generation of quality to arrive back where it
 * started. This copies the encoded packets — video and audio both — into a
 * real MP4: seconds, and bit-identical pictures.
 *
 * Returns null when the packets cannot be copied, so the caller can fall back
 * to a real transcode.
 */
export async function remuxToMp4(source: Blob, signal?: AbortSignal): Promise<Blob | null> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(source) })
  try {
    const videoTrack = await input.getPrimaryVideoTrack()
    if (!videoTrack) return null
    const videoCodec = await videoTrack.getCodec()
    const videoConfig = (await videoTrack.getDecoderConfig()) as VideoDecoderConfig | null
    if (!videoCodec || !videoConfig) return null

    const audioTrack = await input.getPrimaryAudioTrack()
    const audioCodec = audioTrack ? await audioTrack.getCodec() : null
    const audioConfig = audioTrack
      ? ((await audioTrack.getDecoderConfig()) as AudioDecoderConfig | null)
      : null

    const stats = await videoTrack.computePacketStats(120)
    const bufferTarget = new BufferTarget()
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: bufferTarget
    })

    const videoSource = new EncodedVideoPacketSource(videoCodec)
    output.addVideoTrack(videoSource, {
      frameRate: Math.max(1, Math.round(stats.averagePacketRate || 30))
    })
    // Audio rides along only if its config came back too — a track we cannot
    // describe to the muxer is better dropped than written broken.
    const audioSource =
      audioTrack && audioCodec && audioConfig ? new EncodedAudioPacketSource(audioCodec) : null
    if (audioSource) output.addAudioTrack(audioSource)

    await output.start()
    try {
      let first = true
      for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
        // Checked per packet: a long .mov's copy used to run to completion
        // after หยุดงาน, holding the project's job lock the whole time.
        if (signal?.aborted) throw new DOMException('ยกเลิกแล้ว', 'AbortError')
        await videoSource.add(packet, first ? { decoderConfig: videoConfig } : undefined)
        first = false
      }
      videoSource.close()

      if (audioSource && audioTrack && audioConfig) {
        let firstAudio = true
        for await (const packet of new EncodedPacketSink(audioTrack).packets()) {
          if (signal?.aborted) throw new DOMException('ยกเลิกแล้ว', 'AbortError')
          await audioSource.add(packet, firstAudio ? { decoderConfig: audioConfig } : undefined)
          firstAudio = false
        }
        audioSource.close()
      }
      await output.finalize()
    } catch (err) {
      await output.cancel().catch(() => undefined)
      throw err
    }

    if (!bufferTarget.buffer) return null
    return new Blob([bufferTarget.buffer], { type: 'video/mp4' })
  } catch {
    return null
  } finally {
    input.dispose()
  }
}

/**
 * Put the DONOR's audio track under an already-encoded video by packet copy,
 * streamed to `outPath`.
 *
 * This is how a converted clip keeps its sound without ever decoding it: the
 * common case (an iPhone HEVC recording) carries AAC audio, which copies
 * straight into the MP4. The old approach decoded the donor's entire PCM into
 * RAM first — ~384 kB per second, ~2.7 GB for a clip at the 2 h cap — and a
 * blanket catch turned ANY failure into a silent clip that a later stage
 * reported as "คลิปนี้ไม่มีเสียง" about footage the user could hear in their
 * own player.
 *
 * Returns false when the donor has no audio the muxer can describe; the
 * caller decides what a silent fallback should look like.
 */
export async function attachDonorAudio(
  video: Blob,
  donor: Blob,
  outPath: string,
  signal?: AbortSignal
): Promise<boolean> {
  const { openStagedWrite } = await import('../platform/fs')
  const videoInput = new Input({ formats: ALL_FORMATS, source: new BlobSource(video) })
  const donorInput = new Input({ formats: ALL_FORMATS, source: new BlobSource(donor) })
  try {
    const videoTrack = await videoInput.getPrimaryVideoTrack()
    if (!videoTrack) return false
    const videoCodec = await videoTrack.getCodec()
    const videoConfig = (await videoTrack.getDecoderConfig()) as VideoDecoderConfig | null
    if (!videoCodec || !videoConfig) return false

    const audioTrack = await donorInput.getPrimaryAudioTrack()
    if (!audioTrack) return false
    const audioCodec = await audioTrack.getCodec()
    const audioConfig = (await audioTrack.getDecoderConfig()) as AudioDecoderConfig | null
    if (!audioCodec || !audioConfig) return false

    const staged = await openStagedWrite(outPath)
    const output = new Output({
      // moov at end: both consumers (the service worker and a Range-capable
      // player) seek fine, and in-memory faststart would defeat the stream.
      format: new Mp4OutputFormat({}),
      target: new StreamTarget(staged.writable, { chunked: true })
    })
    try {
      const stats = await videoTrack.computePacketStats(120)
      const videoSource = new EncodedVideoPacketSource(videoCodec)
      output.addVideoTrack(videoSource, {
        frameRate: Math.max(1, Math.round(stats.averagePacketRate || 30))
      })
      const audioSource = new EncodedAudioPacketSource(audioCodec)
      output.addAudioTrack(audioSource)

      await output.start()
      let first = true
      for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
        if (signal?.aborted) throw new DOMException('ยกเลิกแล้ว', 'AbortError')
        await videoSource.add(packet, first ? { decoderConfig: videoConfig } : undefined)
        first = false
      }
      videoSource.close()
      let firstAudio = true
      for await (const packet of new EncodedPacketSink(audioTrack).packets()) {
        if (signal?.aborted) throw new DOMException('ยกเลิกแล้ว', 'AbortError')
        await audioSource.add(packet, firstAudio ? { decoderConfig: audioConfig } : undefined)
        firstAudio = false
      }
      audioSource.close()
      await output.finalize()
      await staged.publish()
      return true
    } catch (err) {
      await output.cancel().catch(() => undefined)
      await staged.discard().catch(() => undefined)
      if (err instanceof Error && err.name === 'AbortError') throw err
      return false
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err
    return false
  } finally {
    videoInput.dispose()
    donorInput.dispose()
  }
}

/**
 * The smallest self-contained clip that still shows the first frame.
 *
 * For a codec this browser cannot DECODE — HEVC on most of Windows — it can
 * still DEMUX: reading packets and the decoder config needs no decoder at all,
 * which is what makes `remuxToMp4` work on those files. So a poster frame can
 * be cut out here and decoded elsewhere.
 *
 * One key packet in a real MP4 container, not a raw NAL: ffmpeg on the other
 * end then needs no knowledge of hvcC, annex-B or parameter sets, because the
 * muxer wrote them.
 *
 * Returns null when there is nothing to cut.
 */
export async function firstFrameClip(source: Blob): Promise<Blob | null> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(source) })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) return null
    const codec = await track.getCodec()
    const decoderConfig = (await track.getDecoderConfig()) as VideoDecoderConfig | null
    if (!codec || !decoderConfig) return null

    const packet = await new EncodedPacketSink(track).getFirstKeyPacket()
    if (!packet) return null

    const bufferTarget = new BufferTarget()
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: bufferTarget
    })
    const videoSource = new EncodedVideoPacketSource(codec)
    output.addVideoTrack(videoSource, { frameRate: 1 })
    await output.start()
    try {
      await videoSource.add(packet, { decoderConfig })
      videoSource.close()
      await output.finalize()
    } catch (err) {
      await output.cancel().catch(() => undefined)
      throw err
    }
    if (!bufferTarget.buffer) return null
    return new Blob([bufferTarget.buffer], { type: 'video/mp4' })
  } catch {
    return null
  } finally {
    input.dispose()
  }
}
