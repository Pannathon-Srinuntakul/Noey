import { memo, useEffect, useRef, useState } from 'react'
import type { RefObject, VideoHTMLAttributes } from 'react'
import { VideoTransport } from '../ui/VideoTransport'
import { withShortcut } from './shortcuts'

/** The handlers both preview <video>s carry, as one object spread on each. */
export type PreviewVideoEvents = Pick<
  VideoHTMLAttributes<HTMLVideoElement>,
  'onClick' | 'onTimeUpdate' | 'onLoadedMetadata' | 'onSeeked' | 'onEnded' | 'onPlay' | 'onPause'
>

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
  onStepForward
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

  return (
    <div
      className="group/stage relative flex h-full min-h-0 max-w-full flex-1 items-center justify-center"
      style={{ width: 'auto', aspectRatio: '9 / 16' }}
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
      <video
        ref={videoARef}
        {...videoEvents}
        className="absolute inset-0 h-full w-full rounded-xl bg-black object-contain"
        style={{ opacity: 1 }}
      />
      <video
        ref={videoBRef}
        {...videoEvents}
        className="absolute inset-0 h-full w-full rounded-xl bg-black object-contain"
        style={{ opacity: 0 }}
      />
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
      />
    </div>
  )
})
