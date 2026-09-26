import { useEffect, useRef, useState } from 'react'
import type { EditorMusic, MusicPatch } from '../../../lib/editorApi'
import { bindPointerDrag, type DragScroller } from '../../../lib/pointerDrag'
import {
  clamp,
  fmtTimeTenths,
  snapMusicOffsetToCut,
  type TrimEdge
} from '../../../lib/timelineMath'
import { quantizeToFrame, snapScrub, snapSpan, type SnapHit } from '../../../lib/timelineSnap'
import { MUSIC_LANE_PX } from '../constants'
import type { SnapContext } from '../types'
import { DragReadout } from './DragReadout'
import { musicReadoutText, pickMusicSnap } from './sceneLabel'

const MUSIC_MIN_SEC = 0.3

/** A span snap needs an upper bound; the music may start anywhere. */
const NO_MAX_END = 1e9

/** Background-music block on the เพลง track — waveform behind, name + volume
 * on top; drag the block to change offsetSec, drag either edge to trim. Every
 * drag snaps to the output targets (cut edges, VO lines, playhead, markers,
 * captions) and, when the track has beats, a beat onto a cut — whichever
 * moves the block less. */
export function MusicBlock({
  music,
  peaks,
  fullDurationSec,
  pxPerSec,
  getSnapContext,
  dragScroller,
  onChange,
  onDraftChange
}: {
  music: EditorMusic
  peaks: number[] | null
  fullDurationSec: number
  pxPerSec: number
  /** Asked once per drag; isActive / tolSec / targets are read per frame. */
  getSnapContext: () => SnapContext
  dragScroller?: DragScroller
  onChange: (patch: MusicPatch) => void
  /** Fired on every drag move (and null on release) purely for the parent's
   * live audio preview — not persisted, unlike onChange. */
  onDraftChange?: (patch: MusicPatch | null) => void
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [draft, setDraft] = useState<MusicPatch | null>(null)
  const [readout, setReadout] = useState<{
    text: string
    anchor: 'left' | 'right' | 'center'
  } | null>(null)
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
    const ctx = getSnapContext()
    const startOffset = music.offsetSec
    const startTrimIn = music.trimInSec
    const startTrimOut = music.trimOutSec ?? fullDurationSec
    const len = Math.max(startTrimOut - startTrimIn, MUSIC_MIN_SEC)
    let last: MusicPatch = {}
    bindPointerDrag({
      e,
      pxPerSec,
      scroller: dragScroller,
      onFrame(f) {
        const raw = Math.max(quantizeToFrame(startOffset + f.deltaSec), 0)
        let next = raw
        let hit: SnapHit | null = null
        if (ctx.isActive() && !f.altKey) {
          const tolSec = ctx.tolSec()
          const targets = ctx.outputTargets()
          // (a) the block's own edges onto anything on the output clock …
          const span = snapSpan({
            start: raw,
            end: raw + len,
            minStart: 0,
            maxEnd: NO_MAX_END,
            targets,
            tolSec
          })
          // … (b) or a beat onto a cut — beats matter more than where the file
          // starts (snapMusicOffsetToCut). The smaller move wins.
          const beat = music.beats?.length
            ? snapMusicOffsetToCut(
                raw,
                music.beats,
                targets.filter((t) => t.kind === 'cut' || t.kind === 'end').map((t) => t.sec),
                startTrimIn,
                tolSec
              )
            : null
          const pick = pickMusicSnap(raw, span, beat)
          next = pick.offsetSec
          hit = pick.hit
        }
        ctx.report(hit, 'output')
        last = { offsetSec: next }
        setDraft(last)
        onDraftChange?.(last)
        setReadout({ text: musicReadoutText(next), anchor: 'left' })
      },
      onEnd({ cancelled }) {
        ctx.report(null, 'output')
        setDraft(null)
        onDraftChange?.(null)
        setReadout(null)
        if (!cancelled && last.offsetSec !== undefined) onChange(last)
      }
    })
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
    if (e.button !== 0) return
    // Not a move of the whole block (the binder stops propagation too, but
    // only once it is reached).
    e.stopPropagation()
    // The track's length comes from decoding the file, which can still be in
    // flight (or have failed). With 0 the right-edge clamp inverts —
    // clamp(x, trimIn + 0.3, 0) returns 0.3 — so one drag committed a track
    // trimmed to 0.3s and re-mixed the whole clip against it.
    if (fullDurationSec <= 0) return
    const ctx = getSnapContext()
    const startTrimIn = music.trimInSec
    const startTrimOut = music.trimOutSec ?? fullDurationSec
    const startOffset = music.offsetSec
    let last: MusicPatch = {}
    bindPointerDrag({
      e,
      pxPerSec,
      scroller: dragScroller,
      onFrame(f) {
        const snapActive = ctx.isActive() && !f.altKey
        const targets = snapActive ? ctx.outputTargets() : []
        const tolSec = ctx.tolSec()
        let hit: SnapHit | null = null
        if (edge === 'left') {
          // The left edge sits at offsetSec on the output clock: trimming the
          // head moves the block's start by the same amount.
          const lo = 0
          const hi = startTrimOut - MUSIC_MIN_SEC
          let nextIn = clamp(quantizeToFrame(startTrimIn + f.deltaSec), lo, hi)
          if (snapActive) {
            const s = snapScrub(startOffset + (nextIn - startTrimIn), targets, tolSec)
            const snappedIn = clamp(startTrimIn + (s.sec - startOffset), lo, hi)
            // A snap the clamp undid draws no guide.
            hit = Math.abs(snappedIn - (startTrimIn + (s.sec - startOffset))) < 1e-9 ? s.hit : null
            nextIn = snappedIn
          }
          const applied = nextIn - startTrimIn
          const nextOffset = Math.max(startOffset + applied, 0)
          last = { trimInSec: nextIn, offsetSec: nextOffset }
          setReadout({ text: musicReadoutText(nextOffset), anchor: 'left' })
        } else {
          // The right edge sits at offsetSec + (trimOut − trimIn).
          const lo = startTrimIn + MUSIC_MIN_SEC
          const hi = fullDurationSec
          let nextOut = clamp(quantizeToFrame(startTrimOut + f.deltaSec), lo, hi)
          if (snapActive) {
            const s = snapScrub(startOffset + (nextOut - startTrimIn), targets, tolSec)
            const snappedOut = clamp(startTrimIn + (s.sec - startOffset), lo, hi)
            hit = Math.abs(snappedOut - (startTrimIn + (s.sec - startOffset))) < 1e-9 ? s.hit : null
            nextOut = snappedOut
          }
          last = { trimOutSec: nextOut }
          setReadout({
            text: `จบที่ ${fmtTimeTenths(startOffset + (nextOut - startTrimIn))}`,
            anchor: 'right'
          })
        }
        ctx.report(hit, 'output')
        setDraft(last)
        onDraftChange?.(last)
      },
      onEnd({ cancelled }) {
        ctx.report(null, 'output')
        setDraft(null)
        onDraftChange?.(null)
        setReadout(null)
        if (!cancelled && Object.keys(last).length > 0) onChange(last)
      }
    })
  }

  return (
    <div
      data-cut-block
      className="absolute inset-y-0 flex cursor-grab items-center rounded-[5px] border border-border bg-surface active:cursor-grabbing"
      style={{ left, width }}
      onPointerDown={onMoveDown}
      title="ลากเพื่อเลื่อนตำแหน่งเพลง · Alt ค้าง = ปิดดูดขอบ"
    >
      {/* The clipped inner box — the readout hangs above the block. */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-[5px]">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full"
          style={{ width, height: MUSIC_LANE_PX }}
        />
      </div>
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
        aria-label="ระดับเสียงเพลง"
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
            role="slider"
            aria-orientation="horizontal"
            aria-label="จุดเริ่มของเพลง"
            aria-valuemin={0}
            aria-valuemax={trimOut}
            aria-valuenow={trimInSec}
            tabIndex={-1}
            onPointerDown={(e) => onTrimDown(e, 'left')}
            title="ลากเพื่อตัดต้นเพลง"
            className="absolute top-0 left-0 z-20 h-full w-[10px] cursor-ew-resize touch-none rounded-l-[5px] bg-accent/60 hover:bg-accent"
          />
          <button
            type="button"
            data-trim-handle
            role="slider"
            aria-orientation="horizontal"
            aria-label="จุดจบของเพลง"
            aria-valuemin={trimInSec}
            aria-valuemax={fullDurationSec}
            aria-valuenow={trimOut}
            tabIndex={-1}
            onPointerDown={(e) => onTrimDown(e, 'right')}
            title="ลากเพื่อตัดท้ายเพลง"
            className="absolute top-0 right-0 z-20 h-full w-[10px] cursor-ew-resize touch-none rounded-r-[5px] bg-accent/60 hover:bg-accent"
          />
        </>
      ) : null}
      {readout && <DragReadout text={readout.text} anchor={readout.anchor} />}
    </div>
  )
}
