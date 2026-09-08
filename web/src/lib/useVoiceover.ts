/**
 * Per-line voiceover recording for `waiting_vo` (PLAN.md chunk 7).
 *
 * One take per script line, each written to the project directory as it is
 * recorded, so closing the app mid-session loses nothing. The assembled
 * `voiceover.wav` is rebuilt from those takes on demand — re-recording one
 * line never means re-recording the rest.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { LocalProject } from '@renderer/platform/types'
import { VO_SAMPLE_RATE, encodeVoiceoverWav } from './wav'

/** Chromium always has WebM/Opus; the list is a courtesy for other builds. */
const PREFERRED_MIME = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  return PREFERRED_MIME.find((m) => MediaRecorder.isTypeSupported(m))
}

export function takeFileFor(lineId: number): string {
  return `voiceover/line_${lineId}.webm`
}

export const VOICEOVER_WAV = 'voiceover/voiceover.wav'

export interface RecorderState {
  /** Line currently being recorded, or null when idle. */
  recordingLineId: number | null
  /** Seconds elapsed in the current take. */
  elapsedSec: number
  /** 0–1 input level, for the meter. */
  level: number
  /** Set when the microphone could not be opened at all. */
  micError: string | null
  /** Name of the input device in use, once known. */
  micLabel: string | null
}

export interface VoiceoverRecorder extends RecorderState {
  start: (lineId: number) => Promise<void>
  stop: () => void
  /** True while a stopped take is still being decoded and written. */
  saving: boolean
  /** Whether an audio input exists. false = none plugged in (the record
   * button says so instead of failing on click); null = unknown. */
  hasMic: boolean | null
}

/**
 * Decode an arbitrary encoded blob to mono PCM at the voiceover sample rate.
 * `OfflineAudioContext` does the resample, so takes recorded at whatever rate
 * the device offers all line up in the assembled file.
 */
export async function decodeToMono(bytes: ArrayBuffer): Promise<Float32Array> {
  const ctx = new AudioContext()
  try {
    const decoded = await ctx.decodeAudioData(bytes.slice(0))
    const frames = Math.max(1, Math.round(decoded.duration * VO_SAMPLE_RATE))
    const offline = new OfflineAudioContext(1, frames, VO_SAMPLE_RATE)
    const source = offline.createBufferSource()
    source.buffer = decoded
    source.connect(offline.destination)
    source.start()
    const rendered = await offline.startRendering()
    return rendered.getChannelData(0).slice(0)
  } finally {
    void ctx.close()
  }
}

/**
 * Rebuild `voiceover.wav` from the stored takes, in line order.
 *
 * Reads each take back off disk rather than keeping PCM in memory: takes
 * survive a restart, and a 5-line voiceover held as float32 is tens of
 * megabytes for no reason.
 */
export async function assembleVoiceover(
  projectUid: string,
  lineIds: number[],
  takes: NonNullable<LocalProject['voiceoverTakes']>
): Promise<{ path: string; durationSec: number }> {
  const chunks: Float32Array[] = []
  for (const lineId of lineIds) {
    const take = takes[String(lineId)]
    if (!take) continue
    const url = window.noey.media.urlFor(projectUid, take.file)
    const bytes = await (await fetch(url)).arrayBuffer()
    chunks.push(await decodeToMono(bytes))
  }
  const { bytes, plan } = encodeVoiceoverWav(chunks)
  const path = await window.noey.projects.writeFile(projectUid, VOICEOVER_WAV, bytes)
  return { path, durationSec: plan.totalSec }
}

