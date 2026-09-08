import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { cn } from '../../lib/cn'
import { VideoPlayer } from './VideoPlayer'
import { useIsNarrow } from '../../lib/useMediaQuery'

/**
 * The app's big-screen player: one clip, as large as the window allows, in a
 * modal — deliberately NOT the OS fullscreen (that hides the app, takes over
 * the display and needs a second Esc to get out of). Escape, the × and a click
 * on the backdrop all close it.
 *
 * The frame follows the clip's own aspect ratio once metadata arrives; until
 * then it holds 9:16, which is what this app produces. Height is capped so the
 * title strip and the transport always have room.
 *
 * With a `playlist` the clips sit in a fixed-width rail down the RIGHT side
 * (R17c). The grid-under-the-video it replaced was sized for six highlights: a
 * real 17-highlight project turned it into six rows ~430px tall, taller than
 * the video itself, so the thing people opened the modal to watch got squeezed
 * into half the window. A vertical rail scrolls inside itself, so the video
 * keeps its full height whether there are 6 highlights or 60.
 */
export interface VideoModalProps {
  open: boolean
  onClose: () => void
  src: string
  /** Shown above the frame — the project/clip this is. */
  title?: string
  /** Remount key, same meaning as VideoPlayer's. */
  mediaKey?: string | number
  /** Carried over from the player that opened this. The voiceover stage mutes
   * its preview on purpose (you are recording over it) — expanding must not
   * un-mute it and play the old audio into the microphone. */
  muted?: boolean
  /** Where to start, so opening from an inline player continues where it was. */
  startAtSec?: number
  /** Pause here instead of playing to the end — for previewing one source
   * window of a longer file (R18b's shot-swap tray). The transport still
   * works; scrubbing past it just pauses again on the next tick. */
  stopAtSec?: number
  /** Position when the modal closes — lets the caller hand it back to the
   * inline player instead of restarting it. */
  onCloseAt?: (sec: number) => void
  /** Optional set of clips to move between. Absent (every mode but
   * speech_highlights) the modal behaves exactly as it always did — there is
   * no second component for this. */
  playlist?: {
    id: string
    label: string
    durationSec: number
    /** What the highlight is about, from `highlights/index.json` (the AI wrote
     * it during selection). "7 · 0:45" tells nobody which one to open, so the
     * row shows this when it exists — and just the number and length when it
     * does not, never an empty line. */
    title?: string
  }[]
  /** Which entry `src` currently shows. */
  index?: number
  onIndexChange?: (i: number) => void
}

/** Rail geometry (R17c). Fixed width so the video's size never depends on how
 * many highlights there are; ROW_H doubles as the scroll arithmetic below. */
const RAIL_W = 320
const ROW_H = 52
/** How tall the rail is when it sits UNDER the video instead of beside it. */
const RAIL_STRIP_H = 168

