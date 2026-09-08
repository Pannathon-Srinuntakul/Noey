import { useEffect, useRef, useState } from 'react'
import { Maximize2 } from 'lucide-react'
import { cn } from '../../lib/cn'
import { seekToPosterFrame } from '../../lib/videoPoster'
import { VideoModal } from './VideoModal'
import { VideoTransport } from './VideoTransport'

/**
 * The app's one video player chrome: a chrome-free `<video>` with the transport
 * as an OVERLAY on the frame, auto-hiding the way a video player does — on
 * screen while the pointer is over the stage and for a moment after it stops
 * moving, gone otherwise.
 *
 * Every preview surface uses this so playback looks and behaves the same
 * everywhere (project detail, voiceover stage, zoom editor). Before it existed
 * each screen drew its own: a permanent bar under the frame here, native
 * browser `controls` there, a permanent overlay in the editor — three chromes
 * for one job, and the permanent ones sat on top of burned-in captions.
 *
 * Playback state is read off the element's own events, so an outside caller
 * (line seeking, playhead sync) can drive the same `videoRef` freely.
 *
 * NOT used by TimelineEditor: that one swaps between two buffered `<video>`
 * elements per scene and owns its own transport for that reason.
 */

/** Arrow-key seek unit — one second is what a person means by "back a bit". */
const ARROW_STEP_SEC = 1

export interface VideoPlayerProps {
  src: string
  /** Remount key — bump to force a reload after a re-render writes the file. */
  mediaKey?: string | number
  /** Owned by the caller so it can seek/inspect; the player only reads events. */
  videoRef: React.RefObject<HTMLVideoElement | null>
  muted?: boolean
  /** Frame-box classes (size, rounding, background). */
  className?: string
  /** Inline styles on the frame box — the big-screen modal sizes itself from
   * the clip's real aspect ratio, which cannot be a static class. */
  style?: React.CSSProperties
  /** Big-screen button (top-right of the frame) that opens the same clip in
   * `VideoModal`. Off for the player INSIDE that modal — it is already big,
   * and a player that can open itself would recurse. */
  expandable?: boolean
  /** Title for the big-screen modal. */
  expandTitle?: string
  autoPlay?: boolean
  /** Seek here once metadata is in — used to continue where an inline player
   * left off when the big-screen modal opens. */
  startAtSec?: number
  /** Extra styles on the `<video>` itself — the zoom editor's live CSS crop. */
  videoStyle?: React.CSSProperties
  onLoadedMetadata?: (e: React.SyntheticEvent<HTMLVideoElement>) => void
  /** Playback reached the end. The playlist modal advances to the next clip;
   * without a handler the player just stops, as before. */
  onEnded?: () => void
  /** The source failed to load. A <video> whose file is missing stays a solid
   * box, so the surfaces that can outlive their files draw their own state. */
  onError?: () => void
  /** Overlays drawn above the video, below the transport (framing rect, …). */
  children?: React.ReactNode
  /** 'metadata' (default) is enough to show a poster frame + duration;
   * scrubbing surfaces (the zoom editor) pass 'auto' to buffer ahead. A
   * 90MB final_fx.mp4 preloaded on a detail page just burns I/O. */
  preload?: 'none' | 'metadata' | 'auto'
  onPointerMove?: (e: React.PointerEvent) => void
  onPointerUp?: (e: React.PointerEvent) => void
  onPointerCancel?: (e: React.PointerEvent) => void
}

