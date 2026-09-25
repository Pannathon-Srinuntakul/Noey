/**
 * R18b v2 ปรับช็อต — one question per screen.
 *
 * Replaces ShotSwapModal (v1), which was rejected in review: a 9-shot
 * storyboard of 82px thumbs plus a side tray meant you had to decode the whole
 * cut's structure before answering a single question. This screen does one
 * thing — put 2-4 equally sized frames side by side and ask which one.
 *
 * It walks EVERY shot of the cut, including the ones the AI returned no backup
 * for. It used to skip those, so a 13-shot cut read "1 / 10" and shot 7 was
 * really shot 9 — the counter described a queue nobody can see instead of the
 * video the user made, and there was no way to tell where in their own edit a
 * question sat (owner, 2026-09-26). A shot with nothing to choose between still
 * shows its frame and says so plainly.
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
import { Film, X } from 'lucide-react'
import type { LocalClip } from '@renderer/platform/types'
import { cn } from '../../lib/cn'
import { useConfirm } from '../../lib/confirm'
import { useRouter } from '../../lib/router'
import type { ProjectPipeline } from '../../lib/useProjectPipeline'
import type { DubEditScript, DubTimeline } from '../../lib/videosLocalApi'
import {
  applySwapsToScript,
  hasSwapOptions,
  retimeTimelineForSwap,
  sameWindow,
  segmentSwappedFrom,
  segmentWindow,
  swapCandidates,
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
/** Smallest a frame may shrink to before the body is allowed to scroll instead:
 * under this the shots are too small to judge, which is the only reason to be
 * on this screen. */
const FRAME_MIN_H = 200
/** The two centred caption lines under every frame (label + note), plus the
 * row's own bottom padding. Constant by construction: both are single lines,
 * and it is subtracted for a shot with no options too, so the frame does not
 * change size as you step between shots that have backups and shots that do
 * not. */
const LABEL_BLOCK_H = 62
/** pt-[26px] on the body plus the mt-[22px] above the row. */
const BODY_PAD_H = 26 + 22
/** px-6 on the body. */
const BODY_SIDE_PAD = 24
/** sm:gap-5 between the cards. */
const CARD_GAP = 20
/** Capture height for the stills. Comfortably above FRAME_MAX_H so a HiDPI
 * screen still gets real pixels rather than an upscale. */
const THUMB_H = 960

/**
 * Live height of an element.
 *
 * The frames used to be sized by viewport math — `min(470px, 56dvh)` — which
 * knows nothing about the header, the footer or the shot strip. On any window
 * shorter than ~810px the row was taller than the body that holds it, and the
 * body's `overflow-hidden` CROPPED the bottom off every card: the shots stopped
 * being 9:16 exactly where judging the framing matters (owner screenshot,
 * 2026-09-26, with the strip open). Measuring the box the frames actually live
 * in is the only way the aspect ratio survives every window size.
 *
 * `active` exists because the observed node can be conditionally rendered: the
 * effect has to re-attach when it mounts, not once on first render.
 */
function useBoxSize<T extends HTMLElement>(
  active = true
): [React.RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const el = active ? ref.current : null
    if (!el) {
      setSize({ width: 0, height: 0 })
      return
    }
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      setSize((prev) =>
        prev.width === r.width && prev.height === r.height
          ? prev
          : { width: r.width, height: r.height }
      )
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [active])
  return [ref, size]
}

/** Tailwind's `sm`. Below it the cards are width-driven (a swipeable strip of
 * 46vw frames); from it up their width is computed from the measured height, so
 * the two regimes cannot both be expressed in one class list. */
