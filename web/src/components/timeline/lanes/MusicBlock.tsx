import { useEffect, useRef, useState } from 'react'
import type { EditorMusic, MusicPatch } from '../../../lib/editorApi'
import {
  BEAT_SNAP_THRESHOLD_SEC,
  clamp,
  snapMusicOffsetToCut,
  type TrimEdge
} from '../../../lib/timelineMath'
import { MUSIC_LANE_PX } from '../constants'

const MUSIC_MIN_SEC = 0.3

/** Background-music block on the เพลง track — waveform behind, name + volume
 * on top; drag the block to change offsetSec, drag either edge to trim. */
export function MusicBlock({
  music,
  peaks,
  fullDurationSec,
  pxPerSec,
  cutBoundaries = [],
  snapEnabled = false,
  onChange,
  onDraftChange
}: {
  music: EditorMusic
  peaks: number[] | null
  fullDurationSec: number
  pxPerSec: number
  /** Scene boundaries on the output clock — a dragged track snaps so that one
   * of its beats lands on one of these. */
  cutBoundaries?: number[]
  snapEnabled?: boolean
  onChange: (patch: MusicPatch) => void
  /** Fired on every drag move (and null on release) purely for the parent's
   * live audio preview — not persisted, unlike onChange. */
  onDraftChange?: (patch: MusicPatch | null) => void
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [draft, setDraft] = useState<MusicPatch | null>(null)
  const offsetSec = draft?.offsetSec ?? music.offsetSec
  const trimInSec = draft?.trimInSec ?? music.trimInSec
  const trimOut = draft?.trimOutSec ?? music.trimOutSec ?? fullDurationSec
  const volume = draft?.volume ?? music.volume
  // The slider's uncommitted value. A range input fires onChange on every
  // step of a drag, and each commit is one undo step plus one full re-mix of
  // the music onto the cut — so the drag only drafts (the parent plays the
  // draft volume live) and commits once on release, like the drags above.
  // Keyboard steps work the same way: a held arrow key drafts, keyup commits.
  const volumeDraftRef = useRef<number | null>(null)
  const blockDurationSec = Math.max(trimOut - trimInSec, MUSIC_MIN_SEC)
  const left = offsetSec * pxPerSec
  const width = Math.max(blockDurationSec * pxPerSec, 24)
  const name = music.path ? (music.path.split(/[\\/]/).pop() ?? 'เพลงประกอบ') : 'เพลงประกอบ'

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !peaks || peaks.length === 0 || fullDurationSec <= 0) return
    const dpr = window.devicePixelRatio || 1
    const h = MUSIC_LANE_PX
    canvas.width = width * dpr
    canvas.height = h * dpr
    const g = canvas.getContext('2d')
    if (!g) return
    g.scale(dpr, dpr)
    g.clearRect(0, 0, width, h)
    const startFrac = trimInSec / fullDurationSec
    const endFrac = trimOut / fullDurationSec
    const i0 = Math.floor(startFrac * peaks.length)
    const i1 = Math.max(i0 + 1, Math.ceil(endFrac * peaks.length))
    const slice = peaks.slice(i0, i1)
    const barW = Math.max(width / Math.max(slice.length, 1), 1)
    g.fillStyle = 'rgba(217, 164, 65, 0.4)'
    slice.forEach((p, i) => {
      const bh = Math.max(p * (h - 6), 1.5)
      g.fillRect(i * barW, (h - bh) / 2, Math.max(barW - 0.5, 0.5), bh)
    })
  }, [peaks, width, fullDurationSec, trimInSec, trimOut])

  const onMoveDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const startX = e.clientX
    const startOffset = music.offsetSec
    let last: MusicPatch = {}
    // One draft per frame, the newest pointer position winning — see
    // bindTrimDrag. Each draft re-renders this block and re-syncs the audio.
    let lastX = startX
    let frame = 0
    const apply = (): void => {
      frame = 0
      const deltaSec = (lastX - startX) / pxPerSec
      const raw = Math.max(startOffset + deltaSec, 0)
      // Land a beat on a cut rather than the file's start on a cut — see
      // snapMusicOffsetToCut. Threshold scales with zoom so it stays a ~10px
      // pull at any timeline scale.
      const offsetSec = snapEnabled
        ? snapMusicOffsetToCut(
            raw,
            music.beats ?? null,
            cutBoundaries,
            music.trimInSec,
            Math.max(BEAT_SNAP_THRESHOLD_SEC, 10 / Math.max(pxPerSec, 1))
          )
        : raw
      last = { offsetSec }
      setDraft(last)
      onDraftChange?.(last)
    }
    const onMove = (ev: PointerEvent): void => {
      lastX = ev.clientX
      if (!frame) frame = window.requestAnimationFrame(apply)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      // Land the last position before it is committed.
      if (frame) {
        window.cancelAnimationFrame(frame)
        apply()
      }
      setDraft(null)
      onDraftChange?.(null)
      if (last.offsetSec !== undefined) onChange(last)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  const commitVolume = (): void => {
    const v = volumeDraftRef.current
    if (v === null) return
    volumeDraftRef.current = null
    setDraft(null)
    onDraftChange?.(null)
    // An unchanged value is dropped by the parent (commitMusic's sameMusic),
    // so a click that lands on the current value adds no undo step.
    onChange({ volume: v })
  }

  const onVolumeDown = (e: React.PointerEvent): void => {
    e.stopPropagation()
    // On the window, not the input: a drag released off the slider still
    // ends it.
    const onUp = (): void => {
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      commitVolume()
    }
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  const onVolumeInput = (v: number): void => {
    volumeDraftRef.current = v
    setDraft({ volume: v })
    onDraftChange?.({ volume: v })
  }

  const onTrimDown = (e: React.PointerEvent, edge: TrimEdge): void => {
    e.stopPropagation()
    e.preventDefault()
    // The track's length comes from decoding the file, which can still be in
    // flight (or have failed). With 0 the right-edge clamp inverts —
    // clamp(x, trimIn + 0.3, 0) returns 0.3 — so one drag committed a track
    // trimmed to 0.3s and re-mixed the whole clip against it.
    if (fullDurationSec <= 0) return
    const startX = e.clientX
    const startTrimIn = music.trimInSec
    const startTrimOut = music.trimOutSec ?? fullDurationSec
    const startOffset = music.offsetSec
    let last: MusicPatch = {}
    // One draft per frame, as for the move above.
    let lastX = startX
    let frame = 0
    const apply = (): void => {
      frame = 0
      const deltaSec = (lastX - startX) / pxPerSec
      if (edge === 'left') {
        const nextIn = clamp(startTrimIn + deltaSec, 0, startTrimOut - MUSIC_MIN_SEC)
        const applied = nextIn - startTrimIn
        last = { trimInSec: nextIn, offsetSec: Math.max(startOffset + applied, 0) }
      } else {
        const nextOut = clamp(startTrimOut + deltaSec, startTrimIn + MUSIC_MIN_SEC, fullDurationSec)
        last = { trimOutSec: nextOut }
      }
      setDraft(last)
      onDraftChange?.(last)
    }
    const onMove = (ev: PointerEvent): void => {
      lastX = ev.clientX
      if (!frame) frame = window.requestAnimationFrame(apply)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      // Land the last position before it is committed.
      if (frame) {
        window.cancelAnimationFrame(frame)
        apply()
      }
      setDraft(null)
      onDraftChange?.(null)
      if (Object.keys(last).length > 0) onChange(last)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  return (
    <div
      data-cut-block
      className="absolute inset-y-0 flex cursor-grab items-center overflow-hidden rounded-[5px] border border-border bg-surface active:cursor-grabbing"
      style={{ left, width }}
      onPointerDown={onMoveDown}
      title="ลากเพื่อเลื่อนตำแหน่งเพลง"
    >
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-0 h-full w-full"
        style={{ width, height: MUSIC_LANE_PX }}
      />
      <div className="pointer-events-none relative z-10 flex min-w-0 items-center gap-2 pr-3 pl-3 text-[13px] text-ink">
        <span className="truncate">{name}</span>
        <span className="shrink-0 tabular-nums text-muted">
          {Math.round((music.muted ? 0 : volume) * 100)}%
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={volume}
        data-trim-handle
        onPointerDown={onVolumeDown}
        onChange={(e) => onVolumeInput(Number(e.target.value))}
        onKeyUp={commitVolume}
        onBlur={commitVolume}
        className="relative z-10 h-[3px] w-16 shrink-0 accent-[var(--color-accent)]"
        title="ระดับเสียงเพลง"
      />
      {/* Not offered until the track's length is known — a trim against an
          unknown duration cannot produce a correct range (see onTrimDown). */}
      {fullDurationSec > 0 ? (
        <>
          <button
            type="button"
            data-trim-handle
            onPointerDown={(e) => onTrimDown(e, 'left')}
            title="ลากเพื่อตัดต้นเพลง"
            className="absolute top-0 left-0 z-20 h-full w-[10px] cursor-ew-resize touch-none rounded-l-[5px] bg-accent/60 hover:bg-accent"
          />
          <button
            type="button"
            data-trim-handle
            onPointerDown={(e) => onTrimDown(e, 'right')}
            title="ลากเพื่อตัดท้ายเพลง"
            className="absolute top-0 right-0 z-20 h-full w-[10px] cursor-ew-resize touch-none rounded-r-[5px] bg-accent/60 hover:bg-accent"
          />
        </>
      ) : null}
    </div>
  )
}