function clockOf(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function VideoModal({
  open,
  onClose,
  src,
  title,
  mediaKey,
  muted,
  startAtSec,
  stopAtSec,
  onCloseAt,
  playlist,
  index = 0,
  onIndexChange
}: VideoModalProps): React.JSX.Element | null {
  // Below `lg` the playlist is a strip under the video, not a column beside
  // it — see the geometry below.
  const narrow = useIsNarrow()
  const hasList = !!playlist && playlist.length > 1
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const railRef = useRef<HTMLDivElement | null>(null)
  // Keyed by `open` so the ratio starts unknown for each clip without a
  // setState in an effect: a stale ratio would letterbox the wrong shape for a
  // frame. Deliberately NOT re-keyed per playlist index — every highlight in a
  // project comes off the same source and shares the shape, so holding the last
  // measured value avoids a frame of 9:16 letterboxing on every clip change.
  // It is still re-measured from whichever clip is actually playing (R17c.4).
  const [ratio, setRatio] = useState<{ key: boolean; value: number } | null>(null)

  /** Close, handing the caller the position the clip is actually at. Not a ref
   * assignment during render — the listener below is re-registered whenever
   * the callbacks change, which is what keeps it current. */
  const closeWithPosition = useCallback(() => {
    const at = videoRef.current?.currentTime
    if (at !== undefined) onCloseAt?.(at)
    onClose()
  }, [onClose, onCloseAt])

  useEffect(() => {
    if (!open) return
    /**
     * The modal owns the keyboard while it is up.
     *
     * Swallowing only Escape was not enough: the screens this opens over have
     * global shortcuts on the same keys — Space records another voiceover take,
     * Delete removes the selected zoom block — and they fired at the hidden
     * screen behind the picture. There is no text input in here, so taking the
     * whole keyboard is safe, and Space is wired to the obvious thing instead.
     */
    const onKeyDown = (e: KeyboardEvent): void => {
      e.stopPropagation()
      if (e.key === 'Escape') {
        closeWithPosition()
        return
      }
      if (e.code === 'Space') {
        e.preventDefault()
        const el = videoRef.current
        if (!el) return
        if (el.paused) void el.play().catch(() => undefined)
        else el.pause()
        return
      }
      // Added to the existing handler rather than a second listener: this one
      // is registered in capture and stops propagation, so a listener anywhere
      // else would only ever see the keys it chose to let through.
      if (playlist && onIndexChange && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault()
        const next = index + (e.key === 'ArrowRight' ? 1 : -1)
        if (next >= 0 && next < playlist.length) onIndexChange(next)
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [open, closeWithPosition, playlist, index, onIndexChange])

  // Window preview: pause at the window's end rather than playing on into
  // footage that isn't part of the shot being judged.
  useEffect(() => {
    if (!open || stopAtSec == null) return
    const el = videoRef.current
    if (!el) return
    const onTime = (): void => {
      if (el.currentTime >= stopAtSec) el.pause()
    }
    el.addEventListener('timeupdate', onTime)
    return () => el.removeEventListener('timeupdate', onTime)
  }, [open, stopAtSec, src, mediaKey])

  // Keep the playing row in view when the index moves on its own (a clip ended,
  // or an arrow key). Sets the rail's own scrollTop rather than calling
  // scrollIntoView, which also scrolls the page behind the modal (R17c).
  useEffect(() => {
    if (!open || !hasList) return
    const rail = railRef.current
    if (!rail) return
    const top = index * ROW_H
    if (top < rail.scrollTop) rail.scrollTop = top
    else if (top + ROW_H > rail.scrollTop + rail.clientHeight) {
      rail.scrollTop = top + ROW_H - rail.clientHeight
    }
  }, [open, hasList, index])

  if (!open) return null
  const aspect = ratio && ratio.key === open ? ratio.value : 9 / 16

  // Both dimensions are stated outright rather than leaving one to
  // aspect-ratio: the rail is a flex sibling, and a 17-row rail is taller than
  // a landscape clip, so `items-stretch` grew the video box past its own ratio
  // and letterboxed it top and bottom. Giving the rail the video's exact height
  // makes the video the authority again.
  //
  // The free width is the window minus the rail and the backdrop padding; the
  // free height is the R9 figure. Whichever runs out first decides the size.
  // Below `lg` the rail moves UNDER the video, so it must not be subtracted
  // from the width: reserving 320px at 390 left the clip 20px wide — a 9:16
  // video rendered as a vertical thread beside its own playlist.
  const railBeside = hasList && !narrow
  const pad = narrow ? 26 : 50
  const chrome = narrow ? 100 + RAIL_STRIP_H : 100
  const freeW = `calc(100vw - ${(railBeside ? RAIL_W : 0) + pad}px)`
  const videoW = `min(calc((100dvh - ${chrome}px) * ${aspect}), ${freeW})`
  const videoH = `min(calc(100dvh - ${chrome}px), calc(${freeW} / ${aspect}))`

  return createPortal(
    // Backdrop at 90% (R9): the cards behind used to read through the old 72%
    // and competed with the clip.
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-[rgb(9_8_7_/_0.9)] p-3 sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeWithPosition()
      }}
    >
      {/* One box, not a floating video with the name in one window corner and
          the close button in another (R9). Width comes from the clip's own
          ratio — the header follows whatever the video is. */}
      <div className="flex max-h-full max-w-full flex-col overflow-hidden rounded-[6px] border border-[rgb(243_242_242_/_0.16)] bg-surface shadow-[0_30px_70px_rgb(0_0_0_/_0.6)]">
        <div className="flex h-[46px] shrink-0 items-center gap-2.5 border-b border-[rgb(243_242_242_/_0.1)] pr-1.5 pl-4">
          <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">
            {hasList && playlist ? `${title} — ไฮไลต์ ${index + 1} จาก ${playlist.length}` : title}
          </span>
          <button
            type="button"
            aria-label="ปิด"
            title="ปิด (Esc)"
            onClick={closeWithPosition}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors duration-state ease-out hover:bg-[rgb(243_242_242_/_0.08)] hover:text-ink"
          >
            <X size={17} />
          </button>
        </div>

        {/* Video and rail sit side by side, so the rail's length never costs
            the video any height. 100px = the 26px above the box + its 46px
            header + 28px below it, measured off the R9 frame at 1280×800 —
            the same figure with or without a playlist now (R17c.2). */}
        <div className="flex min-h-0 flex-col items-stretch lg:flex-row">
          <VideoPlayer
            mediaKey={mediaKey}
            videoRef={videoRef}
            src={src}
            muted={muted}
            preload="auto"
            expandable={false}
            autoPlay
            startAtSec={startAtSec}
            onLoadedMetadata={(e) => {
              const el = e.currentTarget
              if (el.videoWidth && el.videoHeight)
                setRatio({ key: open, value: el.videoWidth / el.videoHeight })
            }}
            onEnded={
              playlist && onIndexChange && index + 1 < playlist.length
                ? () => onIndexChange(index + 1)
                : undefined
            }
            className="min-h-0 shrink-0"
            style={{ width: videoW, height: videoH }}
          />

          {hasList && playlist ? (
            <div
              className="flex min-h-0 shrink-0 flex-col border-t border-[rgb(243_242_242_/_0.1)] lg:border-l lg:border-t-0"
              style={
                narrow ? { width: '100%', height: RAIL_STRIP_H } : { width: RAIL_W, height: videoH }
              }
            >
              <div className="flex h-[42px] shrink-0 items-center justify-between border-b border-[rgb(243_242_242_/_0.1)] px-4">
                <span className="text-[13.5px] text-ink-2">ไฮไลต์ทั้งหมด</span>
                <span className="text-[12.5px] text-muted">เรียงตามเวลาต้นฉบับ</span>
              </div>

              <div ref={railRef} className="scroll-ghost min-h-0 flex-1 overflow-y-auto">
                {playlist.map((clip, i) => {
                  const current = i === index
                  return (
                    <button
                      key={clip.id}
                      type="button"
                      onClick={() => onIndexChange?.(i)}
                      style={{ height: ROW_H }}
                      className={cn(
                        'flex w-full items-center gap-[11px] border-l-2 px-[13px] text-left transition-colors duration-state ease-out',
                        i > 0 && 'border-t border-t-[rgb(243_242_242_/_0.07)]',
                        current
                          ? 'border-l-accent bg-accent-tint'
                          : 'border-l-transparent hover:bg-[rgb(243_242_242_/_0.05)]'
                      )}
                    >
                      <span
                        className={cn(
                          'w-5 shrink-0 text-[13.5px] tabular-nums',
                          current ? 'font-semibold text-accent' : 'text-muted'
                        )}
                      >
                        {clip.label}
                      </span>
                      {/* No title (an older index.json) → the row is just the
                          number and the length, never a blank line. */}
                      {clip.title ? (
                        <span
                          className={cn(
                            'min-w-0 flex-1 truncate text-sm',
                            current ? 'text-ink' : 'text-ink-2'
                          )}
                        >
                          {clip.title}
                        </span>
                      ) : (
                        <span className="min-w-0 flex-1" />
                      )}
                      <span
                        className={cn(
                          'shrink-0 text-[13px] tabular-nums',
                          current ? 'text-accent' : 'text-muted'
                        )}
                      >
                        {clockOf(clip.durationSec)}
                      </span>
                    </button>
                  )
                })}
              </div>

              {/* Arrows for anyone not using ←/→. Disabled at the ends: the
                  last clip stops rather than looping back to the first. */}
              <div className="flex h-[44px] shrink-0 items-center justify-between border-t border-[rgb(243_242_242_/_0.1)] px-4">
                <span className="text-[12.5px] text-muted">เล่นจบไปอันถัดไปเอง</span>
                <span className="flex gap-1.5">
                  {([-1, 1] as const).map((step) => {
                    const target = index + step
                    const enabled = target >= 0 && target < playlist.length
                    return (
                      <button
                        key={step}
                        type="button"
                        aria-label={step === -1 ? 'ไฮไลต์ก่อนหน้า' : 'ไฮไลต์ถัดไป'}
                        disabled={!enabled}
                        onClick={() => onIndexChange?.(target)}
                        className={cn(
                          'flex h-7 w-7 items-center justify-center rounded-[5px] border border-border-faint transition-colors duration-state ease-out',
                          enabled
                            ? 'text-ink-2 hover:bg-[rgb(243_242_242_/_0.06)]'
                            : 'cursor-not-allowed text-[rgb(243_242_242_/_0.25)]'
                        )}
                      >
                        {step === -1 ? <ChevronLeft size={13} /> : <ChevronRight size={13} />}
                      </button>
                    )
                  })}
                </span>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>,
    document.body
  )
}