function useWideLayout(): boolean {
  const query = '(min-width: 640px)'
  const [wide, setWide] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const onChange = (): void => setWide(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return wide
}

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

    // Timed for the same reason as the load: a seek that never completes used
    // to stall every remaining thumbnail behind it, silently and for ever.
    const seekTo = (sec: number): Promise<boolean> =>
      new Promise((resolve) => {
        const timer = window.setTimeout(() => {
          video.removeEventListener('seeked', done)
          resolve(false)
        }, 5000)
        const done = (): void => {
          window.clearTimeout(timer)
          video.removeEventListener('seeked', done)
          resolve(true)
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
        // One element serves every clip in turn, and assigning `src` alone does
        // not always restart the load algorithm on a reused element — without
        // this, `loadeddata` can simply never fire.
        video.load()
        // Timed, because "never fires" is a real outcome here: the media route
        // is a service worker, and a request it does not answer left this
        // promise pending for ever. The card then sat on its film icon with no
        // error anywhere (seen on a modal reopen, 2026-09-09). A missed thumb
        // is a placeholder; a hung one costs every LATER thumb too, since they
        // are generated in sequence behind it.
        const loaded = await new Promise<boolean>((resolve) => {
          const timer = window.setTimeout(() => resolve(false), 8000)
          const finish = (ok: boolean) => (): void => {
            window.clearTimeout(timer)
            resolve(ok)
          }
          video.addEventListener('loadeddata', finish(true), { once: true })
          video.addEventListener('error', finish(false), { once: true })
        })
        if (cancelled) return
        if (!loaded) continue
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
          const seeked = await seekTo(Math.max(0, Math.min(t, (video.duration || t + 1) - 0.05)))
          if (cancelled) return
          if (!seeked) continue
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

/**
 * One option's picture: the SELECTED one plays its window on a loop, the others
 * are stills.
 *
 * There is no play control. This screen asks one question — which of these two
 * shots — and the answer is in the motion, not in a frame: a still cannot show
 * "โพสท์หันข้าง ยิ้มทักทายกล้อง". Making the user press play on each option in
 * turn put a chore between them and the only thing they came here to compare,
 * and the disc sat over the middle of the face while they did it. Selecting is
 * now the whole gesture: tap an option, it plays; tap the other, that one plays
 * and this one goes back to a still. Never two at once — one decoder, and one
 * moving picture to look at.
 *
 * Muted + `playsInline` is what makes autoplay legal everywhere, iOS included.
 */
function OptionFrame({
  uid,
  clips,
  win,
  thumb,
  playing
}: {
  uid: string
  clips: LocalClip[]
  win: ShotWindow
  thumb: string | undefined
  playing: boolean
}): React.JSX.Element {
  const ref = useRef<HTMLVideoElement | null>(null)
  const clip = clips.find((c) => c.id === win.sourceClip)

  /** Rewind into the window only when outside it, so a retry does not restart. */
  const start = useCallback((): void => {
    const v = ref.current
    if (!v) return
    if (v.currentTime < win.sourceIn || v.currentTime > win.sourceOut) v.currentTime = win.sourceIn
    void v.play().catch(() => undefined)
  }, [win.sourceIn, win.sourceOut])

  useEffect(() => {
    if (!playing) return
    start()
    // A refused autoplay is SILENT, and there is no play button left to rescue
    // it, so one refusal would freeze the card on a still for good. Measured
    // refusal in Chrome: "video-only background media was paused to save power"
    // — muted video is not allowed to run while the window is unfocused, and
    // the promise rejects with AbortError. Every retry hook below is a moment
    // when the browser's reason to refuse may have gone away.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') start()
    }
    window.addEventListener('focus', start)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', start)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [playing, start])

  if (playing && clip) {
    return (
      <video
        ref={ref}
        muted
        playsInline
        // The still stays underneath as the poster, so the swap from image to
        // video is not a black flash while the first frame decodes.
        poster={thumb}
        src={window.noey.media.urlFor(uid, clip.file)}
        className="h-full w-full object-cover"
        // The effect fires before the element can play anything; this is the
        // attempt that usually takes.
        onCanPlay={start}
        // Last resort, and the only one a person can reach: a tap on the
        // picture. It bubbles to the card, where selecting the already-selected
        // option is a no-op, so this cannot change the answer by accident.
        onClick={start}
        onLoadedMetadata={(e) => {
          e.currentTarget.currentTime = win.sourceIn
        }}
        onTimeUpdate={(e) => {
          // Loop the window rather than running on into the next shot.
          if (e.currentTarget.currentTime >= win.sourceOut) {
            e.currentTarget.currentTime = win.sourceIn
          }
        }}
      />
    )
  }
  if (thumb) return <img src={thumb} alt="" className="h-full w-full object-cover" />
  return (
    <div className="flex h-full w-full items-center justify-center">
      <Film size={20} className="text-muted" />
    </div>
  )
}

interface Option {
  /** null = the shot in use now; else an index into `swapCandidates(seg)`. */
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
  const { navigate } = useRouter()
  const project = job.project
  const script = useMemo<DubEditScript>(
    () =>
      ((project.editScript as unknown as DubEditScript | undefined) ??
        job.editScript ?? { segments: [] }) as DubEditScript,
    [project.editScript, job.editScript]
  )
  const segments = useMemo(() => script.segments ?? [], [script])
  const regime = swapRegimeFor(job.mode, project.voiceoverPath)

  /** The cursor IS the shot number: one step per shot of the cut, in cut order.
   * Filtering to shots with alternatives made the counter and the progress
   * ticks describe an invisible queue — see the file header. */
  const shotCount = segments.length

  const [cursor, setCursor] = useState(0)
  /** segIndex → chosen candidate; absent = keep the shot in use. */
  const [picks, setPicks] = useState<ReadonlyMap<number, number>>(new Map())
  const [browsing, setBrowsing] = useState(false)

  const panelRef = useRef<HTMLDivElement>(null)
  const wide = useWideLayout()
  const [bodyRef, bodyBox] = useBoxSize<HTMLDivElement>()
  const [headRef, headBox] = useBoxSize<HTMLDivElement>()
  const [stripRef, stripBox] = useBoxSize<HTMLDivElement>(browsing)

  const segIndex = Math.min(cursor, Math.max(0, shotCount - 1))
  const seg = segments[segIndex] as Record<string, unknown> | undefined
  const candidates = seg ? swapCandidates(seg) : []

  const durationOf = (s: Record<string, unknown>): number =>
    num(s.durationSec) || Math.max(0, num(s.sourceOut) - num(s.sourceIn))

  const options: Option[] = useMemo(() => {
    if (!seg || swapCandidates(seg).length === 0) return []
    const dur = durationOf(seg)
    const current = segmentWindow(seg)
    // After a swap the shot in use is a backup, and the AI's own pick is one
    // of the candidates — labelled as such, so it is never offered twice or
    // lost (it used to vanish, and the backup showed up as "AI เลือกไว้").
    const swapped = segmentSwappedFrom(seg) !== null
    const head: Option = {
      altIndex: null,
      window: current,
      label: swapped ? 'ที่ใช้อยู่ตอนนี้' : 'AI เลือกไว้',
      note: swapped ? '' : String(seg.visualDescription ?? ''),
      disabledReason: null
    }
    const rest = candidates.map((c, i) => ({
      altIndex: i,
      window: c.window,
      label: c.original ? 'AI เลือกไว้ (ตัวเดิม)' : 'อีกมุมหนึ่ง',
      note: c.note,
      disabledReason:
        regime === 'locked' && !windowFitsLocked(c.window, dur)
          ? 'ช่วงนี้สั้นกว่าช็อตเดิม — ใช้ได้เฉพาะตอนที่ความยาวคลิปยังปรับได้'
          : null
    }))
    return [head, ...rest]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seg, segIndex, regime])

  // ── frame size ────────────────────────────────────────────────────────────
  // Measured, never guessed: the height comes from the box the frames really
  // live in (which EXCLUDES the shot strip — it overlays, so opening it cannot
  // resize a frame), the width is whatever that height allows at 9:16, and the
  // width is then capped so N cards still fit side by side on a narrow window.
  // Only the wrapper's width is set: the frame's own `aspect-[9/16]` derives
  // the height from it, so the shot can never be squeezed out of ratio.
  const cardCount = Math.max(1, options.length)
  const frameH =
    bodyBox.height > 0
      ? Math.max(
          FRAME_MIN_H,
          Math.min(FRAME_MAX_H, bodyBox.height - headBox.height - BODY_PAD_H - LABEL_BLOCK_H)
        )
      : FRAME_MAX_H
  const widthCap =
    bodyBox.width > 0
      ? (bodyBox.width - BODY_SIDE_PAD * 2 - CARD_GAP * (cardCount - 1)) / cardCount
      : Infinity
  const frameW = Math.max(120, Math.floor(Math.min((frameH * 9) / 16, widthCap)))
  /** Below `sm` the CSS drives the size; from it up the measurement does. */
  const frameStyle = wide ? { width: frameW } : undefined

  // Thumbs for what is on screen plus the next shot — one step of prefetch,
  // not the whole cut.
  const wants = useMemo<ThumbWant[]>(() => {
    const list: ThumbWant[] = []
    const push = (w: ShotWindow): void => {
      list.push({ clip: w.sourceClip, time: w.matchedFrameTime || w.sourceIn })
    }
    // A shot with no alternative still shows its own frame, so it still needs
    // a thumb even though `options` is empty for it.
    if (seg) push(segmentWindow(seg))
    for (const o of options) push(o.window)
    const nextSeg = segments[segIndex + 1] as Record<string, unknown> | undefined
    if (nextSeg) {
      push(segmentWindow(nextSeg))
      for (const c of swapCandidates(nextSeg)) push(c.window)
    }
    // The strip shows every shot once opened.
    if (browsing) for (const s of segments) push(segmentWindow(s as Record<string, unknown>))
    return list
  }, [options, seg, segments, segIndex, browsing])
  const thumbs = useShotThumbs(project.uid, project.clips, wants)
  const thumbFor = (w: ShotWindow): string | undefined =>
    thumbs.get(thumbKey(project.uid, w.sourceClip, w.matchedFrameTime || w.sourceIn))

  // ── choices ───────────────────────────────────────────────────────────────
  const pending = useMemo(() => {
    const list: SwapChoice[] = []
    for (const [idx, altIndex] of picks) {
      const s = segments[idx] as Record<string, unknown> | undefined
      if (!s) continue
      const cand = swapCandidates(s)[altIndex]
      if (cand) list.push({ segIndex: idx, window: cand.window })
    }
    return applySwapsToScript(script, list, regime)
  }, [picks, script, segments, regime])
  const diffCount = pending.applied.length

  const choose = (opt: Option): void => {
    if (opt.disabledReason || !seg) return
    setPicks((prev) => {
      const next = new Map(prev)
      if (opt.altIndex === null) next.delete(segIndex)
      else next.set(segIndex, opt.altIndex)
      return next
    })
  }

  const isChosen = (opt: Option): boolean => {
    const picked = picks.get(segIndex)
    return opt.altIndex === null ? picked === undefined : picked === opt.altIndex
  }

  const last = cursor >= shotCount - 1
  const goTo = (next: number): void => {
    // Nothing to stop: the next shot's chosen option starts playing on its own.
    setCursor(Math.max(0, Math.min(shotCount - 1, next)))
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

  const apply = async (): Promise<void> => {
    if (diffCount === 0) return
    // Locked regime: the voiced final is rendered from the planned timeline,
    // so every swap must find the cut(s) that show its shot there. One that
    // cannot (the post-voiceover editor removed or replaced that footage) used
    // to be dropped silently — the project reported done with the old shot.
    let commit = pending
    if (regime === 'locked' && project.timeline) {
      const { missed } = retimeTimelineForSwap(
        segments as Record<string, unknown>[],
        pending.script.segments,
        project.timeline as unknown as DubTimeline
      )
      if (missed.length > 0) {
        const shots = missed.map((i) => i + 1).join(', ')
        const rest = pending.applied.filter((c) => !missed.includes(c.segIndex))
        const ok = await confirm({
          title: 'บางช็อตเปลี่ยนในคลิปที่พากย์แล้วไม่ได้',
          body: `ช็อตที่ ${shots} ไม่อยู่ในไทม์ไลน์หลังพากย์เสียงแล้ว (ถูกแก้ในตัวแก้ไขวิดีโอ) — เปลี่ยนช็อตนั้นในตัวแก้ไขวิดีโอแทน`,
          confirmLabel:
            rest.length > 0 ? `ทำคลิปใหม่เฉพาะ ${rest.length} ช็อตที่เหลือ` : 'เข้าใจแล้ว',
          cancelLabel: 'เลือกต่อ'
        })
        if (!ok || rest.length === 0) return
        commit = applySwapsToScript(
          script,
          rest.map((c) => ({ segIndex: c.segIndex, window: c.window })),
          regime
        )
      }
    }
    const log: ShotSwapLogEntry[] = commit.applied.map((c) => {
      const original = segments[c.segIndex] as Record<string, unknown>
      const match = swapCandidates(original).find((cand) => sameWindow(cand.window, c.window))
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
    void job.applyShotSwap(commit.script, log)
    // Straight to the progress screen, the way every other run is shown. The
    // project page has no progress view of its own, so after pressing
    // ทำคลิปใหม่ nothing visibly happened and the user went home and pressed
    // it again to find out whether it was running (live report 2026-09-21).
    navigate({ name: 'progress', uid: project.uid })
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
        // Was play/pause. The selected shot plays on its own now, so space
        // moves the choice between the options instead — the one key that did
        // something on this screen keeps doing something.
        e.preventDefault()
        const at = options.findIndex((o) => isChosen(o))
        for (let step = 1; step <= options.length; step++) {
          const next = options[(Math.max(0, at) + step) % options.length]
          if (next && !next.disabledReason) {
            choose(next)
            break
          }
        }
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
  }, [options, cursor, last, shotCount, requestClose, segIndex, picks])

  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  if (shotCount === 0 || !seg) return null

  const hasOptions = options.length > 0
  const lineText = String(seg.voiceoverScript ?? '').trim()
  const regimeNote =
    regime === 'locked'
      ? 'ความยาวช็อตเท่าเดิม ไทม์ไลน์ไม่เคลื่อน'
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
          {/* One tick per shot of the cut. They shrink rather than overflow:
              a 30-shot cut would otherwise push the counter off the header. A
              tick for a shot with an alternative is drawn brighter, so the
              places worth stopping at are visible from the header. */}
          <span className="hidden min-w-0 shrink items-center gap-[7px] sm:flex">
            {segments.map((s, i) => (
              <span
                key={i}
                className={cn(
                  'h-1 w-[22px] min-w-[3px] shrink rounded-sm',
                  i === segIndex
                    ? 'bg-accent'
                    : hasSwapOptions(s as Record<string, unknown>)
                      ? 'bg-[rgb(243_242_242_/_0.45)]'
                      : 'bg-[rgb(243_242_242_/_0.16)]'
                )}
              />
            ))}
          </span>
          <span className="shrink-0 text-[13.5px] tabular-nums text-muted">
            {segIndex + 1} / {shotCount}
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

        {/* ── question ──
            The body owns its own height and the shot strip OVERLAYS it, so
            opening the strip cannot take height away from the frames. When the
            strip is open the body simply gains that much scroll instead. */}
        <div ref={bodyRef} className="relative min-h-0 flex-1">
          <div
            className="flex h-full flex-col items-center overflow-y-auto px-6 pt-[26px]"
            style={browsing ? { paddingBottom: stripBox.height } : undefined}
          >
            <div ref={headRef} className="flex shrink-0 flex-col items-center">
              <p className="text-[22px] font-semibold text-ink">
                {hasOptions ? 'ช็อตนี้เอาอันไหน' : 'ช็อตนี้ AI ไม่มีตัวเลือกอื่นให้'}
              </p>
              <p className="mt-[7px] text-center text-sm text-muted">
                {!hasOptions ? (
                  'ถ้าไม่ชอบช็อตนี้ ลองสั่งตัดใหม่พร้อมบอกเหตุผล หรือแก้เองในตัวแก้ไขวิดีโอ'
                ) : lineText ? (
                  <>
                    ตอนที่พูดว่า <span className="text-ink-2">&ldquo;{lineText}&rdquo;</span>
                  </>
                ) : (
                  'เลือกภาพที่อยากให้อยู่ในคลิป'
                )}
              </p>
            </div>

            {/* A shot the AI returned no backup for is still walked through:
                the frame is shown so the user can see where they are in their
                own cut, and the card says plainly there is nothing to pick. */}
            {!hasOptions ? (
              <div className="mt-[22px] flex shrink-0 justify-center">
                <div
                  className="relative aspect-[9/16] w-[46vw] max-w-[210px] overflow-hidden rounded-[5px] border border-border-faint bg-media sm:w-auto sm:max-w-none"
                  style={frameStyle}
                >
                  {thumbFor(segmentWindow(seg)) ? (
                    <img
                      src={thumbFor(segmentWindow(seg))}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center">
                      <Film size={20} className="text-muted" />
                    </div>
                  )}
                </div>
              </div>
            ) : (
              /* A swipeable strip below `sm`: four 9:16 cards in a
                 non-wrapping centred row came out ~54px wide each at 390 —
                 vertical slivers of the shots you are choosing between. */
              <div className="mt-[22px] flex shrink-0 items-start gap-3 self-stretch overflow-x-auto pb-1 sm:justify-center sm:gap-5 sm:overflow-visible">
                {options.map((opt, i) => {
                  const chosen = isChosen(opt)
                  const replaced = !chosen && opt.altIndex === null && diffCountFor(picks, segIndex)
                  return (
                    <div
                      key={i}
                      // One measured width for every card from `sm` up: the
                      // cards' sizes must be identical BY CONSTRUCTION, not by
                      // two flex resolutions happening to agree — the owner
                      // caught one card rendering larger than the other
                      // (2026-09-09).
                      className="flex w-[46vw] max-w-[210px] shrink-0 flex-col sm:w-auto sm:max-w-none"
                      style={frameStyle}
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
                        className={cn(
                          // Always width-driven, and the width comes from the
                          // card: the height then follows the 9:16 source. The
                          // old `sm:h-[min(470px,56dvh)]` was viewport math the
                          // body could not honour, so the cards were clipped.
                          'relative aspect-[9/16] w-full overflow-hidden rounded-[5px] bg-media outline-none transition-colors duration-state ease-out',
                          // One accent border, never a border plus a ring —
                          // stacked rings read as two overlapping edges.
                          chosen
                            ? 'border-2 border-accent'
                            : 'border border-[rgb(243_242_242_/_0.18)] hover:border-[rgb(243_242_242_/_0.4)] focus-visible:border-accent',
                          opt.disabledReason ? 'cursor-not-allowed opacity-45' : 'cursor-pointer',
                          replaced && 'opacity-50'
                        )}
                      >
                        {/* Selection IS playback — see OptionFrame. A disabled
                            option can never be selected, so it never plays. */}
                        <OptionFrame
                          uid={project.uid}
                          clips={project.clips}
                          win={opt.window}
                          thumb={thumbFor(opt.window)}
                          playing={chosen && !opt.disabledReason}
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
            )}
          </div>

          {/* ── browse strip (second layer) ──
              Absolute, INSIDE the body: it used to be a flex sibling, so
              opening it shortened the body and the cards were cropped by the
              body's overflow (owner screenshot, 2026-09-26). Overlaying costs
              nothing — the body above gains exactly this much bottom padding,
              so whatever the strip covers can still be scrolled to. */}
          {browsing ? (
            <div
              ref={stripRef}
              className="absolute inset-x-0 bottom-0 z-10 max-h-[45%] overflow-y-auto border-t border-divider bg-surface px-6 py-3"
            >
              <div className="flex flex-wrap gap-[5px]">
                {segments.map((s, i) => {
                  const w = segmentWindow(s as Record<string, unknown>)
                  const hasAlts = hasSwapOptions(s as Record<string, unknown>)
                  const current = i === segIndex
                  return (
                    <button
                      key={i}
                      type="button"
                      aria-label={`ช็อตที่ ${i + 1}${hasAlts ? '' : ' (ไม่มีตัวเลือกอื่น)'}`}
                      aria-current={current}
                      // Every shot is reachable, with or without alternatives:
                      // the strip is how someone finds the place in their own
                      // cut that they came here to change.
                      onClick={() => setCursor(i)}
                      className={cn(
                        'relative h-[54px] w-[30px] shrink-0 overflow-hidden rounded-[3px] bg-media outline-none',
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
        </div>

        {/* ── footer ── one commit button, one place, label follows state ── */}
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-x-4 gap-y-3 px-6 pb-[22px] pt-5">
          <span className="w-full min-w-0 text-[13.5px] text-muted sm:w-auto sm:flex-1">
            {diffCount > 0 ? (
              <>
                <span className="text-ink-2">เปลี่ยนแล้ว {diffCount} ช็อต</span> · {regimeNote} ·
                ของเดิมย้อนกลับได้เสมอ
              </>
            ) : hasOptions ? (
              'แตะภาพเพื่อเลือก — อันที่เลือกจะเล่นวนให้ดู'
            ) : (
              'ช็อตนี้ไม่มีอะไรให้เลือก — กด ถัดไป เพื่อดูช็อตต่อไป'
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
          {/* ย้อนกลับ walks to the previous shot (it used to RESET every pick
              under that label — a destructive act wearing a navigation word),
              and ทำคลิปใหม่ is available the moment anything changed: nobody
              should have to walk all 19 questions to commit the two they came
              for (owner 2026-09-09). */}
          {cursor > 0 ? (
            <Button variant="ghost" onClick={() => goTo(cursor - 1)}>
              ย้อนกลับ
            </Button>
          ) : null}
          {!last ? (
            <Button variant="secondary" onClick={() => goTo(cursor + 1)}>
              ถัดไป
            </Button>
          ) : null}
          {diffCount > 0 ? (
            <Button variant="primary" onClick={() => void apply()}>
              ทำคลิปใหม่ · {diffCount} ช็อต
            </Button>
          ) : last ? (
            <Button variant="secondary" onClick={onClose}>
              เสร็จแล้ว
            </Button>
          ) : null}
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
