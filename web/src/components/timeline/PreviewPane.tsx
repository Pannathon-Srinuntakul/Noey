import { memo, useEffect, useRef, useState } from 'react'
import type { RefObject, VideoHTMLAttributes } from 'react'
import { VideoTransport } from '../ui/VideoTransport'
import { withShortcut } from './shortcuts'

/** The handlers both preview <video>s carry, as one object spread on each. */
export type PreviewVideoEvents = Pick<
  VideoHTMLAttributes<HTMLVideoElement>,
  'onClick' | 'onTimeUpdate' | 'onLoadedMetadata' | 'onSeeked' | 'onEnded' | 'onPlay' | 'onPause'
>

// Constant style objects: React writes a style only when its value changes,
// and the player owns `opacity` on both elements between renders.
const STAGE_STYLE = { width: 'auto', aspectRatio: '9 / 16' } as const
const TWO_UP_STAGE_STYLE = { width: 'auto', aspectRatio: '18 / 16' } as const
const VIDEO_A_STYLE = { opacity: 1 } as const
const VIDEO_B_STYLE = { opacity: 0 } as const

/**
 * The stage: the two preview <video>s, the caption overlay, the music
 * <audio> and the transport on top.
 *
 * Everything that moves per frame here is painted straight to the DOM by the
 * editor through the refs — the video swap, the caption text, the seekbar
 * and the clock — so this renders only when play/pause, the duration or the
 * transport's own visibility changes. The two <video>s must never remount:
 * which one is showing is set imperatively (opacity), and a remount would
 * put it out of step with the player. So no key, and the `style` literals
 * below stay constant — React writes a style only when its value changes.
 */
