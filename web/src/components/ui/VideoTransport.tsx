import { useEffect } from 'react'
import { Pause, Play, SkipBack, SkipForward } from 'lucide-react'
import { cn } from '../../lib/cn'
import { paintSeekProgress, seekProgressBackground } from '../../lib/seekProgress'
import { fmtTime, fmtTimeTenths } from '../../lib/timelineMath'

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
  visible = true
}: VideoTransportProps): React.JSX.Element {
  const dur = Math.max(durationSec, 0.1)
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
        <span
          ref={timeLabelRef}
          className="ml-auto text-[13px] tabular-nums text-[rgb(243_242_242_/_0.75)]"
        >
          {fmtTimeTenths(currentSec)} / {fmtTime(durationSec)}
        </span>
      </div>
    </div>
  )
}
