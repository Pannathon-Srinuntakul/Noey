/**
 * R18b v2 ปรับช็อต — one question per screen.
 *
 * Replaces ShotSwapModal (v1), which was rejected in review: a 9-shot
 * storyboard of 82px thumbs plus a side tray meant you had to decode the whole
 * cut's structure before answering a single question. This screen does one
 * thing — put 2-4 equally sized frames side by side and ask which one — and it
 * only asks about shots that actually have an alternative, so a 9-shot project
 * with 3 alternatives is 3 questions, not 9.
 *
 * Nothing behind the screen changed: the same `alternates` schema, the same
 * length regimes, and the same `applyShotSwap()` render path, which is still
 * zero AI calls per round.
 *
 * The shell is built here rather than with <Dialog> because the design's 52px
 * header carries progress ticks and a counter, where Dialog's is a 2xl title
 * block — the panel styling below is copied from it so the two still match.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Film, Play, X } from 'lucide-react'
import type { LocalClip } from '@renderer/platform/types'
import { cn } from '../../lib/cn'
import { useConfirm } from '../../lib/confirm'
import type { ProjectPipeline } from '../../lib/useProjectPipeline'
import type { DubEditScript } from '../../lib/videosLocalApi'
import {
  applySwapsToScript,
  sameWindow,
  segmentAlternates,
  segmentWindow,
  swapRegimeFor,
  windowFitsLocked,
  type ShotSwapLogEntry,
  type ShotWindow,
  type SwapChoice
} from '../../lib/shotSwap'
import { Button } from '../ui/Button'

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Tallest a frame ever gets; below that it shrinks with the window so the row
 * never scrolls — comparing is the whole job, every option must be on screen. */
const FRAME_MAX_H = 470
/** Capture height for the stills. Comfortably above FRAME_MAX_H so a HiDPI
 * screen still gets real pixels rather than an upscale. */
const THUMB_H = 960

// ── thumbnails ──────────────────────────────────────────────────────────────
// One hidden <video> seeked request by request (a video element serves one seek
// at a time). Module-level cache so re-opening never re-decodes. No ffmpeg.

const thumbKey = (uid: string, clip: string, t: number): string => `${uid}|${clip}|${t.toFixed(1)}`
const thumbCache = new Map<string, string>()

interface ThumbWant {
  clip: string
  time: number
}