export const PreviewPane = memo(function PreviewPane({
  videoARef,
  videoBRef,
  captionOverlayRef,
  holdFrameRef,
  musicAudioRef,
  seekbarRef,
  timeLabelRef,
  isPlaying,
  durationSec,
  hasPreview,
  videoEvents,
  onTogglePlay,
  onSeek,
  onScrubStart,
  onScrubEnd,
  onStepBack,
  onStepForward,
  loop = false,
  onToggleLoop,
  onPlayScene,
  canPlayScene = false,
  twoUp = false,
  twoUpIncoming = 'B',
  onTimeEditStart,
  onTimeEditEnd
}: {
  videoARef: RefObject<HTMLVideoElement | null>
  videoBRef: RefObject<HTMLVideoElement | null>
  captionOverlayRef: RefObject<HTMLDivElement | null>
  /** The last frame, held over both videos while another file loads — the
   * player draws it and shows/hides it (usePreviewPlayer holdFrame). */
  holdFrameRef: RefObject<HTMLCanvasElement | null>
  musicAudioRef: RefObject<HTMLAudioElement | null>
  seekbarRef: RefObject<HTMLInputElement | null>
  timeLabelRef: RefObject<HTMLSpanElement | null>
  isPlaying: boolean
  durationSec: number
  /** A source is loaded — until then the play button says why it is off. */
  hasPreview: boolean
  videoEvents: PreviewVideoEvents
  onTogglePlay: () => void
  onSeek: (sec: number) => void
  onScrubStart: () => void
  onScrubEnd: () => void
  /** Previous / next CUT, not frame: the arrow keys already step frames, and
   * a one-frame button on a transport this size is a button nobody can aim
   * with. Every NLE puts shot navigation here. */
  onStepBack: () => void
  onStepForward: () => void
  /** Transport extras — see ui/VideoTransport. */
  loop?: boolean
  onToggleLoop?: () => void
  onPlayScene?: () => void
  canPlayScene?: boolean
  /** Roll / slip two-up: both <video>s side by side, outgoing | incoming.
   * The player seeks each (paintTwoUp); this only lays them out. */
  twoUp?: boolean
  /** Which element the player put the INCOMING frame on (its active one) —
   * that one goes on the right. */
  twoUpIncoming?: 'A' | 'B'
  /** The clock is being typed into — the player stops painting the label. */
  onTimeEditStart?: () => void
  onTimeEditEnd?: () => void
}): React.JSX.Element {
  // Transport auto-hide, the way a video player does it: on screen while the
  // pointer is on the stage, and for a moment after it stops moving; always on
  // while paused, because then it is the only thing to act on.
  const [transportOn, setTransportOn] = useState(false)
  const transportTimer = useRef<number | undefined>(undefined)
  // See ui/VideoPlayer: on a touch screen `pointermove` only fires while a
  // finger is down and `pointerleave` fires on lift, so a hover-driven overlay
  // is visible exactly while it is being pressed. Touch gets a longer grace
  // period and never gets hidden by `pointerleave`.
  const coarsePointer = useRef(false)
  const showTransport = (): void => {
    setTransportOn(true)
    window.clearTimeout(transportTimer.current)
    transportTimer.current = window.setTimeout(
      () => setTransportOn(false),
      coarsePointer.current ? 4000 : 2000
    )
  }
  useEffect(() => () => window.clearTimeout(transportTimer.current), [])

  const transportVisible = transportOn || !isPlaying

  // Two-up: each element takes one half (still 9:16 each — the stage
  // doubles its aspect). Both are forced visible with an !important opacity
  // so the player's imperative opacity (which one is "showing") is
  // overridden only while the class is on and rules again the moment it is
  // off — no React write to `style.opacity`, which would race the player's
  // own restore. No key changes: the elements never remount.
  const aOnLeft = twoUpIncoming === 'B'
  const twoUpCls = (left: boolean): string =>
    left ? 'inset-y-0 left-0 w-1/2 opacity-100!' : 'inset-y-0 right-0 w-1/2 opacity-100!'
  const videoCls = (left: boolean): string =>
    twoUp
      ? `absolute h-full rounded-xl bg-black object-contain ${twoUpCls(left)}`
      : 'absolute inset-0 h-full w-full rounded-xl bg-black object-contain'

  return (
    <div
      className="group/stage relative flex h-full min-h-0 max-w-full flex-1 items-center justify-center"
      style={twoUp ? TWO_UP_STAGE_STYLE : STAGE_STYLE}
      onPointerDown={(e) => {
        coarsePointer.current = e.pointerType === 'touch'
        if (e.pointerType === 'touch') showTransport()
      }}
      onPointerMove={(e) => {
        if (e.pointerType !== 'touch') showTransport()
      }}
      onPointerLeave={(e) => {
        if (e.pointerType !== 'touch') setTransportOn(false)
      }}
    >
      {/* Two elements so the "next" edited-mode segment can be pre-seeked hidden, then swapped in instantly. */}
      {/* Clicking the picture toggles playback, the way every video
        player does — the transport button was the only way before
        (live report 2026-08-13). It sits on both elements because
        which one is on top changes with every scene swap. */}
      <video ref={videoARef} {...videoEvents} className={videoCls(aOnLeft)} style={VIDEO_A_STYLE} />
      <video
        ref={videoBRef}
        {...videoEvents}
        className={videoCls(!aOnLeft)}
        style={VIDEO_B_STYLE}
      />
      {twoUp ? (
        <>
          <span className="pointer-events-none absolute top-2 left-2 z-10 rounded-full bg-[rgb(0_0_0_/_0.6)] px-2 py-0.5 text-[13px] text-ink">
            ก่อนรอยตัด
          </span>
          <span className="pointer-events-none absolute top-2 right-2 z-10 rounded-full bg-[rgb(0_0_0_/_0.6)] px-2 py-0.5 text-[13px] text-ink">
            หลังรอยตัด
          </span>
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-1/2 z-10 w-px bg-[rgb(243_242_242_/_0.35)]"
          />
        </>
      ) : null}
      {/* The frame held while another source file loads, so the switch never
        flashes black. Above both videos, under the caption; takes no input,
        so a click still reaches the video underneath. */}
      <canvas
        ref={holdFrameRef}
        aria-hidden
        className="pointer-events-none absolute inset-0 z-[3] h-full w-full rounded-xl object-contain"
        style={{ opacity: 0 }}
      />
      {/* Caption under the playhead — same lines the inspector edits. */}
      <div
        ref={captionOverlayRef}
        className="pointer-events-none absolute inset-x-0 bottom-[9%] z-10 px-6 text-center text-[15px] leading-snug font-bold whitespace-pre-wrap text-white"
        style={{ textShadow: '0 0 3px #000, 0 0 3px #000, 0 2px 6px rgba(0,0,0,.95)' }}
      />
      {/* Background music preview — muted/paused unless the playhead is
        inside the music block's active window (see syncMusicAudio). */}
      <audio ref={musicAudioRef} preload="auto" />

      {/* Transport overlaid on the footage (R3), not stacked under
        it — the video is the hero and the controls belong on it. The time
        is painted into the seekbar and the label by the editor, never
        passed down: `currentSec` would re-render this on every frame. */}
      <VideoTransport
        className="rounded-b-xl"
        visible={transportVisible}
        playing={isPlaying}
        currentSec={0}
        durationSec={durationSec}
        seekRef={seekbarRef}
        timeLabelRef={timeLabelRef}
        onTogglePlay={onTogglePlay}
        onSeek={onSeek}
        onScrubStart={onScrubStart}
        onScrubEnd={onScrubEnd}
        onStepBack={onStepBack}
        onStepForward={onStepForward}
        stepBackTitle={withShortcut('ช็อตก่อนหน้า', 'cut-prev')}
        stepForwardTitle={withShortcut('ช็อตถัดไป', 'cut-prev')}
        playTitle={withShortcut(isPlaying ? 'หยุด' : 'เล่น', 'play')}
        playDisabledReason={hasPreview ? undefined : 'ยังไม่มีวิดีโอให้เล่น'}
        loop={loop}
        onToggleLoop={onToggleLoop}
        loopTitle={withShortcut(loop ? 'เล่นวน: เปิดอยู่' : 'เล่นวน', 'loop')}
        onPlayScene={onPlayScene}
        canPlayScene={canPlayScene}
        playSceneTitle={withShortcut('เล่นฉากนี้', 'play-scene')}
        playSceneDisabledReason="เลือกฉากก่อน"
        timeEditable
        onTimeEditStart={onTimeEditStart}
        onTimeEditEnd={onTimeEditEnd}
      />
    </div>
  )
})
