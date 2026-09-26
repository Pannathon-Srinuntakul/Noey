import { useEffect, useState } from 'react'
import { Pause, Play, Repeat, SkipBack, SkipForward, SquarePlay } from 'lucide-react'
import { cn } from '../../lib/cn'
import { paintSeekProgress, seekProgressBackground } from '../../lib/seekProgress'
import { fmtTime, fmtTimeTenths } from '../../lib/timelineMath'
import { TimecodeInput } from '../timeline/inspector/TimecodeInput'

/**
 * The app's ONE transport bar — the timeline editor's, extracted so every
 * preview surface gets the same control: a real draggable seek head (a native
 * `range`, so pointer drag, keyboard arrows and click-to-seek all work for
 * free), step-back/step-forward, a 44px play ring and `m:ss.s / m:ss`.
 *
 * It renders as an OVERLAY on the frame (callers position it), never a bar
 * stacked underneath — the video is the hero.
 *
 * Two kinds of caller:
 *  - `ui/VideoPlayer` wraps a plain `<video>` and drives this from its events.
 *  - `TimelineEditor` owns two buffered `<video>` elements and drives it
 *    imperatively; that is why the seek input can be handed a `ref` and why
 *    time is a prop rather than read from a媒 element in here.
 */

export interface VideoTransportProps {
  playing: boolean
  currentSec: number
  durationSec: number
  onTogglePlay: () => void
  /** Absolute seek (seconds). Fires continuously while dragging the head. */
  onSeek: (sec: number) => void
  /** Pointer went down on / came up off the head — pause during scrub, resume after. */
  onScrubStart?: () => void
  onScrubEnd?: () => void
  /** Step buttons. Default: ∓1s. The editor passes frame steps / scene jumps. */
  onStepBack?: () => void
  onStepForward?: () => void
  stepBackTitle?: string
  stepForwardTitle?: string
  playTitle?: string
  /** Disabled play button (nothing loaded yet) — still shows, still explains. */
  playDisabledReason?: string
  /** Uncontrolled mode for imperative drivers: the input is written directly
   * rather than re-rendered per frame. */
  seekRef?: React.RefObject<HTMLInputElement | null>
  timeLabelRef?: React.RefObject<HTMLSpanElement | null>
  className?: string
  visible?: boolean
  // ---- editor extras (all optional; VideoPlayer / VideoModal pass none) ----
  /** Loop the active range (or the whole sequence). Shown when `onToggleLoop`
   * is given. */
  loop?: boolean
  onToggleLoop?: () => void
  loopTitle?: string
  /** Play the selected scene / the I–O range. Shown when given; disabled with
   * its reason while nothing is selected. */
  onPlayScene?: () => void
  canPlayScene?: boolean
  playSceneTitle?: string
  playSceneDisabledReason?: string
  /** Clicking the clock swaps it for a timecode field (m:ss.s · h:mm:ss ·
   * m:ss:ff · seconds); Enter commits through `onSeek`. Shown only when
   * `timeEditable`. The driver stops painting the label between these two. */
  timeEditable?: boolean
  onTimeEditStart?: () => void
  onTimeEditEnd?: () => void
}

/** Arrow-key seek unit. One second is what a person means by "back a bit". */
const ARROW_STEP_SEC = 1