function useShotThumbs(uid: string, clips: LocalClip[], wants: ThumbWant[]): Map<string, string> {
  const [, bump] = useState(0)
  const wantsSig = wants.map((w) => thumbKey(uid, w.clip, w.time)).join(',')

  useEffect(() => {
    const missing = wants.filter((w) => !thumbCache.has(thumbKey(uid, w.clip, w.time)))
    if (missing.length === 0) return
    let cancelled = false
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'auto'
    video.crossOrigin = 'anonymous'
    const canvas = document.createElement('canvas')

    const seekTo = (sec: number): Promise<void> =>
      new Promise((resolve) => {
        const done = (): void => {
          video.removeEventListener('seeked', done)
          resolve()
        }
        video.addEventListener('seeked', done)
        video.currentTime = sec
      })

    const run = async (): Promise<void> => {
      const byClip = new Map<string, number[]>()
      for (const w of missing) {
        const arr = byClip.get(w.clip) ?? []
        arr.push(w.time)
        byClip.set(w.clip, arr)
      }
      for (const [clipId, times] of byClip) {
        const clip = clips.find((c) => c.id === clipId)
        if (!clip) continue
        video.src = window.noey.media.urlFor(uid, clip.file)
        await new Promise<void>((resolve, reject) => {
          video.addEventListener('loadeddata', () => resolve(), { once: true })
          video.addEventListener('error', () => reject(new Error('thumb load failed')), {
            once: true
          })
        })
        if (cancelled) return
        const ratio = (video.videoWidth || 9) / (video.videoHeight || 16)
        // Captured well above the 470px the frame is drawn at, and above that
        // again for HiDPI: grabbing at display size produced a visibly soft
        // picture, and the whole point of the screen is judging image quality.
        canvas.height = THUMB_H
        canvas.width = Math.max(1, Math.round(THUMB_H * ratio))
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        for (const t of times) {
          if (cancelled) return
          await seekTo(Math.max(0, Math.min(t, (video.duration || t + 1) - 0.05)))
          if (cancelled) return
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
          try {
            thumbCache.set(thumbKey(uid, clipId, t), canvas.toDataURL('image/jpeg', 0.72))
          } catch {
            /* tainted canvas — the card shows its film icon instead */
          }
          bump((n) => n + 1)
        }
      }
    }
    void run().catch(() => undefined)
    return () => {
      cancelled = true
      video.removeAttribute('src')
      video.load()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, wantsSig])

  const out = new Map<string, string>()
  for (const w of wants) {
    const hit = thumbCache.get(thumbKey(uid, w.clip, w.time))
    if (hit) out.set(thumbKey(uid, w.clip, w.time), hit)
  }
  return out
}

/** One option's picture: a still until played, the looping window while playing. */
function OptionFrame({
  uid,
  clips,
  win,
  thumb,
  playing,
  onTogglePlay
}: {
  uid: string
  clips: LocalClip[]
  win: ShotWindow
  thumb: string | undefined
  playing: boolean
  onTogglePlay: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLVideoElement | null>(null)
  const clip = clips.find((c) => c.id === win.sourceClip)

  useEffect(() => {
    const v = ref.current
    if (!playing || !v) return
    v.currentTime = win.sourceIn
    void v.play().catch(() => undefined)
  }, [playing, win.sourceClip, win.sourceIn])

  return (
    <>
      {playing && clip ? (
        <video
          ref={ref}
          muted
          playsInline
          src={window.noey.media.urlFor(uid, clip.file)}
          className="h-full w-full object-cover"
          onTimeUpdate={(e) => {
            // Loop the window rather than running on into the next shot.
            if (e.currentTarget.currentTime >= win.sourceOut) {
              e.currentTarget.currentTime = win.sourceIn
            }
          }}
        />
      ) : thumb ? (
        <img src={thumb} alt="" className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <Film size={20} className="text-muted" />
        </div>
      )}

      <button
        type="button"
        aria-label={playing ? 'หยุด' : 'เล่นดูก่อน'}
        onClick={(e) => {
          e.stopPropagation()
          onTogglePlay()
        }}
        className={cn(
          'absolute left-1/2 top-1/2 flex h-[52px] w-[52px] -translate-x-1/2 -translate-y-1/2',
          'items-center justify-center rounded-full border text-ink transition-colors duration-state ease-out',
          // A dark disc behind it: the outline-only version vanished against a
          // bright frame, which is most of this footage.
          'border-[rgb(243_242_242_/_0.34)] bg-[rgb(23_22_20_/_0.55)] backdrop-blur-[2px]',
          'hover:border-[rgb(243_242_242_/_0.6)] hover:bg-[rgb(23_22_20_/_0.72)]'
        )}
      >
        {playing ? (
          <span className="flex gap-[3px]">
            <span className="h-3.5 w-[3px] rounded-sm bg-current" />
            <span className="h-3.5 w-[3px] rounded-sm bg-current" />
          </span>
        ) : (
          <Play size={16} className="ml-[2px] fill-current" />
        )}
      </button>
    </>
  )
}

interface Option {
  /** null = the shot the AI chose (or whatever is current); else the alternate. */
  altIndex: number | null
  window: ShotWindow
  label: string
  note: string
  /** Locked regime only: too short to carry the shot's recorded length. */
  disabledReason: string | null
}

export function ShotSwapReview({
  job,
  onClose
}: {
  job: ProjectPipeline
  onClose: () => void
}): React.JSX.Element | null {
  const confirm = useConfirm()
  const project = job.project
  const script = useMemo<DubEditScript>(
    () =>
      ((project.editScript as unknown as DubEditScript | undefined) ??
        job.editScript ?? { segments: [] }) as DubEditScript,
    [project.editScript, job.editScript]
  )
  const segments = useMemo(() => script.segments ?? [], [script])
  const regime = swapRegimeFor(job.mode, project.voiceoverPath)

  /** Only shots that pose a question. No alternatives = no decision = not in
   * the queue; v1 walked you to those anyway and showed an empty-state box. */
  const queue = useMemo(
    () => segments.map((_, i) => i).filter((i) => segmentAlternates(segments[i]).length > 0),
    [segments]
  )

  const [cursor, setCursor] = useState(0)
  /** segIndex → chosen alternate, or null for "keep the AI's". */
  const [picks, setPicks] = useState<ReadonlyMap<number, number>>(new Map())
  const [playing, setPlaying] = useState<number | null>(null)
  const [browsing, setBrowsing] = useState(false)
  /** Set when the strip jumps to a shot that has nothing to choose between. */
  const [noOptionShot, setNoOptionShot] = useState<number | null>(null)

  const panelRef = useRef<HTMLDivElement>(null)
  const segIndex = noOptionShot ?? queue[cursor]
  const seg = segments[segIndex] as Record<string, unknown> | undefined
  const alternates = seg ? segmentAlternates(seg) : []
  const durationOf = (s: Record<string, unknown>): number =>
    num(s.durationSec) || Math.max(0, num(s.sourceOut) - num(s.sourceIn))

  const options: Option[] = useMemo(() => {
    if (!seg || noOptionShot !== null) return []
    const dur = durationOf(seg)
    const current = segmentWindow(seg)
    const head: Option = {
      altIndex: null,
      window: current,
      label: 'AI เลือกไว้',
      note: String(seg.visualDescription ?? ''),
      disabledReason: null
    }
    const rest = alternates.map((a, i) => ({
      altIndex: i,
      window: a as ShotWindow,
      label: 'อีกมุมหนึ่ง',
      note: a.note,
      disabledReason:
        regime === 'locked' && !windowFitsLocked(a, dur)
          ? 'ช่วงนี้สั้นกว่าช็อตเดิม ใช้ได้ก่อนอัดเสียงพากย์เท่านั้น'
          : null
    }))
    return [head, ...rest]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seg, segIndex, noOptionShot, regime])

  // Thumbs for what is on screen plus the next question — one step of prefetch,
  // not the whole cut.
  const wants = useMemo<ThumbWant[]>(() => {
    const list: ThumbWant[] = []
    const push = (w: ShotWindow): void => {
      list.push({ clip: w.sourceClip, time: w.matchedFrameTime || w.sourceIn })
    }
    for (const o of options) push(o.window)
    const nextSeg = segments[queue[cursor + 1]] as Record<string, unknown> | undefined
    if (nextSeg) {
      push(segmentWindow(nextSeg))
      for (const a of segmentAlternates(nextSeg)) push(a as ShotWindow)
    }
    // The strip shows every shot once opened.
    if (browsing) for (const s of segments) push(segmentWindow(s as Record<string, unknown>))
    if (noOptionShot !== null && segments[noOptionShot]) {
      push(segmentWindow(segments[noOptionShot] as Record<string, unknown>))
    }
    return list
  }, [options, segments, queue, cursor, browsing, noOptionShot])
  const thumbs = useShotThumbs(project.uid, project.clips, wants)
  const thumbFor = (w: ShotWindow): string | undefined =>
    thumbs.get(thumbKey(project.uid, w.sourceClip, w.matchedFrameTime || w.sourceIn))

  // ── choices ───────────────────────────────────────────────────────────────
  const pending = useMemo(() => {
    const list: SwapChoice[] = []
    for (const [idx, altIndex] of picks) {
      const s = segments[idx] as Record<string, unknown> | undefined
      if (!s) continue
      const alt = segmentAlternates(s)[altIndex]
      if (alt) list.push({ segIndex: idx, window: alt as ShotWindow })
    }
    return applySwapsToScript(script, list, regime)
  }, [picks, script, segments, regime])
  const diffCount = pending.applied.length

  const choose = (opt: Option): void => {
    if (opt.disabledReason || segIndex === undefined) return
    setPlaying(null)
    setPicks((prev) => {
      const next = new Map(prev)
      if (opt.altIndex === null) next.delete(segIndex)
      else next.set(segIndex, opt.altIndex)
      return next
    })
  }

  const isChosen = (opt: Option): boolean => {
    const picked = segIndex === undefined ? undefined : picks.get(segIndex)
    return opt.altIndex === null ? picked === undefined : picked === opt.altIndex
  }

  const last = cursor >= queue.length - 1
  const goTo = (next: number): void => {
    setNoOptionShot(null)
    setPlaying(null)
    setCursor(Math.max(0, Math.min(queue.length - 1, next)))
  }

  const requestClose = useCallback((): void => {
    if (diffCount === 0) {
      onClose()
      return
    }
    void confirm({
      title: 'ทิ้งช็อตที่เลือกไว้?',
      body: `เลือกไว้ ${diffCount} ช็อต แต่ยังไม่ได้ทำคลิปใหม่ — ปิดตอนนี้การเลือกจะหายทั้งหมด`,
      confirmLabel: 'ทิ้งแล้วปิด',
      cancelLabel: 'เลือกต่อ',
      destructive: true
    }).then((ok) => {
      if (ok) onClose()
    })
  }, [confirm, diffCount, onClose])

  const apply = (): void => {
    if (diffCount === 0) return
    const log: ShotSwapLogEntry[] = pending.applied.map((c) => {
      const original = segments[c.segIndex] as Record<string, unknown>
      const match = segmentAlternates(original).find((a) => sameWindow(a, c.window))
      return {
        line: num(original.voiceoverLineId ?? original.order),
        from: {
          frame: num(original.matchedFrameTime),
          desc: String(original.visualDescription ?? '')
        },
        to: { frame: c.window.matchedFrameTime, note: match?.note ?? '' }
      }
    })
    onClose()
    void job.applyShotSwap(pending.script, log)
  }

  // Keyboard: appended to the panel-level listener the modal owns, so nothing
  // reaches the screen behind it (R17b.3).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      e.stopPropagation()
      if (e.key === 'Escape') {
        requestClose()
        return
      }
      if (e.code === 'Space') {
        e.preventDefault()
        const picked = options.findIndex((o) => isChosen(o))
        setPlaying((p) => (p === null ? Math.max(0, picked) : null))
        return
      }
      if (e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault()
        if (!last) goTo(cursor + 1)
        return
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        goTo(cursor - 1)
        return
      }
      const n = Number(e.key)
      if (n >= 1 && n <= 4 && options[n - 1]) choose(options[n - 1])
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options, cursor, last, queue.length, requestClose, segIndex, picks])

  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  if (queue.length === 0) return null

  const lineText = seg ? String(seg.voiceoverScript ?? '').trim() : ''
  const regimeNote =
    regime === 'locked'
      ? 'ความยาวช็อตเท่าเดิม เสียงพากย์ไม่เคลื่อน'
      : 'ความยาวจะเปลี่ยนตามช็อตที่เลือก'

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[rgb(23_22_20_/_0.72)]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="ปรับช็อต"
        tabIndex={-1}
        style={{ width: 'min(1280px, 100vw - 64px)', height: 'calc(100vh - 64px)' }}
        className="noey-dialog-enter flex flex-col overflow-hidden rounded-md border border-[rgb(243_242_242_/_0.16)] bg-surface shadow-modal outline-none"
      >
        {/* ── header ── */}
        <div className="flex h-[52px] shrink-0 items-center gap-3.5 border-b border-divider pl-[22px] pr-2.5">
          <span className="text-[15px] font-semibold text-ink">ปรับช็อต</span>
          <span className="min-w-0 truncate text-[13.5px] text-muted">{project.name}</span>
          <span className="flex-1" />
          <span className="flex items-center gap-[7px]">
            {queue.map((qi, i) => (
              <span
                key={qi}
                className={cn(
                  'h-1 w-[22px] rounded-sm',
                  i <= cursor && noOptionShot === null ? 'bg-accent' : 'bg-[rgb(243_242_242_/_0.2)]'
                )}
              />
            ))}
            <span className="ml-[5px] text-[13.5px] tabular-nums text-muted">
              {Math.min(cursor + 1, queue.length)} / {queue.length}
            </span>
          </span>
          <button
            type="button"
            aria-label="ปิด"
            onClick={requestClose}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-muted hover:bg-[rgb(243_242_242_/_0.06)] hover:text-ink"
          >
            <X size={17} />
          </button>
        </div>

        {/* ── question ── never scrolls: every option has to be visible at once */}
        <div className="flex min-h-0 flex-1 flex-col items-center overflow-hidden px-6 pt-[26px]">
          {noOptionShot !== null && seg ? (
            <>
              <p className="text-[22px] font-semibold text-ink">ช็อตนี้ AI ไม่มีตัวเลือกอื่นให้</p>
              <p className="mt-[7px] text-sm text-muted">
                ถ้าไม่ชอบช็อตนี้ ลองสั่งตัดใหม่พร้อมบอกเหตุผล หรือแก้เองในตัวแก้ไขวิดีโอ
              </p>
              <div className="mt-[22px] flex min-h-0 flex-1 items-stretch justify-center">
                <div
                  className="relative aspect-[9/16] overflow-hidden rounded-[5px] border border-border-faint bg-media"
                  style={{ maxHeight: FRAME_MAX_H, height: '100%' }}
                >
                  {thumbFor(segmentWindow(seg)) ? (
                    <img
                      src={thumbFor(segmentWindow(seg))}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ) : null}
                </div>
              </div>
            </>
          ) : (
            <>
              <p className="text-[22px] font-semibold text-ink">ช็อตนี้เอาอันไหน</p>
              <p className="mt-[7px] text-sm text-muted">
                {lineText ? (
                  <>
                    ตอนที่พูดว่า <span className="text-ink-2">&ldquo;{lineText}&rdquo;</span>
                  </>
                ) : (
                  'เลือกภาพที่อยากให้อยู่ในคลิป'
                )}
              </p>

              {/* A swipeable strip below `sm`: four 9:16 cards in a
                  non-wrapping centred row came out ~54px wide each at 390 —
                  vertical slivers of the shots you are choosing between. */}
              <div className="mt-[22px] flex min-h-0 flex-1 items-stretch gap-3 overflow-x-auto pb-1 sm:justify-center sm:gap-5 sm:overflow-visible">
                {options.map((opt, i) => {
                  const chosen = isChosen(opt)
                  const replaced = !chosen && opt.altIndex === null && diffCountFor(picks, segIndex)
                  return (
                    <div
                      key={i}
                      className="flex min-h-0 w-[46vw] max-w-[210px] shrink-0 flex-col sm:w-auto sm:max-w-none sm:flex-1 sm:shrink"
                    >
                      {/* A div, not a <button>: the play control sits on top of
                          the picture, and a button inside a button is invalid
                          HTML — the browser swallowed the inner one, so the
                          play press only ever selected the card and the frames
                          could never be played. */}
                      <div
                        role="button"
                        tabIndex={opt.disabledReason ? -1 : 0}
                        aria-disabled={!!opt.disabledReason}
                        aria-pressed={chosen}
                        onClick={() => choose(opt)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            choose(opt)
                          }
                        }}
                        style={{ maxHeight: FRAME_MAX_H }}
                        className={cn(
                          'relative aspect-[9/16] min-h-0 flex-1 overflow-hidden rounded-[5px] bg-media outline-none transition-colors duration-state ease-out',
                          // One accent border, never a border plus a ring —
                          // stacked rings read as two overlapping edges.
                          chosen
                            ? 'border-2 border-accent'
                            : 'border border-[rgb(243_242_242_/_0.18)] hover:border-[rgb(243_242_242_/_0.4)] focus-visible:border-accent',
                          opt.disabledReason ? 'cursor-not-allowed opacity-45' : 'cursor-pointer',
                          replaced && 'opacity-50'
                        )}
                      >
                        <OptionFrame
                          uid={project.uid}
                          clips={project.clips}
                          win={opt.window}
                          thumb={thumbFor(opt.window)}
                          playing={playing === i}
                          onTogglePlay={() => setPlaying((p) => (p === i ? null : i))}
                        />
                        {chosen ? (
                          <span className="pointer-events-none absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-[rgb(23_22_20_/_0.82)] py-[5px] pl-2 pr-3 text-[13px] font-semibold text-accent">
                            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-accent text-[11px] text-[#171614]">
                              ✓
                            </span>
                            {opt.altIndex === null ? 'ใช้อยู่' : 'เลือกอันนี้'}
                          </span>
                        ) : null}
                      </div>
                      <p
                        className={cn(
                          'mt-[11px] text-center text-[15px]',
                          chosen || !replaced ? 'text-ink-2' : 'text-muted'
                        )}
                      >
                        {opt.label}
                      </p>
                      <p className="mt-[3px] truncate text-center text-[13.5px] text-muted">
                        {opt.disabledReason ?? opt.note}
                      </p>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>

        {/* ── browse strip (second layer) ── */}
        {browsing ? (
          <div className="shrink-0 border-t border-divider px-6 py-3">
            <div className="flex flex-wrap gap-[5px]">
              {segments.map((s, i) => {
                const w = segmentWindow(s as Record<string, unknown>)
                const hasAlts = segmentAlternates(s as Record<string, unknown>).length > 0
                const current = i === segIndex
                return (
                  <button
                    key={i}
                    type="button"
                    aria-label={`ช็อตที่ ${i + 1}`}
                    onClick={() => {
                      setPlaying(null)
                      const q = queue.indexOf(i)
                      if (q >= 0) {
                        setNoOptionShot(null)
                        setCursor(q)
                      } else setNoOptionShot(i)
                    }}
                    className={cn(
                      'relative h-[54px] w-[30px] overflow-hidden rounded-[3px] bg-media outline-none',
                      current
                        ? 'border-2 border-accent'
                        : 'border border-[rgb(243_242_242_/_0.1)] focus-visible:border-accent'
                    )}
                  >
                    {thumbFor(w) ? (
                      <img src={thumbFor(w)} alt="" className="h-full w-full object-cover" />
                    ) : null}
                    {hasAlts ? (
                      <span className="absolute bottom-1 left-1/2 h-[5px] w-[5px] -translate-x-1/2 rounded-full bg-accent" />
                    ) : null}
                  </button>
                )
              })}
            </div>
          </div>
        ) : null}

        {/* ── footer ── one commit button, one place, label follows state ── */}
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-x-4 gap-y-3 px-6 pb-[22px] pt-5">
          <span className="w-full min-w-0 text-[13.5px] text-muted sm:w-auto sm:flex-1">
            {diffCount > 0 ? (
              <>
                <span className="text-ink-2">เปลี่ยนแล้ว {diffCount} ช็อต</span> · {regimeNote} ·
                ของเดิมย้อนกลับได้เสมอ
              </>
            ) : (
              'แตะภาพเพื่อเลือก · กดปุ่มเล่นเพื่อดูก่อน'
            )}
          </span>
          <button
            type="button"
            onClick={() => setBrowsing((b) => !b)}
            className="shrink-0 text-[13.5px] text-ink-2 underline underline-offset-2 hover:text-ink"
          >
            {browsing ? 'ซ่อนรายการช็อต' : `ไล่ดูทั้ง ${segments.length} ช็อต`}
          </button>
          <span className="flex-1" />
          {last && diffCount > 0 ? (
            <Button variant="secondary" onClick={() => setPicks(new Map())}>
              ย้อนกลับ
            </Button>
          ) : !last ? (
            <Button variant="ghost" onClick={() => goTo(cursor + 1)}>
              ใช้ของ AI ต่อ
            </Button>
          ) : null}
          {!last ? (
            <Button variant="secondary" onClick={() => goTo(cursor + 1)}>
              ถัดไป
            </Button>
          ) : diffCount > 0 ? (
            <Button variant="primary" onClick={apply}>
              ทำคลิปใหม่
            </Button>
          ) : (
            <Button variant="secondary" onClick={onClose}>
              เสร็จแล้ว
            </Button>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

/** True when this shot currently sits on an alternate, so the AI's own frame
 * should read as the replaced one. */
function diffCountFor(picks: ReadonlyMap<number, number>, segIndex: number | undefined): boolean {
  return segIndex !== undefined && picks.has(segIndex)
}
