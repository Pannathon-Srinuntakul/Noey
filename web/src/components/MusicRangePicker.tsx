import { useEffect, useRef, useState } from 'react'
import { Check, Loader2, Pause, Play } from 'lucide-react'
import { decodeAudioPeaks } from '../lib/waveform'
import { Button } from './ui/Button'
import { Dialog } from './ui/Dialog'

const MIN_RANGE_SEC = 1
const CANVAS_WIDTH = 520
const CANVAS_HEIGHT = 72

function fmtTime(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${String(r).padStart(2, '0')}`
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

interface Props {
  file: File
  /** Re-opening the picker on an already-selected range (e.g. "แก้ไขช่วง"). */
  initialTrimInSec?: number
  initialTrimOutSec?: number | null
  onConfirm: (range: { trimInSec: number; trimOutSec: number }) => void
  onCancel: () => void
}

/** Modal: pick a sub-range of an uploaded music file with a real audio
 * preview (loops the selected range on play) — not just blind dragging. */
export default function MusicRangePicker({
  file,
  initialTrimInSec,
  initialTrimOutSec,
  onConfirm,
  onCancel
}: Props): React.JSX.Element {
  // Created inside an effect (not useMemo) and revoked by that SAME effect's
  // cleanup — StrictMode's dev-mode double-invoke (mount → cleanup → mount)
  // otherwise revokes the memoized URL after its phantom cycle before the
  // real decode/playback ever uses it ("Failed to fetch" on first open).
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [peaks, setPeaks] = useState<number[] | null>(null)
  const [durationSec, setDurationSec] = useState(0)
  const [trimInSec, setTrimInSec] = useState(initialTrimInSec ?? 0)
  const [trimOutSec, setTrimOutSec] = useState(initialTrimOutSec ?? 0)
  const [playing, setPlaying] = useState(false)
  const [playheadSec, setPlayheadSec] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const url = URL.createObjectURL(file)
    let cancelled = false
    decodeAudioPeaks(url)
      .then(({ peaks: p, durationSec: d }) => {
        if (cancelled) return
        setObjectUrl(url)
        setPeaks(p)
        setDurationSec(d)
        setTrimOutSec((prev) => (prev > 0 ? Math.min(prev, d) : d))
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(String((err as Error)?.message ?? err))
      })
    return () => {
      cancelled = true
      URL.revokeObjectURL(url)
    }
  }, [file])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !peaks || peaks.length === 0) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = CANVAS_WIDTH * dpr
    canvas.height = CANVAS_HEIGHT * dpr
    const g = canvas.getContext('2d')
    if (!g) return
    g.scale(dpr, dpr)
    g.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT)
    const barW = Math.max(CANVAS_WIDTH / peaks.length, 1)
    g.fillStyle = 'rgba(217, 164, 65, 0.35)' // --color-accent
    peaks.forEach((p, i) => {
      const h = Math.max(p * (CANVAS_HEIGHT - 4), 1.5)
      g.fillRect(i * barW, (CANVAS_HEIGHT - h) / 2, Math.max(barW - 0.5, 0.5), h)
    })
  }, [peaks])

  const pxPerSec = durationSec > 0 ? CANVAS_WIDTH / durationSec : 0
  const selLeft = trimInSec * pxPerSec
  const selWidth = Math.max((trimOutSec - trimInSec) * pxPerSec, 2)
  const playheadLeft = playheadSec * pxPerSec

  const onHandleDown =
    (edge: 'left' | 'right') =>
    (e: React.PointerEvent): void => {
      e.stopPropagation()
      e.preventDefault()
      // Captured once at drag-start (not re-read from the ref inside onMove) —
      // the modal doesn't scroll/resize mid-drag, and a ref shouldn't be read
      // from deep inside a nested render-scope closure anyway.
      const rect = trackRef.current?.getBoundingClientRect()
      const onMove = (ev: PointerEvent): void => {
        if (!rect || durationSec <= 0) return
        const sec = clamp(((ev.clientX - rect.left) / rect.width) * durationSec, 0, durationSec)
        if (edge === 'left') setTrimInSec(clamp(sec, 0, trimOutSec - MIN_RANGE_SEC))
        else setTrimOutSec(clamp(sec, trimInSec + MIN_RANGE_SEC, durationSec))
      }
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    }

  /** Click/drag anywhere on the waveform (outside the trim handles, which stop
   * propagation) auditions that point — seeks + starts playing so dragging the
   * indicator lets the user listen to whichever part they land on, not just
   * the currently selected range. */
  const onTrackPointerDown = (e: React.PointerEvent): void => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || durationSec <= 0) return
    const seekTo = (clientX: number): void => {
      const sec = clamp(((clientX - rect.left) / rect.width) * durationSec, 0, durationSec)
      setPlayheadSec(sec)
      const audio = audioRef.current
      if (audio) audio.currentTime = sec
    }
    seekTo(e.clientX)
    const audio = audioRef.current
    if (audio?.paused) {
      void audio.play()
      setPlaying(true)
    }
    const onMove = (ev: PointerEvent): void => seekTo(ev.clientX)
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const togglePlay = (): void => {
    const audio = audioRef.current
    if (!audio) return
    if (playing) {
      audio.pause()
      setPlaying(false)
      return
    }
    audio.currentTime = trimInSec
    void audio.play()
    setPlaying(true)
  }

  const onTimeUpdate = (): void => {
    const audio = audioRef.current
    if (!audio) return
    setPlayheadSec(audio.currentTime)
    if (audio.currentTime >= trimOutSec) {
      audio.currentTime = trimInSec
    }
  }

  const ready = peaks !== null && durationSec > 0

  return (
    <Dialog open onClose={onCancel} title="เลือกช่วงเพลง" subtitle={file.name} width={600}>
      <>
        {error && (
          <p className="mb-3 rounded-md border border-error bg-error-tint px-3 py-2 text-sm text-error">
            อ่านไฟล์เสียงไม่ได้: {error}
          </p>
        )}

        {!ready && !error && (
          <div className="flex h-[72px] items-center justify-center gap-2 text-sm text-muted">
            <Loader2 size={14} className="animate-spin" /> กำลังโหลดเพลง…
          </div>
        )}

        {ready && (
          <>
            <div
              ref={trackRef}
              onPointerDown={onTrackPointerDown}
              title="ลากเพื่อฟังช่วงที่ต้องการ"
              className="relative cursor-text select-none rounded-md border border-border bg-ground"
              style={{ width: CANVAS_WIDTH, height: CANVAS_HEIGHT }}
            >
              <canvas
                ref={canvasRef}
                style={{ width: CANVAS_WIDTH, height: CANVAS_HEIGHT }}
                className="pointer-events-none absolute inset-0"
              />
              {/* dim the unselected regions */}
              <div
                className="pointer-events-none absolute inset-y-0 left-0 bg-black/60"
                style={{ width: selLeft }}
              />
              <div
                className="pointer-events-none absolute inset-y-0 right-0 bg-black/60"
                style={{ width: CANVAS_WIDTH - selLeft - selWidth }}
              />
              <div
                className="pointer-events-none absolute inset-y-0 border-x-2 border-accent bg-accent-tint"
                style={{ left: selLeft, width: selWidth }}
              />
              <div
                className="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow-[0_0_6px_rgba(255,255,255,0.8)]"
                style={{ left: playheadLeft }}
              />
              <button
                type="button"
                onPointerDown={onHandleDown('left')}
                title="ลากเพื่อปรับจุดเริ่ม"
                className="absolute top-0 h-full w-3 -translate-x-1/2 cursor-ew-resize touch-none"
                style={{ left: selLeft }}
              >
                <span className="mx-auto block h-full w-1 rounded-full bg-accent shadow" />
              </button>
              <button
                type="button"
                onPointerDown={onHandleDown('right')}
                title="ลากเพื่อปรับจุดจบ"
                className="absolute top-0 h-full w-3 -translate-x-1/2 cursor-ew-resize touch-none"
                style={{ left: selLeft + selWidth }}
              >
                <span className="mx-auto block h-full w-1 rounded-full bg-accent shadow" />
              </button>
            </div>

            <audio
              ref={audioRef}
              src={objectUrl ?? undefined}
              onTimeUpdate={onTimeUpdate}
              onEnded={() => setPlaying(false)}
            />

            <div className="mt-3 flex items-center justify-between gap-3">
              <Button
                icon={playing ? <Pause size={14} /> : <Play size={14} />}
                onClick={togglePlay}
              >
                {playing ? 'หยุด' : 'ฟังช่วงที่เลือก'}
              </Button>
              <p className="text-sm tabular-nums text-muted">
                {fmtTime(trimInSec)}–{fmtTime(trimOutSec)}{' '}
                <span className="text-ink-3">({fmtTime(trimOutSec - trimInSec)})</span>
              </p>
            </div>
          </>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            ยกเลิก
          </Button>
          {ready ? (
            <Button
              variant="primary"
              icon={<Check size={14} />}
              onClick={() => onConfirm({ trimInSec, trimOutSec })}
            >
              ใช้ช่วงนี้
            </Button>
          ) : (
            <Button
              variant="primary"
              icon={<Check size={14} />}
              disabled
              disabledReason="รอโหลดเพลงให้เสร็จก่อน"
            >
              ใช้ช่วงนี้
            </Button>
          )}
        </div>
      </>
    </Dialog>
  )
}