export function VideoTransport({
  playing,
  currentSec,
  durationSec,
  onTogglePlay,
  onSeek,
  onScrubStart,
  onScrubEnd,
  onStepBack,
  onStepForward,
  stepBackTitle = 'ถอย 1 วินาที',
  stepForwardTitle = 'เดินหน้า 1 วินาที',
  playTitle,
  playDisabledReason,
  seekRef,
  timeLabelRef,
  className,
  visible = true,
  loop = false,
  onToggleLoop,
  loopTitle = 'เล่นวน',
  onPlayScene,
  canPlayScene = false,
  playSceneTitle = 'เล่นฉากนี้',
  playSceneDisabledReason = 'เลือกฉากก่อน',
  timeEditable = false,
  onTimeEditStart,
  onTimeEditEnd
}: VideoTransportProps): React.JSX.Element {
  const dur = Math.max(durationSec, 0.1)
  // The clock's value when the field opened, or null while it is a label. In
  // imperative mode the live position is in the seek input, not in props, so
  // it is read in the click handler and carried in state.
  const [editingTime, setEditingTime] = useState<number | null>(null)
  const openTimeEdit = (): void =>
    setEditingTime(seekRef?.current ? Number(seekRef.current.value) : currentSec)
  const stepBack = onStepBack ?? (() => onSeek(Math.max(0, currentSec - 1)))
  const stepForward = onStepForward ?? (() => onSeek(Math.min(dur, currentSec + 1)))
  const playedPct = (Math.min(currentSec, dur) / dur) * 100

  // Imperative mode: the driver owns the value, so the first paint (and any
  // repaint after the duration changes, i.e. a different clip) happens here.
  // Per-frame repaints come from the driver calling paintSeekProgress.
  useEffect(() => {
    if (seekRef) paintSeekProgress(seekRef.current)
  }, [seekRef, durationSec])

  return (
    <div
      className={cn(
        'absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/72 to-transparent px-3 pt-6 pb-3 transition-opacity duration-panel ease-out',
        visible ? 'opacity-100' : 'pointer-events-none opacity-0',
        className
      )}
    >
      <input
        ref={seekRef}
        type="range"
        min={0}
        max={dur}
        step={0.01}
        // Uncontrolled only when a driver owns the element (see seekRef).
        {...(seekRef ? { defaultValue: 0 } : { value: Math.min(currentSec, dur) })}
        onPointerDown={onScrubStart}
        onPointerUp={onScrubEnd}
        // A range input steps by `step`, and `step` is 0.01 so DRAGGING is
        // smooth — which left the arrow keys nudging by a hundredth of a
        // second, useless for finding a moment. Keyboard gets its own unit.
        onKeyDown={(e) => {
          const dir = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
          if (!dir) return
          e.preventDefault()
          // A driver writes the live position into the input itself and need
          // not re-render us with it, so step from what the input holds.
          const from = seekRef?.current ? Number(seekRef.current.value) : currentSec
          const next = Math.min(dur, Math.max(0, from + dir * ARROW_STEP_SEC))
          if (seekRef?.current) {
            seekRef.current.value = String(next)
            paintSeekProgress(seekRef.current)
          }
          onSeek(next)
        }}
        onChange={(e) => {
          // Dragging in imperative mode must fill immediately — waiting for the
          // driver's next frame lags the head visibly.
          if (seekRef) paintSeekProgress(e.currentTarget)
          onSeek(Number(e.target.value))
        }}
        // Played portion, so the bar reads as progress instead of an empty rail
        // with a dot on it (live report 2026-08-13).
        {...(seekRef ? {} : { style: { background: seekProgressBackground(playedPct) } })}
        className="noey-slider h-[3px] w-full appearance-none rounded-[2px] bg-[rgb(243_242_242_/_0.28)] outline-none"
        title="ลากเพื่อเลื่อนตำแหน่งเล่น"
        aria-label="ตำแหน่งเล่น"
      />
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          onClick={stepBack}
          title={stepBackTitle}
          className="rounded p-1.5 text-[rgb(243_242_242_/_0.75)] transition-colors duration-state hover:text-ink"
        >
          <SkipBack size={15} />
        </button>
        {playDisabledReason ? (
          <span
            className="flex h-11 w-11 items-center justify-center rounded-full border border-border-faint text-muted"
            title={playDisabledReason}
          >
            <Play size={17} className="ml-0.5" />
          </span>
        ) : (
          <button
            type="button"
            onClick={onTogglePlay}
            title={playTitle ?? (playing ? 'หยุด' : 'เล่น')}
            aria-label={playing ? 'หยุดชั่วคราว' : 'เล่น'}
            className="flex h-11 w-11 items-center justify-center rounded-full border border-accent bg-accent-tint text-accent transition-colors duration-state hover:bg-[rgb(217_164_65_/_0.28)]"
          >
            {playing ? <Pause size={17} /> : <Play size={17} className="ml-0.5" />}
          </button>
        )}
        <button
          type="button"
          onClick={stepForward}
          title={stepForwardTitle}
          className="rounded p-1.5 text-[rgb(243_242_242_/_0.75)] transition-colors duration-state hover:text-ink"
        >
          <SkipForward size={15} />
        </button>
        {onPlayScene ? (
          canPlayScene ? (
            <button
              type="button"
              onClick={onPlayScene}
              title={playSceneTitle}
              aria-label={playSceneTitle}
              className="rounded p-1.5 text-[rgb(243_242_242_/_0.75)] transition-colors duration-state hover:text-ink"
            >
              <SquarePlay size={15} />
            </button>
          ) : (
            <span
              className="rounded p-1.5 text-[rgb(243_242_242_/_0.4)]"
              title={playSceneDisabledReason}
              aria-label={`${playSceneTitle} — ${playSceneDisabledReason}`}
            >
              <SquarePlay size={15} />
            </span>
          )
        ) : null}
        {onToggleLoop ? (
          <button
            type="button"
            onClick={onToggleLoop}
            title={loopTitle}
            aria-label={loopTitle}
            aria-pressed={loop}
            className={cn(
              'rounded p-1.5 transition-colors duration-state hover:text-ink',
              loop ? 'text-accent' : 'text-[rgb(243_242_242_/_0.75)]'
            )}
          >
            <Repeat size={15} />
          </button>
        ) : null}
        {editingTime !== null ? (
          <span className="ml-auto flex items-center gap-1 text-[13px] tabular-nums text-[rgb(243_242_242_/_0.75)]">
            <TimecodeInput
              value={editingTime}
              autoFocus
              ariaLabel="ไปที่เวลา"
              className="h-7 w-[84px] border-[rgb(243_242_242_/_0.35)] bg-[rgb(0_0_0_/_0.45)] px-1.5 py-0 text-[13px]"
              onFocus={() => onTimeEditStart?.()}
              onCommit={(sec) => onSeek(Math.min(dur, Math.max(0, sec)))}
              onSettled={() => {
                setEditingTime(null)
                onTimeEditEnd?.()
              }}
            />
            <span>/ {fmtTime(durationSec)}</span>
          </span>
        ) : null}
        {/* The label stays mounted (hidden) while the field is open, so the
          driver's per-frame writes land somewhere and the text is current
          the moment the field closes. */}
        <span
          ref={timeLabelRef}
          className={cn(
            'ml-auto text-[13px] tabular-nums text-[rgb(243_242_242_/_0.75)]',
            timeEditable && 'cursor-text rounded px-1 hover:bg-[rgb(243_242_242_/_0.1)]',
            editingTime !== null && 'hidden'
          )}
          title={timeEditable ? 'คลิกเพื่อพิมพ์เวลา (m:ss.s หรือ m:ss:ff)' : undefined}
          role={timeEditable ? 'button' : undefined}
          tabIndex={timeEditable ? 0 : undefined}
          onClick={timeEditable ? openTimeEdit : undefined}
          onKeyDown={
            timeEditable
              ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    openTimeEdit()
                  }
                }
              : undefined
          }
        >
          {fmtTimeTenths(currentSec)} / {fmtTime(durationSec)}
        </span>
      </div>
    </div>
  )
}