export function VideoPlayer({
  src,
  mediaKey,
  videoRef,
  muted,
  className,
  style,
  videoStyle,
  expandable = true,
  expandTitle,
  autoPlay,
  startAtSec,
  onLoadedMetadata,
  onEnded,
  onError,
  children,
  preload = 'metadata',
  onPointerMove,
  onPointerUp,
  onPointerCancel
}: VideoPlayerProps): React.JSX.Element {
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)
  const [visible, setVisible] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  // While the head is held, the ELEMENT is not the source of truth: seeking a
  // large file lands late, so its `timeupdate` events still report the old
  // position and, on a controlled input, yank the head back under the pointer
  // (measured: a drag to 60% of a 48s clip ended at 2.8s — live 2026-08-13).
  const scrubbing = useRef(false)
  const resumeAfterScrub = useRef(false)
  // Big-screen modal. Owned here so every surface that shows a player gets the
  // button without wiring anything (project detail, voiceover, zoom editor).
  const [expanded, setExpanded] = useState(false)
  const [handoffSec, setHandoffSec] = useState(0)

  const show = (): void => {
    setVisible(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setVisible(false), 2000)
  }
  const hide = (): void => {
    window.clearTimeout(timer.current)
    setVisible(false)
  }
  useEffect(() => () => window.clearTimeout(timer.current), [])

  // Arrow keys seek, from anywhere on the page. Putting the handler on the seek
  // slider alone meant it only worked after clicking the slider — nobody does
  // that, so the keys read as dead. A window listener is what makes them behave
  // the way they do in every other player.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const dir = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
      if (!dir || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
      // Never steal the keys from something being typed in or from a caller
      // that already binds them (the timeline editor has its own).
      const el = e.target as HTMLElement | null
      const tag = el?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return
      const v = videoRef.current
      if (!v || !Number.isFinite(v.duration)) return
      e.preventDefault()
      const next = Math.min(v.duration, Math.max(0, v.currentTime + dir * ARROW_STEP_SEC))
      v.currentTime = next
      setCurrent(next)
      show()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // `show` is stable enough for this: it only touches refs and setState.
  }, [videoRef])

  // `timeupdate` fires ~4×/s, which is fine for a clock and visibly steppy for
  // a progress fill. While playing, follow the element per frame instead.
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = (): void => {
      const el = videoRef.current
      if (el && !scrubbing.current) {
        const at = el.currentTime
        setCurrent((prev) => (Math.abs(prev - at) < 0.02 ? prev : at))
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, videoRef])

  const toggle = (): void => {
    const el = videoRef.current
    if (!el) return
    if (el.paused) void el.play().catch(() => undefined)
    else el.pause()
  }

  return (
    <div
      onPointerEnter={show}
      onPointerMove={(e) => {
        show()
        onPointerMove?.(e)
      }}
      onPointerLeave={hide}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      className={cn('relative overflow-hidden bg-media', className)}
      style={style}
    >
      <video
        key={mediaKey}
        ref={videoRef}
        src={src}
        playsInline
        muted={muted}
        preload={preload}
        className="absolute inset-0 h-full w-full object-contain"
        style={videoStyle}
        onClick={toggle}
        onLoadedMetadata={(e) => {
          const el = e.currentTarget
          setDuration(el.duration || 0)
          if (startAtSec !== undefined && startAtSec > 0) {
            // Continue from where the caller was, instead of a poster frame.
            el.currentTime = Math.min(startAtSec, Math.max((el.duration || 0) - 0.05, 0))
          } else {
            // Paint a frame instead of a black box (see seekToPosterFrame).
            seekToPosterFrame(el)
          }
          setCurrent(el.currentTime)
          if (autoPlay) void el.play().catch(() => undefined)
          onLoadedMetadata?.(e)
        }}
        onTimeUpdate={(e) => {
          if (!scrubbing.current) setCurrent(e.currentTarget.currentTime)
        }}
        onError={() => onError?.()}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false)
          onEnded?.()
        }}
      />

      {children}

      {expandable ? (
        <button
          type="button"
          aria-label="เปิดจอใหญ่"
          title="เปิดจอใหญ่"
          onClick={() => {
            const el = videoRef.current
            setHandoffSec(el?.currentTime ?? 0)
            // The inline copy stops: two elements playing the same file is two
            // audio tracks a few frames apart.
            el?.pause()
            setExpanded(true)
          }}
          className={cn(
            'absolute right-2.5 top-2.5 z-20 flex h-8 w-8 items-center justify-center rounded-md bg-[rgb(23_22_20_/_0.62)] text-ink-2 transition-opacity duration-state ease-out hover:text-ink',
            visible ? 'opacity-100' : 'pointer-events-none opacity-0'
          )}
        >
          <Maximize2 size={15} />
        </button>
      ) : null}

      <VideoModal
        open={expanded}
        onClose={() => setExpanded(false)}
        src={src}
        mediaKey={mediaKey}
        muted={muted}
        title={expandTitle}
        startAtSec={handoffSec}
        onCloseAt={(sec) => {
          // Hand the position back so closing the big screen does not rewind.
          const el = videoRef.current
          if (el) {
            el.currentTime = sec
            setCurrent(sec)
          }
        }}
      />

      <VideoTransport
        visible={visible}
        playing={playing}
        currentSec={current}
        durationSec={duration}
        onTogglePlay={toggle}
        onSeek={(sec) => {
          const el = videoRef.current
          if (el) el.currentTime = sec
          setCurrent(sec)
        }}
        onScrubStart={() => {
          scrubbing.current = true
          const el = videoRef.current
          // Pause while dragging (same as the timeline editor): a playing
          // element keeps moving the head out from under the pointer.
          resumeAfterScrub.current = Boolean(el && !el.paused)
          el?.pause()
        }}
        onScrubEnd={() => {
          scrubbing.current = false
          if (resumeAfterScrub.current) void videoRef.current?.play().catch(() => undefined)
          resumeAfterScrub.current = false
        }}
      />
    </div>
  )
}