export function useVoiceoverRecorder(
  projectUid: string,
  onTake: (lineId: number, file: string, durationSec: number) => Promise<void>
): VoiceoverRecorder {
  const [state, setState] = useState<RecorderState>({
    recordingLineId: null,
    elapsedSec: 0,
    level: 0,
    micError: null,
    micLabel: null
  })
  const [saving, setSaving] = useState(false)

  // The recorder's stop handler fires long after `start` was called, so the
  // callback is read from a ref rather than captured — the page rebuilds it on
  // every render and a captured one would write against a stale project.
  // Refreshed in an effect, never during render.
  const onTakeRef = useRef(onTake)
  useEffect(() => {
    onTakeRef.current = onTake
  })

  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const rafRef = useRef<number | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const startedAtRef = useRef(0)
  /** True between start() being called and the mic actually being open. */
  const startingRef = useRef(false)

  const teardown = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    analyserRef.current = null
    void audioCtxRef.current?.close()
    audioCtxRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    recorderRef.current = null
  }, [])

  // Releasing the microphone on unmount matters: the OS shows a recording
  // indicator for as long as the track is live.
  useEffect(() => teardown, [teardown])

  // Is there a microphone at all? Checked up front (and on hot-plug) so the
  // record button can say "ไม่พบไมโครโฟน" BEFORE it is pressed, instead of
  // failing afterwards with advice about permissions that would not help.
  // null = still checking / the browser will not say without permission.
  const [hasMic, setHasMic] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    const probe = (): void => {
      void navigator.mediaDevices
        ?.enumerateDevices()
        .then((devices) => {
          if (alive) setHasMic(devices.some((d) => d.kind === 'audioinput'))
        })
        .catch(() => {
          if (alive) setHasMic(null)
        })
    }
    probe()
    navigator.mediaDevices?.addEventListener?.('devicechange', probe)
    return () => {
      alive = false
      navigator.mediaDevices?.removeEventListener?.('devicechange', probe)
    }
  }, [])

  const start = useCallback(
    async (lineId: number): Promise<void> => {
      const mime = pickMimeType()
      if (!mime) {
        setState((s) => ({ ...s, micError: 'เครื่องนี้อัดเสียงในแอปไม่ได้' }))
        return
      }
      // A second start() before the first getUserMedia resolves would overwrite
      // streamRef/recorderRef and leak the earlier take's tracks — the OS keeps
      // showing "recording" for a stream nothing can stop any more. Two presses
      // on a slow permission prompt are enough to hit it.
      if (startingRef.current || recorderRef.current) return
      startingRef.current = true
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true }
        })
        streamRef.current = stream

        const ctx = new AudioContext()
        audioCtxRef.current = ctx
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 1024
        ctx.createMediaStreamSource(stream).connect(analyser)
        analyserRef.current = analyser

        const recorder = new MediaRecorder(stream, { mimeType: mime })
        recorderRef.current = recorder
        chunksRef.current = []
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data)
        }
        recorder.onstop = () => {
          const blob = new Blob(chunksRef.current, { type: mime })
          const elapsed = (performance.now() - startedAtRef.current) / 1000
          teardown()
          // micLabel survives the take: it states which input WILL be used, so
          // clearing it here made the screen forget the microphone the moment
          // you stopped recording.
          setState((prev) => ({
            recordingLineId: null,
            elapsedSec: 0,
            level: 0,
            micError: null,
            micLabel: prev.micLabel
          }))
          setSaving(true)
          void blob
            .arrayBuffer()
            .then(async (buf) => {
              const file = takeFileFor(lineId)
              await window.noey.projects.writeFile(projectUid, file, new Uint8Array(buf))
              // Decode for the true length — the recorder's wall-clock timing
              // includes the moment between click and first sample.
              let duration = elapsed
              try {
                duration = (await decodeToMono(buf)).length / VO_SAMPLE_RATE
              } catch {
                // Undecodable here still plays and still concatenates later;
                // the wall-clock estimate is good enough for the list.
              }
              await onTakeRef.current(lineId, file, Math.round(duration * 100) / 100)
            })
            .finally(() => setSaving(false))
        }

        startedAtRef.current = performance.now()
        recorder.start()
        setState({
          recordingLineId: lineId,
          elapsedSec: 0,
          level: 0,
          micError: null,
          micLabel: stream.getAudioTracks()[0]?.label || null
        })

        const buf = new Uint8Array(analyser.frequencyBinCount)
        const tick = (): void => {
          const a = analyserRef.current
          if (!a) return
          a.getByteTimeDomainData(buf)
          let peak = 0
          for (const v of buf) peak = Math.max(peak, Math.abs(v - 128) / 128)
          setState((s) =>
            s.recordingLineId === null
              ? s
              : { ...s, level: peak, elapsedSec: (performance.now() - startedAtRef.current) / 1000 }
          )
          rafRef.current = requestAnimationFrame(tick)
        }
        rafRef.current = requestAnimationFrame(tick)
      } catch (err) {
        teardown()
        // Name the ACTUAL problem: "check your permissions" is wrong advice
        // when the machine simply has no microphone plugged in.
        const name = (err as { name?: string })?.name
        const micError =
          name === 'NotFoundError' || name === 'DevicesNotFoundError'
            ? 'ไม่พบไมโครโฟนในเครื่องนี้ — เสียบไมค์หรือหูฟังที่มีไมค์ก่อน'
            : name === 'NotReadableError' || name === 'TrackStartError'
              ? 'ไมค์ถูกใช้งานโดยโปรแกรมอื่นอยู่ — ปิดโปรแกรมนั้นแล้วลองใหม่'
              : // The commonest failure in a browser by far, and the one the
                // old fallback gave the wrong instructions for: the fix is the
                // site's own permission prompt, not an OS settings pane for an
                // "app" that does not exist here.
                name === 'NotAllowedError' || name === 'PermissionDeniedError'
                ? 'เบราว์เซอร์ยังไม่อนุญาตให้ใช้ไมค์ — กดไอคอนหน้าช่องที่อยู่เว็บแล้วอนุญาตไมโครโฟน'
                : 'เปิดไมค์ไม่ได้ — ตรวจสอบการตั้งค่าไมโครโฟนแล้วลองใหม่'
        setState((s) => ({ ...s, recordingLineId: null, micError }))
      } finally {
        startingRef.current = false
      }
    },
    [projectUid, teardown]
  )

  const stop = useCallback(() => {
    const rec = recorderRef.current
    if (rec && rec.state !== 'inactive') rec.stop()
  }, [])

  return { ...state, saving, start, stop, hasMic }
}
