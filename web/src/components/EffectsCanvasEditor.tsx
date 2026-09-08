import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { pushHistory, stepHistory } from '../lib/undoStacks'
import {
  ArrowLeft,
  Copy,
  Film,
  Paperclip,
  Plus,
  Save,
  Sparkles,
  Square,
  Trash2,
  Redo2,
  Undo2,
  X
} from 'lucide-react'
import type { LocalProject } from '@renderer/platform/types'
import type { ApiSession } from '../lib/videosLocalApi'
import { getEffectsDoc, putEffectsDoc } from '../lib/effectsLocalApi'
import { renderEffectsDoc, runAiEffects } from '../lib/effectsPipeline'
import { useFxJobs } from '../lib/fxJobs'
import { useUnsavedGuard } from '../lib/unsavedGuard'
import { isLegacyEffectsStyle, listStyles, type StyleSummary } from '../lib/stylesApi'
import { buildEffectsScriptText } from '../lib/effectsScript'
import { buildEffectsCutPoints, resolveClipDurationsSec } from '../lib/effectsCuts'
import {
  effectEndSec,
  normalizeEffectsDoc,
  type EffectInstance,
  type EffectsDoc
} from '../lib/effects'
import {
  PRESET_DEFAULT_SEC,
  PRESET_GROUPS,
  ZOOM_PRESETS,
  inertPropReason,
  instanceTitle,
  presetForInstance,
  type ZoomPreset
} from '../lib/effectsCatalog'
import { fmtTime, fmtTimeTenths, parseTimecode, rulerStepSec } from '../lib/timelineMath'
import { pickFile } from '../lib/pickFile'
import { useFilmstrip } from '../lib/useFilmstrip'
import { cn } from '../lib/cn'
import { OverlayTitleBarSpacer } from './OverlayTitleBarSpacer'
import { Button } from './ui/Button'
import { Chip } from './ui/Chip'
import { Select } from './ui/Select'
import { Slider } from './ui/Slider'
import { StatusLine } from './ui/StatusLine'
import { Switch } from './ui/Switch'
import { Textarea } from './ui/Input'
import { VideoPlayer } from './ui/VideoPlayer'

/**
 * เอฟเฟกต์การซูม editor (R8) — two columns, no library rail.
 *
 * The stage is a FRAMING TOOL, not just a monitor: the gold frame shows what
 * the camera sees at the zoomed distance — drag it to move the focus point,
 * drag its corner dot to change the zoom, and the "หลัง" view applies the same
 * crop math ffmpeg will (scale about the focus point) so what you frame here
 * is what renders.
 *
 * Tracks: ภาพ (filmstrip) · ซูม (span/scene presets) · รอยต่อ (whip-pan
 * diamonds — a point at a real cut, not a range, so the shape itself says it
 * cannot be stretched).
 *
 * Old overlay instances (pre-2026-08-12 effects.json) surface as read-only
 * "เอฟเฟกต์เดิม (ไม่รองรับแล้ว)" rows with a delete — never rendered, never
 * silently dropped.
 */

const MIN_DUR = 0.3
const SNAP = 0.1
/** How close (on screen) a dragged edge has to get before it snaps to a cut. */
const CUT_SNAP_PX = 9

// R8 §5 geometry
const RAIL_W = 340
const HEADER_COL_PX = 92
const RULER_PX = 22
const TRACK_FILM_PX = 40
const TRACK_ZOOM_PX = 34
const TRACK_CUT_PX = 22
const TRACK_GAP_PX = 3

let idCounter = 0
function newId(): string {
  idCounter += 1
  return `fx_${Date.now().toString(36)}${idCounter.toString(36)}`
}

function snap(v: number): number {
  return Math.round(v / SNAP) * SNAP
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** The tight end of a punch-zoom — what the gold frame outlines. For an
 * open-out the START is the tight framing (zoomFrom > zoomTo). */
function tightZoom(inst: EffectInstance): { z: number; key: 'zoomFrom' | 'zoomTo' } {
  const from = num(inst.props.zoomFrom, 1)
  const to = num(inst.props.zoomTo, 1.3)
  return from > to ? { z: from, key: 'zoomFrom' } : { z: to, key: 'zoomTo' }
}

/** 26×26 line thumbnails from the R8 popover — one per preset. */
function PresetThumb({ id }: { id: string }): React.JSX.Element {
  const faint = 'rgba(243,242,242,.28)'
  const soft = 'rgba(217,164,65,.4)'
  const gold = '#d9a441'
  switch (id) {
    case 'cut-in':
      return (
        <svg width="26" height="26" viewBox="0 0 26 26" className="shrink-0">
          <rect x="1" y="3" width="24" height="20" fill="none" stroke={faint} />
          <rect x="7" y="8" width="12" height="10" fill="none" stroke={gold} strokeWidth="2" />
        </svg>
      )
    case 'push-in':
      return (
        <svg width="26" height="26" viewBox="0 0 26 26" className="shrink-0">
          <rect x="1" y="3" width="24" height="20" fill="none" stroke={faint} />
          <rect x="4" y="6" width="18" height="14" fill="none" stroke={soft} />
          <rect x="8" y="9" width="10" height="8" fill="none" stroke={gold} strokeWidth="1.8" />
        </svg>
      )
    case 'open-out':
      return (
        <svg width="26" height="26" viewBox="0 0 26 26" className="shrink-0">
          <rect x="1" y="3" width="24" height="20" fill="none" stroke={faint} />
          <rect x="8" y="9" width="10" height="8" fill="none" stroke={soft} />
          <rect x="4" y="6" width="18" height="14" fill="none" stroke={gold} strokeWidth="1.8" />
        </svg>
      )
    case 'push-drift':
      return (
        <svg width="26" height="26" viewBox="0 0 26 26" className="shrink-0">
          <rect x="1" y="3" width="24" height="20" fill="none" stroke={faint} />
          <rect x="4" y="8" width="11" height="10" fill="none" stroke={soft} />
          <rect x="11" y="8" width="11" height="10" fill="none" stroke={gold} strokeWidth="1.8" />
        </svg>
      )
    case 'scene-drift':
      return (
        <svg width="26" height="26" viewBox="0 0 26 26" className="shrink-0">
          <rect x="1" y="3" width="24" height="20" fill="none" stroke={faint} />
          <rect x="4" y="6" width="11" height="9" fill="none" stroke={soft} />
          <rect x="11" y="11" width="11" height="9" fill="none" stroke={gold} strokeWidth="1.8" />
        </svg>
      )
    default:
      return (
        <svg width="26" height="26" viewBox="0 0 26 26" className="shrink-0">
          <rect x="1" y="5" width="9" height="16" fill="none" stroke={faint} />
          <rect x="16" y="5" width="9" height="16" fill="none" stroke={faint} />
          <path
            d="M6 13h15M18 10l3 3-3 3"
            fill="none"
            stroke={gold}
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )
  }
}

/** Gold-frame geometry: what the camera sees at zoom z focused on (fx,fy),
 * as fractions of the stage. Same crop math as ffmpeg's zoompan offset. */
function frameRect(
  z: number,
  fx: number,
  fy: number
): { left: number; top: number; w: number; h: number } {
  const w = 1 / z
  return { left: fx * (1 - w), top: fy * (1 - w), w, h: w }
}

type FrameDragKind = 'frame' | 'frame-b' | 'zoom-corner'

/** The framing overlay on the stage (R8): one draggable gold frame for a
 * punch-zoom, two (เริ่ม/จบ) joined by a dashed arrow for a scene-drift. */
function FramingOverlay({
  inst,
  onBegin
}: {
  inst: EffectInstance
  onBegin: (e: React.PointerEvent, inst: EffectInstance, kind: FrameDragKind) => void
}): React.JSX.Element | null {
  if (inst.componentId === 'scene-drift') {
    const z = Math.max(1.02, num(inst.props.zoomTo, 1.15))
    const a = frameRect(z, num(inst.props.focusFromX, 0.5), num(inst.props.focusFromY, 0.5))
    const b = frameRect(z, num(inst.props.focusToX, 0.5), num(inst.props.focusToY, 0.5))
    return (
      <>
        <svg className="pointer-events-none absolute inset-0 z-10 h-full w-full">
          <line
            x1={`${(a.left + a.w / 2) * 100}%`}
            y1={`${(a.top + a.h / 2) * 100}%`}
            x2={`${(b.left + b.w / 2) * 100}%`}
            y2={`${(b.top + b.h / 2) * 100}%`}
            stroke="#d9a441"
            strokeWidth="1.5"
            strokeDasharray="5 4"
            markerEnd="url(#fx-arrow)"
          />
          <defs>
            <marker
              id="fx-arrow"
              markerWidth="7"
              markerHeight="7"
              refX="5"
              refY="3.5"
              orient="auto"
            >
              <path d="M0,0 L7,3.5 L0,7 Z" fill="#d9a441" />
            </marker>
          </defs>
        </svg>
        {(['frame', 'frame-b'] as const).map((kindKey, ki) => {
          const r = ki === 0 ? a : b
          return (
            <div
              key={kindKey}
              onPointerDown={(e) => onBegin(e, inst, kindKey)}
              className={cn(
                'absolute z-10 cursor-move rounded-[2px] border-2',
                ki === 0 ? 'border-[rgb(217_164_65_/_0.55)]' : 'border-accent'
              )}
              style={{
                left: `${r.left * 100}%`,
                top: `${r.top * 100}%`,
                width: `${r.w * 100}%`,
                height: `${r.h * 100}%`,
                touchAction: 'none'
              }}
            >
              <span className="absolute -top-0.5 left-0 -translate-y-full rounded-[3px] bg-[rgb(217_164_65_/_0.9)] px-1.5 py-0.5 text-[12px] font-semibold whitespace-nowrap text-ground">
                {ki === 0 ? 'เริ่ม' : 'จบ'}
              </span>
              {ki === 1 && (
                <span
                  onPointerDown={(e) => onBegin(e, inst, 'zoom-corner')}
                  className="absolute -right-1.5 -bottom-1.5 h-3 w-3 cursor-nwse-resize rounded-full border-2 border-black bg-accent"
                  style={{ touchAction: 'none' }}
                />
              )}
            </div>
          )
        })}
      </>
    )
  }
  if (inst.componentId !== 'punch-zoom') return null
  const tz = tightZoom(inst)
  const r = frameRect(
    Math.max(1.02, tz.z),
    num(inst.props.focusX, 0.5),
    num(inst.props.focusY, 0.5)
  )
  return (
    <div
      onPointerDown={(e) => onBegin(e, inst, 'frame')}
      className="absolute z-10 cursor-move rounded-[2px] border-2 border-accent"
      style={{
        left: `${r.left * 100}%`,
        top: `${r.top * 100}%`,
        width: `${r.w * 100}%`,
        height: `${r.h * 100}%`,
        touchAction: 'none'
      }}
    >
      <span className="absolute -top-0.5 left-0 -translate-y-full rounded-[3px] bg-[rgb(217_164_65_/_0.9)] px-1.5 py-0.5 text-[13px] font-semibold whitespace-nowrap text-ground">
        ซูม {tz.z.toFixed(1)}×
      </span>
      <svg
        width="22"
        height="22"
        viewBox="0 0 22 22"
        className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
      >
        <circle cx="11" cy="11" r="6" fill="none" stroke="#d9a441" strokeWidth="1.5" />
        <path
          d="M11 0v5M11 17v5M0 11h5M17 11h5"
          stroke="#d9a441"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
      <span
        onPointerDown={(e) => onBegin(e, inst, 'zoom-corner')}
        title="ลากเพื่อเปลี่ยนระยะซูม"
        className="absolute -right-1.5 -bottom-1.5 h-3 w-3 cursor-nwse-resize rounded-full border-2 border-black bg-accent"
        style={{ touchAction: 'none' }}
      />
    </div>
  )
}

/** "เพิ่มเอฟเฟกต์การซูม" popover (R8 §ข): 400px, three groups by where the
 * preset can be placed. Cut/scene rows need real cut data and say so. */
function PresetPicker({
  hasCuts,
  onPick
}: {
  hasCuts: boolean
  onPick: (p: ZoomPreset) => void
}): React.JSX.Element {
  return (
    <div
      data-fx-popover
      className="absolute bottom-full left-0 z-30 mb-2 w-[400px] rounded-md border border-border bg-surface py-2.5 shadow-[0_12px_32px_rgb(0_0_0_/_0.5)]"
    >
      {PRESET_GROUPS.map((g, gi) => (
        <div key={g.scope} className={gi > 0 ? 'mt-2 border-t border-divider pt-2' : ''}>
          <p className="px-3.5 pb-2 text-sm text-muted">
            {g.label}
            {g.note ? <span className="ml-1.5 text-[13px]">— {g.note}</span> : null}
          </p>
          {ZOOM_PRESETS.filter((p) => p.scope === g.scope).map((p) => {
            const blocked = p.scope !== 'span' && !hasCuts
            return (
              <button
                key={p.id}
                type="button"
                disabled={blocked}
                onClick={() => onPick(p)}
                className={cn(
                  'flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors duration-state ease-out',
                  blocked ? 'cursor-not-allowed' : 'hover:bg-[rgb(243_242_242_/_0.06)]'
                )}
              >
                <PresetThumb id={p.id} />
                <span className="min-w-0">
                  <span className={cn('block text-[15px]', blocked ? 'text-muted' : 'text-ink-2')}>
                    {p.title}
                  </span>
                  <span className="block text-sm text-muted">
                    {blocked ? 'คลิปนี้ไม่มีข้อมูลรอยต่อฉาก' : p.hint}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}

/** Timecode field — commits on blur/Enter; junk restores the previous value
 * instead of silently becoming 0 (same rule as the timeline editor). */
function TimecodeField({
  value,
  onCommit,
  ariaLabel
}: {
  value: number
  onCommit: (sec: number) => void
  ariaLabel: string
}): React.JSX.Element {
  const [text, setText] = useState(fmtTimeTenths(value))
  // Adjust during render (React's "state from props" shape) — an effect here
  // would flash the stale text for a frame and trips set-state-in-effect.
  const [lastValue, setLastValue] = useState(value)
  if (value !== lastValue) {
    setLastValue(value)
    setText(fmtTimeTenths(value))
  }
  const commit = (): void => {
    const parsed = parseTimecode(text)
    if (parsed === null) setText(fmtTimeTenths(value))
    else onCommit(parsed)
  }
  return (
    <input
      value={text}
      aria-label={ariaLabel}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
      className="h-9 w-full min-w-0 rounded-md border border-border bg-transparent px-2.5 text-[15px] tabular-nums text-ink transition-colors duration-state ease-out"
    />
  )
}

interface Props {
  project: LocalProject
  session: ApiSession
  /** Finished cut video filename in the project dir. */
  baseFile: string
  onClose: () => void
}

export default function EffectsCanvasEditor({
  project,
  session,
  baseFile,
  onClose
}: Props): React.JSX.Element {
  const remoteUid = project.remote?.uid

  const [instances, setInstances] = useState<EffectInstance[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // AI/render work runs at app level (lib/fxJobs) so closing this screen does
  // not kill it, and reopening shows it still running with its progress.
  const fxJobs = useFxJobs()
  const fxJob = fxJobs.jobFor(project.uid)
  const busy = Boolean(fxJob)
  const progress = fxJob?.progress ?? ''
  const thinking = fxJob?.thinking ?? ''
  const [localError, setLocalError] = useState<string | null>(null)
  const error = localError ?? fxJobs.errorFor(project.uid) ?? null
  const setError = (message: string | null): void => {
    setLocalError(message)
    if (message === null) fxJobs.clearError(project.uid)
  }
  const [rendered, setRendered] = useState(false)
  const [viewingBakeFile, setViewingBakeFile] = useState(false)
  const [mediaKey, setMediaKey] = useState(0)

  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)

  const [aiOpen, setAiOpen] = useState(false)
  const [aiPrompt, setAiPrompt] = useState('')
  const [refPath, setRefPath] = useState<string | undefined>(undefined)
  const [styles, setStyles] = useState<StyleSummary[]>([])
  /** Saved zoom styles that exist but cannot be offered — distilled against the
   * removed overlay system (R8 §9). Counted rather than hidden outright: "my
   * styles are missing" is exactly what an empty dropdown looks like. */
  const [legacyStyleCount, setLegacyStyleCount] = useState(0)
  const [styleUid, setStyleUid] = useState<string>(() => {
    // Survive HMR / editor remount so a previously picked style isn't silently
    // dropped (empty style_uid + stale S3 style.txt used to resurrect the
    // wrong look — live report 2026-07-18).
    try {
      return window.localStorage.getItem(`effects-style:${project.uid}`) ?? ''
    } catch {
      return ''
    }
  })
  const [addOpen, setAddOpen] = useState(false)
  const [swapOpen, setSwapOpen] = useState(false)
  const [cutPoints, setCutPoints] = useState<number[]>([])
  const [clipDurations, setClipDurations] = useState<number[] | undefined>(undefined)
  /** The cut a drag is currently snapped to — lights that guide line up so the
   * user can see WHY the block stopped moving. Null when nothing is snapped. */
  const [snappedCut, setSnappedCut] = useState<number | null>(null)

  /** Snapshots for เลิกทำ. Bounded — this is one editing session, not history. */
  const [undoStack, setUndoStack] = useState<EffectInstance[][]>([])
  /** Undone snapshots, popped back by ทำซ้ำ. Cleared by any fresh edit —
   * branching history is not something this editor tries to model. */
  const [redoStack, setRedoStack] = useState<EffectInstance[][]>([])
  /** Which gesture the last snapshot belongs to — see pushUndo's coalescing.
   * Cleared on pointer-up, so one drag is one undo step and the next drag of
   * the same control is a new one. */
  const [undoTag, setUndoTag] = useState('')
  const undoDepth = undoStack.length
  const redoDepth = redoStack.length
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)

  const videoRef = useRef<HTMLVideoElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const laneAreaRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{
    id: string
    kind: 'frame' | 'frame-b' | 'zoom-corner' | 'lane-move' | 'lane-left' | 'lane-right' | 'scrub'
    startClientX: number
    startClientY: number
    origA: number
    origB: number
    origC: number
  } | null>(null)

  useEffect(() => {
    try {
      if (styleUid) window.localStorage.setItem(`effects-style:${project.uid}`, styleUid)
      else window.localStorage.removeItem(`effects-style:${project.uid}`)
    } catch {
      /* private mode / quota — selection still works in-memory this session */
    }
  }, [project.uid, styleUid])

  // Popovers close on any click outside them — a menu that only closes by
  // re-clicking its own button reads as stuck (live report 2026-08-13).
  useEffect(() => {
    if (!addOpen && !swapOpen) return
    const onDown = (e: MouseEvent): void => {
      const el = e.target as HTMLElement | null
      if (el?.closest('[data-fx-popover]')) return
      setAddOpen(false)
      setSwapOpen(false)
    }
    // `capture` so it still fires when the click lands on something that stops
    // propagation on its way up (the timeline blocks do).
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [addOpen, swapOpen])

  useEffect(() => {
    let alive = true
    // Zoom styles only (kind='effects'); a legacy style distilled against the
    // removed overlay system never appears here — its prose steers the AI
    // toward things the renderer cannot draw (R8 §9).
    listStyles(session, 'effects')
      .then((rows) => {
        if (!alive) return
        const ready = rows.filter((s) => s.status === 'ready' && !isLegacyEffectsStyle(s))
        setStyles(ready)
        setLegacyStyleCount(rows.filter(isLegacyEffectsStyle).length)
        setStyleUid((cur) => (cur && !ready.some((s) => s.uid === cur) ? '' : cur))
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [session, aiOpen])

  /** Skips the autosave effect for a state change that is not a user edit —
   * the initial empty state and the stored doc being loaded into it. */
  const firstEditRef = useRef(true)

  // ── data loading ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (remoteUid) {
      getEffectsDoc(session, remoteUid)
        .then((d) => {
          // Loading the stored doc is not an edit. The autosave effect skips
          // only its FIRST run (the empty initial state), so without this the
          // load counted as a change: the editor was "dirty" the moment it
          // opened and warned on the way out of a screen nothing was done on
          // (seen live 2026-08-13).
          firstEditRef.current = true
          setInstances(d.instances)
        })
        .catch(() => undefined)
    }
  }, [remoteUid, session])

  // Real scene-cut boundaries — where whip-pan diamonds live and what scene
  // spans snap to. Optional: a project with no cut data simply cannot place
  // per-scene or per-cut presets.
  useEffect(() => {
    let alive = true
    void resolveClipDurationsSec(project).then((durs) => {
      if (!alive) return
      setClipDurations(durs)
      setCutPoints(buildEffectsCutPoints(project, durs) ?? [])
    })
    return () => {
      alive = false
    }
    // Cut structure is fixed while this editor is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.uid])

  // Restore "ดูคลิปสำเร็จ" when final_fx.mp4 already exists.
  useEffect(() => {
    let cancelled = false
    const url = window.noey.media.urlFor(project.uid, 'final_fx.mp4')
    fetch(url, { headers: { Range: 'bytes=0-0' } })
      .then((r) => {
        if (!cancelled && (r.status === 206 || r.status === 200)) setRendered(true)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [project.uid])

  useEffect(() => {
    let raf = 0
    const tick = (): void => {
      const v = videoRef.current
      if (v) setCurrentTime(v.currentTime)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const videoSrc = window.noey.media.urlFor(
    project.uid,
    viewingBakeFile && rendered ? 'final_fx.mp4' : baseFile
  )

  const togglePlay = useCallback((): void => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) void v.play().catch(() => undefined)
    else v.pause()
  }, [])

  const seekVideo = useCallback((t: number): void => {
    const v = videoRef.current
    if (v) v.currentTime = Math.max(0, t)
  }, [])

  const selectAndReveal = useCallback(
    (inst: EffectInstance): void => {
      setSelectedId(inst.id)
      const v = videoRef.current
      if (!v) return
      const t = v.currentTime
      if (t < inst.startSec || t > effectEndSec(inst)) {
        seekVideo(inst.startSec + Math.min(0.4, inst.durationSec / 2))
      }
    },
    [seekVideo]
  )

  // ── instance mutation ──────────────────────────────────────────────────────
  /**
   * Snapshot for เลิกทำ.
   *
   * `tag` coalesces a continuous gesture into ONE undo step: a slider drag or a
   * block drag fires dozens of patches, and without this either every frame
   * became its own step (20 undos to get back one move) or — as shipped — only
   * add/remove/duplicate snapshotted at all and every drag and slider edit was
   * unundoable (live report 2026-08-13).
   *
   * Plain functions over state, not useCallback over refs: the snapshot needs
   * the CURRENT instances, and a callback that reads a ref cannot be passed
   * down safely (react-hooks/refs). The React compiler memoises these anyway.
   */
  function pushUndo(tag = ''): void {
    // Every mutation goes through here, so this is also where "the user just
    // changed something" is known.
    //
    // Editing while the baked clip is on screen was the bug behind "แก้แล้ว
    // ไม่เปลี่ยน" and "เพิ่ม zoom แล้วมันไม่อ่าน": after a render the stage
    // plays `final_fx.mp4`, which already has the OLD zooms burned in, and
    // `framingVisible` is gated on `!viewingBakeFile` — so a newly added zoom
    // had no draggable rect at all and every edit appeared to do nothing. Drop
    // back to the raw footage the moment anything is edited, exactly as the AI
    // result path already did.
    setViewingBakeFile((v) => {
      if (v) setMediaKey((k) => k + 1)
      return false
    })
    // A new edit is a new branch — anything that was undone is unreachable now.
    setRedoStack([])
    const coalesce = tag !== '' && tag === undoTag
    setUndoTag(tag)
    if (coalesce) return
    setUndoStack((s) => pushHistory(s, instances))
  }

  function patch(id: string, p: Partial<EffectInstance>): void {
    pushUndo(`patch:${id}:${Object.keys(p).sort().join(',')}`)
    setInstances((xs) => xs.map((i) => (i.id === id ? { ...i, ...p } : i)))
  }

  function patchProp(id: string, key: string, v: unknown): void {
    pushUndo(`prop:${id}:${key}`)
    setInstances((xs) =>
      xs.map((i) => (i.id === id ? { ...i, props: { ...i.props, [key]: v } } : i))
    )
  }

  // End of a gesture = end of an undo step (see pushUndo).
  useEffect(() => {
    const clear = (): void => setUndoTag('')
    window.addEventListener('pointerup', clear)
    return () => window.removeEventListener('pointerup', clear)
  }, [])

  const instancesRef = useRef(instances)
  /** The instances (serialized) handed to the last bake — see saveAndRender. */
  const renderedDocRef = useRef<string | null>(null)
  useEffect(() => {
    instancesRef.current = instances
  }, [instances])
  const draftPendingRef = useRef(false)

  /** Write the effects doc now. Called by the debounce and on the way out —
   * leaving within the debounce window used to drop the last edit entirely. */
  const saveDraftNow = async (): Promise<void> => {
    if (!remoteUid || !draftPendingRef.current) return
    draftPendingRef.current = false
    try {
      const doc = normalizeEffectsDoc({ version: 1, instances: instancesRef.current })
      await putEffectsDoc(session, remoteUid, doc)
      setSavedAt(new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }))
      // Emptying the doc has to retire the bake, because nothing else will.
      //
      // Deleting every zoom left `final_fx.mp4` on disk with the deleted zooms
      // burned into it, and the render button is disabled at zero instances
      // ("ยังไม่มีการซูมให้เรนเดอร์") so it could never be replaced either. The
      // only other thing that removes it is `drop_stale_bake`, which runs when
      // the CUT is re-rendered. Meanwhile the project page, the export and the
      // phone hand-off all prefer the bake — so the zooms the owner had just
      // deleted kept shipping, indefinitely (2026-09-07).
      //
      // Unlink rather than bake an empty doc: baking would re-encode the whole
      // video, with a progress bar, to produce a copy of the base.
      if (doc.instances.length === 0) {
        await window.noey.projects.deleteFile(project.uid, 'final_fx.mp4').catch(() => undefined)
        setRendered(false)
        setViewingBakeFile(false)
        setDirty(false)
        // Re-probe: usePreviewFile's candidate list has final_fx.mp4 first, and
        // it has to notice the file is gone and fall back to the plain cut.
        setMediaKey((k) => k + 1)
      }
    } catch {
      draftPendingRef.current = true
    }
  }

  useEffect(() => {
    if (firstEditRef.current) {
      firstEditRef.current = false
      return
    }
    setDirty(true)
    if (!remoteUid) return
    draftPendingRef.current = true
    const t = setTimeout(() => void saveDraftNow(), 1500)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instances, remoteUid, session])

  /**
   * What is at stake on the way out, or null when nothing is.
   *
   * The doc is written continuously, so nothing is lost — what is pending is
   * the BAKE: the clip on disk still has the previous zooms (or none).
   */
  const unrenderedReason =
    dirty && !busy
      ? `วางการซูมไว้แล้วแต่ยังไม่ได้กด "บันทึกและเรนเดอร์" — ระบบเก็บไว้ให้ กลับมาแก้ต่อได้ แต่คลิปที่ได้จะยังไม่มีการซูมชุดนี้`
      : null
  const { confirmLeave } = useUnsavedGuard(unrenderedReason, saveDraftNow)

  /** The one way out — flushes the doc, then asks. */
  const requestClose = async (): Promise<void> => {
    await saveDraftNow()
    if (await confirmLeave()) onClose()
  }

  const saveAndRender = (): void => {
    if (!remoteUid) return
    setError(null)
    const doc: EffectsDoc = normalizeEffectsDoc({ version: 1, instances })
    // What was actually submitted, so the completion handler can tell whether
    // the doc still matches it — a bake takes a while and the user can keep
    // editing during it.
    renderedDocRef.current = JSON.stringify(doc.instances)
    void fxJobs.run(project.uid, 'render', 'กำลังใส่การซูมลงวิดีโอ', async (ctx) => {
      await putEffectsDoc(session, remoteUid, doc)
      await renderEffectsDoc(
        {
          session,
          localUid: project.uid,
          remoteUid,
          baseFile,
          project,
          onProgress: ctx.onProgress,
          signal: ctx.signal
        },
        doc
      )
      return null
    })
  }

  /** Move one snapshot from `from` to `to` — undo and ทำซ้ำ are the same
   * operation in opposite directions. Deliberately NOT routed through
   * `pushUndo`, which would clear the other stack. */
  const step = (
    from: EffectInstance[][],
    setFrom: React.Dispatch<React.SetStateAction<EffectInstance[][]>>,
    setTo: React.Dispatch<React.SetStateAction<EffectInstance[][]>>
  ): void => {
    const moved = stepHistory(from, [], instances)
    if (moved.target === null) return
    const target = moved.target
    setFrom(moved.from)
    setTo((s) => pushHistory(s, instances))
    // A fresh gesture after this must snapshot again, not coalesce into the
    // step that was just undone.
    setUndoTag('')
    setViewingBakeFile((v) => {
      if (v) setMediaKey((k) => k + 1)
      return false
    })
    setInstances(target)
    setSelectedId((id) => (target.some((i) => i.id === id) ? id : null))
  }

  const undo = (): void => step(undoStack, setUndoStack, setRedoStack)
  const redo = (): void => step(redoStack, setRedoStack, setUndoStack)

  // ── keyboard ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement | null)?.tagName
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
      // Escape is handled before the typing guard, and closes the AI panel
      // before the editor: the panel's own prompt is a focused textarea, so
      // the guard alone left Escape doing nothing from the one place the user
      // is when they change their mind about the AI run.
      if (e.key === 'Escape' && !busy && aiOpen) {
        setAiOpen(false)
        return
      }
      if (typing) return
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.code === 'KeyZ' && !e.shiftKey) {
        e.preventDefault()
        undo()
        return
      }
      if (mod && (e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey))) {
        e.preventDefault()
        redo()
        return
      }
      if (e.code === 'Space') {
        e.preventDefault()
        togglePlay()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedId) {
          pushUndo(`delete:${selectedId}`)
          setInstances((xs) => xs.filter((i) => i.id !== selectedId))
          setSelectedId(null)
        }
      } else if (e.key === 'Escape' && !busy) {
        if (addOpen || swapOpen) {
          setAddOpen(false)
          setSwapOpen(false)
        } else void requestClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // `undo` / `redo` / `pushUndo` / `requestClose` are plain functions over
    // state, so listing them re-binds the listener on every render — which is
    // the point. They were omitted, and `togglePlay` (the only function that
    // WAS listed) is a useCallback with no deps, so between selection changes
    // this listener kept a closure over stale `instances` / `undoStack` /
    // `redoStack`: Ctrl+Z after a few slider edits called stepHistory with an
    // empty stack and did nothing, while the toolbar's เลิกทำ button — reading
    // the fresh stack — was lit and worked. With a selection change in between
    // it was worse: undo popped a snapshot from several edits back and pushed
    // the stale one onto redo, so the newest state became unreachable.
    // Re-binding one window listener costs nothing next to the state update
    // that already re-rendered the editor.
  }, [
    togglePlay,
    selectedId,
    busy,
    onClose,
    addOpen,
    swapOpen,
    aiOpen,
    undo,
    redo,
    pushUndo,
    requestClose
  ])

  const remove = (id: string): void => {
    pushUndo()
    setInstances((xs) => xs.filter((i) => i.id !== id))
    if (selectedId === id) setSelectedId(null)
  }

  const duplicate = (inst: EffectInstance): void => {
    pushUndo()
    const copy: EffectInstance = {
      ...inst,
      id: newId(),
      startSec: snap(Math.min(effectEndSec(inst), Math.max(0, duration - inst.durationSec))),
      props: { ...inst.props },
      source: 'manual'
    }
    setInstances((xs) => [...xs, copy])
    setSelectedId(copy.id)
  }

  /** The scene (cut-to-cut span) containing time t. */
  const sceneAround = useCallback(
    (t: number): { start: number; end: number } => {
      const bounds = [0, ...cutPoints, duration].sort((a, b) => a - b)
      let start = 0
      let end = duration
      for (const b of bounds) {
        if (b <= t) start = b
        else {
          end = b
          break
        }
      }
      return { start, end: Math.max(end, start + MIN_DUR) }
    },
    [cutPoints, duration]
  )

  const addPreset = (preset: ZoomPreset): void => {
    // Until the <video> reports metadata, `duration` is 0 and every placement
    // below collapses to startSec 0 / MIN_DUR — zooms piled up at 0:00 and
    // drags clamped to nothing (live report 2026-08-13, first open right after
    // a render on a slower machine, where metadata takes seconds: the disk is
    // still busy and the filmstrip is seeking the same file).
    if (duration <= 0) return
    pushUndo()
    let startSec: number
    let durationSec: number
    if (preset.scope === 'scene') {
      const sc = sceneAround(currentTime)
      startSec = sc.start
      durationSec = sc.end - sc.start
    } else if (preset.scope === 'cut') {
      const nearest = cutPoints.length
        ? cutPoints.reduce((a, b) =>
            Math.abs(b - currentTime) < Math.abs(a - currentTime) ? b : a
          )
        : null
      if (nearest === null) return
      durationSec = 0.3
      startSec = Math.max(0, nearest - durationSec / 2)
    } else {
      durationSec = Math.min(PRESET_DEFAULT_SEC, Math.max(MIN_DUR, duration - currentTime))
      startSec = snap(Math.min(currentTime, Math.max(0, duration - durationSec)))
      // Land on the next cut when it is anywhere near the default length: a
      // zoom that runs a beat past the cut plays as a mistake, and stretching
      // it by hand to exactly the boundary is fiddly. Only within 2x default —
      // beyond that the user asked for a short zoom, not a scene-long one.
      const nextCut = cutPoints.filter((c) => c > startSec + MIN_DUR).sort((a, b) => a - b)[0]
      if (nextCut !== undefined && nextCut - startSec <= PRESET_DEFAULT_SEC * 2) {
        durationSec = nextCut - startSec
      }
    }
    const inst: EffectInstance = {
      id: newId(),
      kind: 'transform',
      componentId: preset.componentId,
      startSec: +startSec.toFixed(2),
      durationSec: +durationSec.toFixed(2),
      zOrder: instances.length,
      props: { ...preset.defaults },
      source: 'manual'
    }
    setInstances((xs) => [...xs, inst])
    setSelectedId(inst.id)
    setAddOpen(false)
    const v = videoRef.current
    if (v && (v.currentTime < startSec || v.currentTime > startSec + durationSec)) {
      seekVideo(startSec + Math.min(0.4, durationSec / 2))
    }
  }

  /** เปลี่ยนแบบ: swap the selected instance to another preset, keeping its
   * window and focus point — only the motion character changes. */
  const swapPreset = (inst: EffectInstance, preset: ZoomPreset): void => {
    pushUndo()
    const keepFocus =
      inst.componentId === 'punch-zoom' && preset.componentId === 'punch-zoom'
        ? {
            focusX: num(inst.props.focusX, 0.5),
            focusY: num(inst.props.focusY, 0.5)
          }
        : {}
    if (preset.scope === 'cut') {
      // Becoming a whip-pan re-anchors to the nearest real cut.
      const mid = inst.startSec + inst.durationSec / 2
      const nearest = cutPoints.length
        ? cutPoints.reduce((a, b) => (Math.abs(b - mid) < Math.abs(a - mid) ? b : a))
        : null
      if (nearest === null) return
      patch(inst.id, {
        componentId: preset.componentId,
        startSec: +Math.max(0, nearest - 0.15).toFixed(2),
        durationSec: 0.3,
        props: { ...preset.defaults }
      })
    } else if (preset.scope === 'scene') {
      const sc = sceneAround(inst.startSec + inst.durationSec / 2)
      patch(inst.id, {
        componentId: preset.componentId,
        startSec: +sc.start.toFixed(2),
        durationSec: +(sc.end - sc.start).toFixed(2),
        props: { ...preset.defaults }
      })
    } else {
      patch(inst.id, {
        componentId: preset.componentId,
        props: { ...preset.defaults, ...keepFocus }
      })
    }
    setSwapOpen(false)
  }

  // ── AI whole-clip pass + render + stop ────────────────────────────────────
  const stop = (): void => {
    fxJobs.stop(project.uid)
    // Aborting the JS promise does not touch the ffmpeg the sidecar already
    // spawned — during a bake, "หยุด" used to leave it running to completion
    // and the finished file was then applied as if nothing had been cancelled
    // (the button stayed lit and dead for the rest of the render). This is the
    // only call that actually kills the process tree.
    void window.noey.projects
      .dir(project.uid)
      .then((dir) => window.noey.sidecar.cancel(dir))
      .catch(() => undefined)
    if (remoteUid) {
      import('../lib/videosLocalApi').then(({ cancelRemoteProject }) =>
        cancelRemoteProject(session, remoteUid).catch(() => undefined)
      )
    }
  }

  const runAi = (usePrevious: boolean): void => {
    if (!remoteUid) return
    setError(null)
    setAiOpen(false)
    const prompt = aiPrompt
    const ref = refPath
    const style = styleUid || undefined
    void fxJobs.run(project.uid, 'ai', 'AI กำลังวางการซูม', async (ctx) => {
      // The doc is written on a 1.5s debounce; the server must not reason about
      // a version of effects.json that is one edit behind what is on screen —
      // `แก้จากของเดิม` sends it verbatim as the previous attempt.
      await saveDraftNow()
      const clipDurationsSec = clipDurations ?? (await resolveClipDurationsSec(project))
      const { doc } = await runAiEffects(
        {
          session,
          localUid: project.uid,
          remoteUid,
          baseFile,
          project,
          onProgress: ctx.onProgress,
          onThinking: ctx.onThinking,
          signal: ctx.signal
        },
        prompt,
        buildEffectsScriptText(project),
        ref,
        style,
        buildEffectsCutPoints(project, clipDurationsSec),
        usePrevious
      )
      return doc
    })
  }

  // Pick up whatever finished while this screen was closed (or just now).
  // Deferred out of the effect body: applying it is a fresh update, not part of
  // this render's commit, and doing it synchronously here cascades renders.
  const fxResult = fxJobs.resultFor(project.uid)
  useEffect(() => {
    if (!fxResult) return
    const apply = (): void => {
      if (fxResult.kind === 'ai') {
        const doc = fxResult.value as EffectsDoc
        pushUndo('ai')
        setInstances(doc.instances)
        setRendered(true)
        setViewingBakeFile(false)
        setMediaKey((k) => k + 1)
        seekVideo(doc.instances[0]?.startSec ?? 0)
      } else if (fxResult.kind === 'render') {
        setRendered(true)
        // Only clear "ยังไม่ได้เรนเดอร์" when the doc on screen is still the one
        // that was baked. Editing during the bake used to be wiped off the
        // books by its completion: the leave/close guard went quiet and the
        // clip on disk did not have those edits.
        const now = JSON.stringify(
          normalizeEffectsDoc({ version: 1, instances: instancesRef.current }).instances
        )
        if (now === renderedDocRef.current) {
          setDirty(false)
          setViewingBakeFile(true)
        }
        setMediaKey((k) => k + 1)
      }
      fxJobs.clearResult(project.uid)
    }
    const t = window.setTimeout(apply, 0)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fxResult])

  // Draft autosave — debounced so a drag writes once at the end, not per
  // frame; same PUT the render path uses, so a crash mid-edit loses at most
  // a couple of seconds of work.
  // ── stage frame drag (focus / zoom corner) ─────────────────────────────────
  const beginFrameDrag = (
    e: React.PointerEvent,
    inst: EffectInstance,
    kind: 'frame' | 'frame-b' | 'zoom-corner'
  ): void => {
    e.preventDefault()
    e.stopPropagation()
    selectAndReveal(inst)
    if (kind === 'zoom-corner') {
      const tz =
        inst.componentId === 'scene-drift'
          ? { z: num(inst.props.zoomTo, 1.15), key: 'zoomTo' as const }
          : tightZoom(inst)
      dragRef.current = {
        id: inst.id,
        kind,
        startClientX: e.clientX,
        startClientY: e.clientY,
        origA: tz.z,
        origB: 0,
        origC: 0
      }
    } else {
      const xKey =
        kind === 'frame-b'
          ? 'focusToX'
          : inst.componentId === 'scene-drift'
            ? 'focusFromX'
            : 'focusX'
      const yKey =
        kind === 'frame-b'
          ? 'focusToY'
          : inst.componentId === 'scene-drift'
            ? 'focusFromY'
            : 'focusY'
      dragRef.current = {
        id: inst.id,
        kind,
        startClientX: e.clientX,
        startClientY: e.clientY,
        origA: num(inst.props[xKey], 0.5),
        origB: num(inst.props[yKey], 0.5),
        origC: 0
      }
    }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onStagePointerMove = (e: React.PointerEvent): void => {
    const d = dragRef.current
    const rect = stageRef.current?.getBoundingClientRect()
    if (!d || !rect) return
    const inst = instances.find((i) => i.id === d.id)
    if (!inst) return
    if (d.kind === 'zoom-corner') {
      const delta = (e.clientX - d.startClientX + (e.clientY - d.startClientY)) / rect.width
      const maxZ = inst.componentId === 'scene-drift' ? 1.6 : 4
      const next = Math.min(maxZ, Math.max(1.02, d.origA * (1 + delta * 2.2)))
      if (inst.componentId === 'scene-drift') {
        patchProp(d.id, 'zoomTo', +next.toFixed(2))
      } else {
        patchProp(d.id, tightZoom(inst).key, +next.toFixed(2))
      }
      return
    }
    const isDriftEnd = d.kind === 'frame-b'
    const z =
      inst.componentId === 'scene-drift'
        ? Math.max(1.02, num(inst.props.zoomTo, 1.15))
        : tightZoom(inst).z
    // The frame's travel range shrinks as zoom drops toward 1 — dividing by
    // (1 - 1/z) keeps the drag 1:1 with the frame, not with the raw pointer.
    const span = Math.max(0.05, 1 - 1 / z)
    const nx = Math.min(1, Math.max(0, d.origA + (e.clientX - d.startClientX) / rect.width / span))
    const ny = Math.min(1, Math.max(0, d.origB + (e.clientY - d.startClientY) / rect.height / span))
    if (inst.componentId === 'scene-drift') {
      patchProp(d.id, isDriftEnd ? 'focusToX' : 'focusFromX', +nx.toFixed(3))
      patchProp(d.id, isDriftEnd ? 'focusToY' : 'focusFromY', +ny.toFixed(3))
    } else {
      patchProp(d.id, 'focusX', +nx.toFixed(3))
      patchProp(d.id, 'focusY', +ny.toFixed(3))
      const preset = presetForInstance(inst)
      if (preset?.id !== 'push-drift') {
        // Keep drift target glued to focus for non-drift presets so a later
        // swap to push-drift starts from a sane pair.
        patchProp(d.id, 'driftX', +nx.toFixed(3))
        patchProp(d.id, 'driftY', +ny.toFixed(3))
      }
    }
  }

  // ── lane drag ──────────────────────────────────────────────────────────────
  const [laneW, setLaneW] = useState(640)
  useEffect(() => {
    const el = laneAreaRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setLaneW(el.clientWidth))
    ro.observe(el)
    setLaneW(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  // Fit-to-width (R8: the band never scrolls sideways; a short-form clip fits).
  const pxPerSec = useMemo(
    () => (duration > 0 ? Math.max(4, laneW / duration) : 60),
    [duration, laneW]
  )

  const beginLaneDrag = (
    e: React.PointerEvent,
    inst: EffectInstance,
    kind: 'lane-move' | 'lane-left' | 'lane-right'
  ): void => {
    e.preventDefault()
    e.stopPropagation()
    // See addPreset — resizing against duration 0 clamps into garbage.
    if (duration <= 0) return
    selectAndReveal(inst)
    dragRef.current = {
      id: inst.id,
      kind,
      startClientX: e.clientX,
      startClientY: e.clientY,
      origA: inst.startSec,
      origB: inst.durationSec,
      origC: 0
    }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }

  /** Pull a dragged edge onto a scene cut when it comes within CUT_SNAP_PX.
   *
   * A zoom that ends a few frames off a cut is the single most visible mistake
   * in this editor — the move keeps running into the next shot. Snapping is in
   * SCREEN space, not seconds, so it feels the same at every timeline scale.
   * Falls back to the 0.1s grid when no cut is near. */
  const snapEdge = (t: number): { t: number; cut: number | null } => {
    let best: number | null = null
    let bestPx = CUT_SNAP_PX
    for (const c of cutPoints) {
      const px = Math.abs(c - t) * pxPerSec
      if (px <= bestPx) {
        bestPx = px
        best = c
      }
    }
    return best === null ? { t: snap(t), cut: null } : { t: best, cut: best }
  }

  const onLanePointerMove = (e: React.PointerEvent): void => {
    const d = dragRef.current
    if (d?.kind === 'scrub') {
      scrubAt(e.clientX)
      return
    }
    if (!d || (d.kind !== 'lane-move' && d.kind !== 'lane-left' && d.kind !== 'lane-right')) return
    const deltaSec = (e.clientX - d.startClientX) / pxPerSec
    if (d.kind === 'lane-move') {
      const raw = Math.min(Math.max(0, d.origA + deltaSec), Math.max(0, duration - d.origB))
      // Moving a whole block: either edge may land on a cut, whichever is
      // closer — dragging a zoom so it *starts* at a cut is as common as
      // dragging it so it ends there.
      const head = snapEdge(raw)
      const tail = snapEdge(raw + d.origB)
      const useTail =
        tail.cut !== null &&
        (head.cut === null || Math.abs(tail.t - (raw + d.origB)) < Math.abs(head.t - raw))
      const ns = useTail ? Math.max(0, tail.t - d.origB) : head.t
      setSnappedCut(useTail ? tail.cut : head.cut)
      patch(d.id, { startSec: +ns.toFixed(2) })
    } else if (d.kind === 'lane-right') {
      const rawEnd = Math.min(Math.max(d.origA + MIN_DUR, d.origA + d.origB + deltaSec), duration)
      const { t, cut } = snapEdge(rawEnd)
      setSnappedCut(cut)
      patch(d.id, { durationSec: +Math.max(MIN_DUR, t - d.origA).toFixed(2) })
    } else {
      const end = d.origA + d.origB
      const raw = Math.min(Math.max(0, d.origA + deltaSec), end - MIN_DUR)
      const { t, cut } = snapEdge(raw)
      const ns = Math.min(Math.max(0, t), end - MIN_DUR)
      setSnappedCut(cut)
      patch(d.id, { startSec: +ns.toFixed(2), durationSec: +(end - ns).toFixed(2) })
    }
  }

  const endDrag = (): void => {
    dragRef.current = null
    setSnappedCut(null)
  }

  const scrubAt = (clientX: number): void => {
    const el = laneAreaRef.current
    if (!el || duration <= 0) return
    const rect = el.getBoundingClientRect()
    seekVideo(Math.min(duration, Math.max(0, (clientX - rect.left) / pxPerSec)))
  }

  const onBandPointerDown = (e: React.PointerEvent): void => {
    if ((e.target as HTMLElement).closest('[data-fx-block]')) return
    videoRef.current?.pause()
    dragRef.current = {
      id: '',
      kind: 'scrub',
      startClientX: e.clientX,
      startClientY: e.clientY,
      origA: 0,
      origB: 0,
      origC: 0
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    scrubAt(e.clientX)
  }

  // ── derived ────────────────────────────────────────────────────────────────
  const transformInsts = useMemo(() => instances.filter((i) => i.kind === 'transform'), [instances])
  const legacyInsts = useMemo(() => instances.filter((i) => i.kind === 'overlay'), [instances])
  const zoomTrack = useMemo(
    () => transformInsts.filter((i) => i.componentId !== 'whip-pan'),
    [transformInsts]
  )
  const cutTrack = useMemo(
    () => transformInsts.filter((i) => i.componentId === 'whip-pan'),
    [transformInsts]
  )

  const selected = instances.find((i) => i.id === selectedId) ?? null
  const selectedPreset = selected ? presetForInstance(selected) : undefined

  const filmstrip = useFilmstrip(
    videoSrc,
    duration,
    Math.min(40, Math.max(8, Math.round(duration / 2)))
  )

  /** The gold framing rect is on screen (edit view + a frameable instance).
   *
   * The stage always shows the RAW footage now: the old ก่อน/หลัง switch put a
   * CSS approximation of the zoom on the same frame you drag the gold rect on,
   * so the two views contradicted each other. The real result is one button
   * away — "ดูคลิปสำเร็จ" plays the baked file (2026-08-13). */
  const framingVisible =
    !viewingBakeFile &&
    !!selected &&
    selected.kind === 'transform' &&
    selected.componentId !== 'whip-pan'

  const sceneIndexAt = (t: number): number => {
    let idx = 1
    for (const c of cutPoints) if (t >= c) idx += 1
    return idx
  }

  // Empty state says NOTHING. The toolbar used to carry a line per disabled
  // control plus this one, so an untouched editor opened under five sentences
  // explaining what you could not do yet (live report 2026-09-07). A reason now
  // lives in the control's own tooltip; this line only reports real work.
  const statusText =
    transformInsts.length > 0
      ? `ใส่ไว้ ${transformInsts.length} จุด${dirty || !rendered ? ' · ยังไม่ได้เรนเดอร์' : ' · เรนเดอร์แล้ว'}`
      : ''

  const isEmpty = transformInsts.length === 0 && legacyInsts.length === 0

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-100 flex flex-col bg-ground text-ink">
      <OverlayTitleBarSpacer
        label={`เอฟเฟกต์การซูม — ${project.name}`}
        rightNote={savedAt ? `บันทึกร่างอัตโนมัติ ${savedAt}` : undefined}
      />

      {/* toolbar 56px (R8 §5) */}
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-divider px-5">
        <Button variant="ghost" icon={<ArrowLeft size={16} />} onClick={() => void requestClose()}>
          กลับไปที่โปรเจกต์
        </Button>
        <span className="h-5 w-px bg-divider" />
        {undoDepth > 0 ? (
          <Button icon={<Undo2 size={15} />} onClick={undo}>
            เลิกทำ
          </Button>
        ) : (
          <Button
            icon={<Undo2 size={15} />}
            disabled
            reasonAs="tooltip"
            disabledReason="ยังไม่มีอะไรให้ย้อน"
          >
            เลิกทำ
          </Button>
        )}
        {redoDepth > 0 ? (
          <Button icon={<Redo2 size={15} />} onClick={redo}>
            ทำซ้ำ
          </Button>
        ) : (
          <Button
            icon={<Redo2 size={15} />}
            disabled
            reasonAs="tooltip"
            disabledReason="ยังไม่มีอะไรให้ทำซ้ำ"
          >
            ทำซ้ำ
          </Button>
        )}
        <p className="min-w-0 flex-1 truncate text-sm tabular-nums text-muted">{statusText}</p>

        {busy ? (
          <>
            <StatusLine status="working" label={progress || 'กำลังทำงาน…'} />
            <Button variant="danger" icon={<Square size={14} fill="currentColor" />} onClick={stop}>
              หยุด
            </Button>
          </>
        ) : (
          <>
            {rendered ? (
              <Button
                icon={<Film size={16} />}
                onClick={() => {
                  setViewingBakeFile((v) => !v)
                  setMediaKey((k) => k + 1)
                }}
              >
                {viewingBakeFile ? 'กลับไปแก้ไข' : 'ดูคลิปสำเร็จ'}
              </Button>
            ) : (
              <Button
                icon={<Film size={16} />}
                disabled
                reasonAs="tooltip"
                disabledReason="ต้องเรนเดอร์ก่อนถึงจะดูได้"
              >
                ดูคลิปสำเร็จ
              </Button>
            )}
            {remoteUid ? (
              <Button icon={<Sparkles size={16} />} onClick={() => setAiOpen((o) => !o)}>
                ให้ AI จัดทั้งคลิป
              </Button>
            ) : (
              <Button
                icon={<Sparkles size={16} />}
                disabled
                reasonAs="tooltip"
                disabledReason="ต้องอัปโหลดคลิปขึ้น server ก่อน"
              >
                ให้ AI จัดทั้งคลิป
              </Button>
            )}
            {/* `|| rendered`: a doc that went N zooms -> 0 must still be
                renderable. The autosave unlinks the stale bake on its own, but
                if that ever fails this is the way back — baking an empty doc is
                a flat re-encode of the base, which is correct, just slow. */}
            {remoteUid && (transformInsts.length > 0 || rendered) ? (
              <Button
                variant="primary"
                icon={<Save size={16} />}
                onClick={() => void saveAndRender()}
              >
                บันทึกและเรนเดอร์
              </Button>
            ) : (
              <Button
                variant="primary"
                icon={<Save size={16} />}
                disabled
                reasonAs="tooltip"
                disabledReason={
                  remoteUid ? 'ยังไม่มีการซูมให้เรนเดอร์' : 'ต้องอัปโหลดคลิปขึ้น server ก่อน'
                }
              >
                บันทึกและเรนเดอร์
              </Button>
            )}
          </>
        )}
      </div>

      {/* AI bar (R8 §ง): saved zoom style + one-off note + one attach chip */}
      {aiOpen && !busy && (
        <div className="border-b border-divider bg-surface px-6 py-3.5">
          <div className="mx-auto flex max-w-2xl flex-col gap-2.5">
            {/* Changing your mind has to be one click, and it has to be visible
                from INSIDE the panel: the toolbar button that opened it toggles,
                but from the empty-state card there was no way back at all
                (live report 2026-08-13: "มันปิดไม่ได้"). */}
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold text-ink">ให้ AI จัดการซูมทั้งคลิป</p>
              <button
                type="button"
                onClick={() => setAiOpen(false)}
                aria-label="ปิดแผงให้ AI จัดคลิป"
                className="rounded-sm p-1 text-muted hover:bg-[rgb(243_242_242_/_0.06)] hover:text-ink"
              >
                <X size={15} />
              </button>
            </div>
            {/* '' is not "no zoom" here — pressing เริ่มเลย always places
                zooms; it means the AI uses its own judgment. Labelling it as an
                empty slot made the list read as "my styles are missing". */}
            <Select
              label="สไตล์การซูม"
              value={styleUid}
              onValueChange={setStyleUid}
              options={[
                { value: '', label: 'สไตล์เริ่มต้น (ระบบ)' },
                ...styles.map((st) => ({ value: st.uid, label: st.name }))
              ]}
            />
            {styles.length === 0 ? (
              <p className="text-[13px] leading-[1.6] text-muted">
                {legacyStyleCount > 0
                  ? `มีสไตล์ที่บันทึกไว้ ${legacyStyleCount} อัน แต่เป็นของระบบเอฟเฟกต์เดิม — ต้องให้ AI เรียนรู้ใหม่ในหน้าสไตล์ก่อนถึงจะเลือกได้`
                  : 'ยังไม่มีสไตล์ของตัวเอง — สร้างได้ในหน้าสไตล์ แล้วจะขึ้นให้เลือกตรงนี้'}
              </p>
            ) : null}
            <Textarea
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              rows={2}
              autoFocus
              aria-label="บอกเพิ่มเฉพาะคลิปนี้"
              placeholder="บอกเพิ่มได้ว่าคลิปนี้อยากให้ซูมต่างจากสไตล์ตรงไหน (เว้นว่างได้) — การซูมชุดเดิมจะถูกแทนที่ทั้งหมด"
            />
            <div className="flex flex-wrap items-center gap-2">
              {refPath ? (
                <Chip dense selected onClick={() => setRefPath(undefined)}>
                  <Film size={12} className="mr-1.5" />
                  {refPath.split(/[\\/]/).pop()}
                  <X size={12} className="ml-1.5" />
                </Chip>
              ) : (
                <Chip
                  dense
                  onClick={() =>
                    void pickFile('video/*,image/*').then((f) => {
                      if (f) setRefPath(f.path)
                    })
                  }
                >
                  <Paperclip size={12} className="mr-1.5" /> แนบคลิปตัวอย่างเฉพาะครั้งนี้
                </Chip>
              )}
              <span className="flex-1" />
              <Button variant="ghost" onClick={() => setAiOpen(false)}>
                ยกเลิก
              </Button>
              {transformInsts.length > 0 && (
                <Button onClick={() => void runAi(true)}>แก้จากของเดิม</Button>
              )}
              <Button variant="primary" onClick={() => void runAi(false)}>
                เริ่มเลย
              </Button>
            </div>
          </div>
        </div>
      )}
      {thinking && busy && (
        <div className="scroll-ghost max-h-20 overflow-y-auto border-b border-divider bg-surface px-6 py-2 font-mono text-[13px] leading-relaxed whitespace-pre-wrap text-muted">
          {thinking}
        </div>
      )}
      {error && <p className="mx-6 mt-2 text-sm text-error">{error}</p>}

      {/* stage + right rail */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col px-5 pt-4">
          <div className="flex min-h-0 flex-1 items-center justify-center gap-5">
            {/* video 272×484 (R8) with the framing overlay — same player
                chrome as every other preview surface (ui/VideoPlayer). */}
            <VideoPlayer
              videoRef={videoRef}
              mediaKey={mediaKey}
              src={videoSrc}
              preload="auto"
              className="aspect-[9/16] h-full max-h-[484px] shrink-0 rounded-md bg-black"
              onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
              onPointerMove={onStagePointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              <div ref={stageRef} className="absolute inset-0" style={{ pointerEvents: 'none' }}>
                {/* children re-enable pointer events individually — the layer
                    itself must not swallow clicks meant for the video. */}
                {framingVisible && selected && (
                  <div className="pointer-events-auto absolute inset-0">
                    <FramingOverlay inst={selected} onBegin={beginFrameDrag} />
                  </div>
                )}
              </div>
            </VideoPlayer>

            {/* side hint / empty-state card (R8 §ค) */}
            {isEmpty && !busy ? (
              <div className="w-[250px]">
                <p className="text-[19px] font-semibold text-ink">คลิปนี้ยังไม่มีการซูม</p>
                <p className="mt-1.5 mb-4 text-sm leading-[1.65] text-muted">
                  เลื่อนหัวเล่นไปตรงที่อยากให้ภาพซูม แล้วเลือกแบบที่ต้องการ
                </p>
                {/* A preset addPreset would silently drop is not offered as a
                    live button: `cut`-scoped ones need real cut points, and
                    nothing can be placed before the video reports its length
                    (both used to look clickable and do nothing at all). */}
                <div className="mb-4 flex flex-wrap gap-1.5">
                  {ZOOM_PRESETS.map((p) => {
                    const blocked =
                      duration <= 0
                        ? 'กำลังโหลดวิดีโอ…'
                        : p.scope === 'cut' && cutPoints.length === 0
                          ? 'คลิปนี้ไม่มีข้อมูลรอยต่อฉาก'
                          : null
                    return blocked ? (
                      <Chip key={p.id} dense disabled disabledReason={blocked}>
                        {p.title}
                      </Chip>
                    ) : (
                      <Chip key={p.id} dense onClick={() => addPreset(p)}>
                        {p.title}
                      </Chip>
                    )
                  })}
                </div>
                {remoteUid && (
                  <Button
                    variant="primary"
                    icon={<Sparkles size={15} />}
                    onClick={() => setAiOpen(true)}
                  >
                    ให้ AI จัดทั้งคลิป
                  </Button>
                )}
              </div>
            ) : framingVisible ? (
              // Only while the gold frame is actually up — a permanent
              // explanation of a control that isn't on screen is just noise.
              <div className="w-[172px] text-[13px] leading-[1.75] text-muted">
                <p className="mb-2.5 text-sm font-semibold text-ink-3">
                  กรอบทองคือสิ่งที่กล้องเห็น
                </p>
                <p>
                  ลากกรอบเพื่อเลือกจุดโฟกัส ลากมุมเพื่อเปลี่ยนระยะซูม
                  เครื่องหมายกากบาทคือจุดที่ภาพจะวิ่งเข้าไป
                </p>
              </div>
            ) : null}
          </div>

          {/* ── timeline band (R8: ruler 22 · ภาพ 40 · ซูม 34 · รอยต่อ 22) ── */}
          <div className="mt-3.5 shrink-0 border-t border-divider pt-3 pb-3">
            <div className="mb-2.5 flex items-center gap-2.5">
              <div className="relative" data-fx-popover>
                {duration > 0 ? (
                  <Button
                    size="sm"
                    variant="primary"
                    icon={<Plus size={14} />}
                    onClick={() => setAddOpen((o) => !o)}
                  >
                    เพิ่มเอฟเฟกต์การซูม
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="primary"
                    icon={<Plus size={14} />}
                    disabled
                    disabledReason="กำลังโหลดวิดีโอ…"
                  >
                    เพิ่มเอฟเฟกต์การซูม
                  </Button>
                )}
                {addOpen && duration > 0 && (
                  <PresetPicker hasCuts={cutPoints.length > 0} onPick={addPreset} />
                )}
              </div>
              <span className="flex-1" />
              <span className="text-[13px] text-muted">
                ลากบล็อกเพื่อเลื่อน · ลากขอบเพื่อยืด–หดช่วง
              </span>
            </div>

            <div className="flex">
              {/* header column 92px */}
              <div className="shrink-0" style={{ width: HEADER_COL_PX }}>
                <div style={{ height: RULER_PX }} />
                <div
                  className="flex items-center text-[13px] text-ink-3"
                  style={{ height: TRACK_FILM_PX, marginTop: TRACK_GAP_PX }}
                >
                  ภาพ&nbsp;<span className="text-muted tabular-nums">{project.clips.length}</span>
                </div>
                <div
                  className="flex items-center text-[13px] text-ink-3"
                  style={{ height: TRACK_ZOOM_PX, marginTop: TRACK_GAP_PX }}
                >
                  ซูม&nbsp;<span className="text-muted tabular-nums">{zoomTrack.length}</span>
                </div>
                <div
                  className="flex items-center text-[13px] text-ink-3"
                  style={{ height: TRACK_CUT_PX, marginTop: TRACK_GAP_PX }}
                >
                  รอยต่อ&nbsp;<span className="text-muted tabular-nums">{cutTrack.length}</span>
                </div>
              </div>

              {/* tracks */}
              <div
                ref={laneAreaRef}
                className="relative min-w-0 flex-1 cursor-crosshair select-none"
                onPointerDown={onBandPointerDown}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onPointerMove={onLanePointerMove}
              >
                {/* ruler */}
                <div className="relative border-b border-border-faint" style={{ height: RULER_PX }}>
                  {duration > 0 &&
                    (() => {
                      // Adaptive step: the band is fit-to-width, so a long clip
                      // gets few px per second — 5s labels would collide.
                      const step = rulerStepSec(pxPerSec)
                      const count = Math.floor(duration / step) + 1
                      return Array.from({ length: count }, (_, i) => i * step)
                    })().map((sec) => (
                      <span
                        key={sec}
                        className="absolute bottom-0"
                        style={{ left: sec * pxPerSec }}
                      >
                        <span className="absolute bottom-0 h-2 w-px bg-[rgb(243_242_242_/_0.28)]" />
                        <span className="absolute bottom-[9px] left-0.5 text-[13px] tabular-nums text-muted">
                          {fmtTime(sec)}
                        </span>
                      </span>
                    ))}
                </div>

                {/* ภาพ track — filmstrip */}
                <div
                  className="relative flex overflow-hidden rounded-[3px] bg-black"
                  style={{ height: TRACK_FILM_PX, marginTop: TRACK_GAP_PX }}
                >
                  {filmstrip.map((tile) => (
                    <img
                      key={tile.atSec}
                      src={tile.url}
                      alt=""
                      draggable={false}
                      className="h-full shrink-0 object-cover"
                      style={{ width: (duration * pxPerSec) / Math.max(1, filmstrip.length) }}
                    />
                  ))}
                  {/* scene boundaries over the footage */}
                  {cutPoints.map((c) => (
                    <span
                      key={c}
                      className="absolute top-0 bottom-0 w-px bg-[rgb(243_242_242_/_0.35)]"
                      style={{ left: c * pxPerSec }}
                    />
                  ))}
                </div>

                {/* ซูม track */}
                <div
                  className="relative rounded-[3px] bg-[rgb(243_242_242_/_0.04)]"
                  style={{ height: TRACK_ZOOM_PX, marginTop: TRACK_GAP_PX }}
                >
                  {/* Scene cuts continued down into this lane — read-only
                      guides. Without them you are eyeballing where a zoom has
                      to end against a line drawn one track above it. The one
                      being snapped to lights up (see snappedCut). */}
                  {cutPoints.map((c) => {
                    const on = snappedCut !== null && Math.abs(c - snappedCut) < 1e-6
                    return (
                      <span
                        key={c}
                        className={cn(
                          'pointer-events-none absolute top-0 bottom-0 z-0',
                          on ? 'w-px bg-accent' : 'w-px bg-[rgb(243_242_242_/_0.16)]'
                        )}
                        style={{ left: c * pxPerSec }}
                      />
                    )
                  })}
                  {zoomTrack.map((inst) => {
                    const isSel = inst.id === selectedId
                    return (
                      <div
                        key={inst.id}
                        data-fx-block
                        onPointerDown={(e) => beginLaneDrag(e, inst, 'lane-move')}
                        className={cn(
                          'absolute top-0 bottom-0 flex cursor-grab items-center overflow-hidden rounded-[3px] border px-2 text-[13px] whitespace-nowrap transition-colors duration-state ease-out active:cursor-grabbing',
                          isSel
                            ? 'border-accent bg-[rgb(217_164_65_/_0.22)] font-semibold text-ink'
                            : 'border-[rgb(217_164_65_/_0.45)] bg-[rgb(217_164_65_/_0.14)] text-[#e4e2df]'
                        )}
                        style={{
                          left: inst.startSec * pxPerSec,
                          width: Math.max(16, inst.durationSec * pxPerSec),
                          touchAction: 'none'
                        }}
                      >
                        {isSel && (
                          <>
                            <span
                              data-fx-block
                              onPointerDown={(e) => beginLaneDrag(e, inst, 'lane-left')}
                              className="absolute top-0 bottom-0 left-0 w-1.5 cursor-ew-resize rounded-l-[3px] bg-accent"
                              style={{ touchAction: 'none' }}
                            />
                            <span
                              data-fx-block
                              onPointerDown={(e) => beginLaneDrag(e, inst, 'lane-right')}
                              className="absolute top-0 bottom-0 right-0 w-1.5 cursor-ew-resize rounded-r-[3px] bg-accent"
                              style={{ touchAction: 'none' }}
                            />
                          </>
                        )}
                        {/* A block only a couple of seconds wide fits three
                            glyphs — "ซู…" reads as a glitch, so short blocks
                            carry the name in the tooltip instead. */}
                        <span
                          className={cn('truncate', isSel && 'ml-1.5')}
                          title={instanceTitle(inst)}
                        >
                          {inst.durationSec * pxPerSec >= 54 ? instanceTitle(inst) : ''}
                        </span>
                      </div>
                    )
                  })}
                </div>

                {/* รอยต่อ track — diamonds, not blocks */}
                <div className="relative" style={{ height: TRACK_CUT_PX, marginTop: TRACK_GAP_PX }}>
                  <span className="absolute inset-x-0 top-1/2 h-px bg-[rgb(243_242_242_/_0.1)]" />
                  {cutTrack.map((inst) => {
                    const at = inst.startSec + inst.durationSec / 2
                    const isSel = inst.id === selectedId
                    return (
                      <button
                        key={inst.id}
                        type="button"
                        data-fx-block
                        onClick={() => selectAndReveal(inst)}
                        title="ปัดเปลี่ยนฉาก"
                        className="absolute top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 p-1.5"
                        style={{ left: at * pxPerSec }}
                      >
                        <span
                          className={cn(
                            'block h-[11px] w-[11px] rotate-45',
                            isSel ? 'bg-ink' : 'bg-accent'
                          )}
                        />
                      </button>
                    )
                  })}
                </div>

                {/* playhead — full-height grab strip over a 2px rule */}
                {duration > 0 && (
                  <div
                    className="pointer-events-none absolute top-0 bottom-0 z-20"
                    style={{ left: currentTime * pxPerSec }}
                  >
                    <span className="absolute top-0 bottom-0 left-1/2 w-0.5 -translate-x-1/2 bg-ink" />
                    <span className="absolute top-0 left-1/2 h-3 w-[18px] -translate-x-1/2 rounded-[2px_2px_4px_4px] bg-ink" />
                  </div>
                )}
              </div>
            </div>

            {/* leftover overlay instances from the removed system */}
            {legacyInsts.length > 0 && (
              <div className="mt-2.5 space-y-1.5">
                {legacyInsts.map((inst) => (
                  <div
                    key={inst.id}
                    className="flex items-center gap-3 rounded-md border border-divider px-3 py-2 text-sm text-muted"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      เอฟเฟกต์เดิม (ไม่รองรับแล้ว) — {inst.componentId} ·{' '}
                      {fmtTimeTenths(inst.startSec)}
                    </span>
                    <button
                      type="button"
                      onClick={() => remove(inst.id)}
                      className="shrink-0 text-error transition-colors duration-state ease-out hover:opacity-80"
                      aria-label="ลบเอฟเฟกต์เดิม"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── right rail 340px (R8 §5) ─────────────────────────────────────── */}
        <aside className="flex shrink-0 flex-col border-l border-divider" style={{ width: RAIL_W }}>
          {selected && selected.kind === 'transform' ? (
            <>
              <div className="border-b border-divider px-5 pt-4 pb-3.5">
                <p className="mb-1 text-sm text-muted">เอฟเฟกต์ที่เลือก</p>
                <div className="relative flex items-center justify-between gap-2.5">
                  <p className="min-w-0 truncate text-[17px] font-semibold text-ink">
                    {instanceTitle(selected)}
                  </p>
                  <button
                    type="button"
                    data-fx-popover
                    onClick={() => setSwapOpen((o) => !o)}
                    className="shrink-0 text-[13px] text-accent underline underline-offset-2 transition-colors duration-state ease-out hover:text-accent-hover-text"
                  >
                    เปลี่ยนแบบ
                  </button>
                  {swapOpen && (
                    <div className="absolute top-full right-0 z-30" data-fx-popover>
                      <PresetPicker
                        hasCuts={cutPoints.length > 0}
                        onPick={(p) => swapPreset(selected, p)}
                      />
                    </div>
                  )}
                </div>
                <p className="mt-1.5 text-[13px] leading-[1.55] text-muted">
                  {selectedPreset?.hint ?? ''}
                </p>
              </div>

              <div className="scroll-ghost min-h-0 flex-1 space-y-[18px] overflow-y-auto px-5 py-4">
                {/* ช่วงเวลา */}
                <div>
                  <p className="mb-2 text-sm text-muted">
                    {selected.componentId === 'whip-pan' ? 'จุดที่ปัด' : 'ช่วงเวลา'}
                  </p>
                  {selected.componentId === 'whip-pan' ? (
                    <p className="text-[15px] tabular-nums text-ink-2">
                      {fmtTimeTenths(selected.startSec + selected.durationSec / 2)}
                      <span className="ml-2 text-sm text-muted">
                        อยู่บนรอยต่อฉากจริง เลื่อนไม่ได้
                      </span>
                    </p>
                  ) : (
                    <>
                      <div className="flex items-center gap-2">
                        <TimecodeField
                          value={selected.startSec}
                          ariaLabel="เวลาเริ่ม"
                          onCommit={(sec) => {
                            const end = effectEndSec(selected)
                            const ns = Math.min(Math.max(0, sec), end - MIN_DUR)
                            patch(selected.id, {
                              startSec: +ns.toFixed(2),
                              durationSec: +(end - ns).toFixed(2)
                            })
                          }}
                        />
                        <span className="shrink-0 text-sm text-muted">ถึง</span>
                        <TimecodeField
                          value={effectEndSec(selected)}
                          ariaLabel="เวลาจบ"
                          onCommit={(sec) => {
                            const ne = Math.min(
                              Math.max(sec, selected.startSec + MIN_DUR),
                              duration
                            )
                            patch(selected.id, {
                              durationSec: +(ne - selected.startSec).toFixed(2)
                            })
                          }}
                        />
                      </div>
                      <p className="mt-1.5 text-[13px] tabular-nums text-muted">
                        ยาว {selected.durationSec.toFixed(1)} วินาที · อยู่ในฉากที่{' '}
                        {sceneIndexAt(selected.startSec)}
                      </p>
                    </>
                  )}
                </div>

                {/* per-kind controls */}
                {selected.componentId === 'whip-pan' ? (
                  <>
                    <div className="border-t border-divider pt-4">
                      <p className="mb-2 text-sm text-ink-3">ทิศทาง</p>
                      <div className="flex gap-1.5">
                        {(
                          [
                            ['horizontal', 'ปัดซ้าย–ขวา'],
                            ['vertical', 'ปัดขึ้น–ลง']
                          ] as const
                        ).map(([v, lbl]) => (
                          <Chip
                            key={v}
                            dense
                            selected={String(selected.props.direction ?? 'horizontal') === v}
                            onClick={() => patchProp(selected.id, 'direction', v)}
                          >
                            {lbl}
                          </Chip>
                        ))}
                      </div>
                    </div>
                    <Slider
                      label="ความแรง"
                      value={num(selected.props.intensity, 0.6)}
                      min={0.2}
                      max={1}
                      step={0.05}
                      formatValue={(v) => v.toFixed(2)}
                      onChange={(v) => patchProp(selected.id, 'intensity', v)}
                    />
                  </>
                ) : selected.componentId === 'scene-drift' ? (
                  <>
                    <div className="border-t border-divider pt-4">
                      <Slider
                        label="ซูมปลายฉาก"
                        value={num(selected.props.zoomTo, 1.15)}
                        min={1}
                        max={1.6}
                        step={0.01}
                        formatValue={(v) => `${v.toFixed(2)}×`}
                        onChange={(v) => patchProp(selected.id, 'zoomTo', v)}
                      />
                    </div>
                    <Slider
                      label="ซูมต้นฉาก"
                      value={num(selected.props.zoomFrom, 1)}
                      min={1}
                      max={1.6}
                      step={0.01}
                      formatValue={(v) => `${v.toFixed(2)}×`}
                      onChange={(v) => patchProp(selected.id, 'zoomFrom', v)}
                    />
                    <div>
                      <div className="mb-1.5 flex items-baseline justify-between">
                        <span className="text-sm text-ink-3">เฟรมเริ่ม → เฟรมจบ</span>
                        <span className="text-[13px] tabular-nums text-muted">
                          {num(selected.props.focusFromX, 0.5).toFixed(2)},
                          {num(selected.props.focusFromY, 0.5).toFixed(2)} →{' '}
                          {num(selected.props.focusToX, 0.5).toFixed(2)},
                          {num(selected.props.focusToY, 0.5).toFixed(2)}
                        </span>
                      </div>
                      <p className="text-[13px] leading-[1.55] text-muted">
                        ลากกรอบทั้งสองบนภาพเพื่อกำหนดว่ากล้องเริ่มและจบตรงไหน
                      </p>
                    </div>
                  </>
                ) : (
                  (() => {
                    const preset = selectedPreset
                    const tz = tightZoom(selected)
                    const rampReason = inertPropReason(preset, 'rampSec')
                    const holdReason = inertPropReason(preset, 'hold')
                    return (
                      <>
                        <div className="border-t border-divider pt-4">
                          <Slider
                            label="ซูมสุด"
                            value={tz.z}
                            min={1}
                            max={4}
                            step={0.05}
                            formatValue={(v) => `${v.toFixed(1)}×`}
                            onChange={(v) => patchProp(selected.id, tz.key, v)}
                          />
                        </div>

                        <div>
                          <div className="mb-1.5 flex items-baseline justify-between">
                            <span className="text-sm text-ink-3">จุดโฟกัส</span>
                            <span className="text-[13px] tabular-nums text-muted">
                              X {num(selected.props.focusX, 0.5).toFixed(2)} · Y{' '}
                              {num(selected.props.focusY, 0.5).toFixed(2)}
                            </span>
                          </div>
                          {/* The gold rect is hidden while the baked file is on
                              screen — pointing at a control that is not there
                              sends the user hunting for it. */}
                          {framingVisible ? (
                            <p className="text-[13px] leading-[1.55] text-muted">
                              ลากกรอบทองบนภาพเพื่อเปลี่ยน
                            </p>
                          ) : (
                            <p className="text-[13px] leading-[1.55] text-muted">
                              กลับมาที่คลิปสำหรับแก้ไขก่อนถึงจะลากกรอบทองได้
                            </p>
                          )}
                        </div>

                        {preset?.id === 'push-drift' && (
                          <div>
                            <div className="mb-1.5 flex items-baseline justify-between">
                              <span className="text-sm text-ink-3">เลื่อนกล้องไปที่</span>
                              <span className="text-[13px] tabular-nums text-muted">
                                X {num(selected.props.driftX, 0.5).toFixed(2)} · Y{' '}
                                {num(selected.props.driftY, 0.5).toFixed(2)}
                              </span>
                            </div>
                            <div className="flex gap-4">
                              <Slider
                                className="flex-1"
                                value={num(selected.props.driftX, 0.5)}
                                min={0}
                                max={1}
                                step={0.01}
                                formatValue={(v) => v.toFixed(2)}
                                onChange={(v) => patchProp(selected.id, 'driftX', v)}
                              />
                              <Slider
                                className="flex-1"
                                value={num(selected.props.driftY, 0.5)}
                                min={0}
                                max={1}
                                step={0.01}
                                formatValue={(v) => v.toFixed(2)}
                                onChange={(v) => patchProp(selected.id, 'driftY', v)}
                              />
                            </div>
                          </div>
                        )}

                        {/* ค้างซูม — value muted with a reason when the preset fixes it
                            (never opacity over the whole group, R8 §5) */}
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className={cn('text-sm', holdReason ? 'text-muted' : 'text-ink-3')}>
                              ค้างซูมไว้จนจบช่วง
                            </p>
                            <p className="mt-0.5 text-[13px] leading-[1.5] text-muted">
                              {holdReason ?? 'ปิดแล้วภาพจะคลายกลับเอง'}
                            </p>
                          </div>
                          {holdReason ? (
                            <Switch
                              checked
                              onChange={() => undefined}
                              disabled
                              disabledReason={holdReason}
                            />
                          ) : (
                            <Switch
                              checked={String(selected.props.hold) !== 'false'}
                              onChange={(on) =>
                                patchProp(selected.id, 'hold', on ? 'true' : 'false')
                              }
                            />
                          )}
                        </div>

                        {/* เวลาซูม */}
                        {rampReason ? (
                          <div>
                            <div className="mb-2 flex items-baseline justify-between">
                              <span className="text-sm text-muted">เวลาซูม</span>
                              <span className="text-sm text-muted">—</span>
                            </div>
                            <div className="h-[3px] rounded-full bg-[rgb(243_242_242_/_0.14)]" />
                            <p className="mt-2 text-[13px] leading-[1.55] text-muted">
                              {rampReason}
                            </p>
                          </div>
                        ) : (
                          <Slider
                            label="เวลาซูม"
                            value={num(selected.props.rampSec, 1)}
                            min={0.3}
                            max={2.5}
                            step={0.1}
                            formatValue={(v) => `${v.toFixed(1)} วิ`}
                            onChange={(v) => patchProp(selected.id, 'rampSec', v)}
                          />
                        )}
                      </>
                    )
                  })()
                )}
              </div>

              <div className="flex shrink-0 gap-2 border-t border-divider px-5 py-3.5">
                <Button
                  className="flex-1 justify-center"
                  icon={<Copy size={14} />}
                  onClick={() => duplicate(selected)}
                >
                  ทำซ้ำ
                </Button>
                <Button
                  className="flex-1 justify-center"
                  variant="danger"
                  icon={<Trash2 size={14} />}
                  onClick={() => remove(selected.id)}
                >
                  ลบออก
                </Button>
              </div>
            </>
          ) : selected ? (
            /* legacy overlay selected */
            <div className="flex flex-1 flex-col px-5 py-4">
              <p className="text-sm text-muted">เอฟเฟกต์ที่เลือก</p>
              <p className="mt-1 text-[17px] font-semibold text-ink">
                เอฟเฟกต์เดิม (ไม่รองรับแล้ว)
              </p>
              <p className="mt-2 text-sm leading-[1.65] text-muted">
                เอฟเฟกต์ชนิดนี้มาจากระบบเดิมที่ถูกถอดออกแล้ว แสดงไว้เพื่อให้ลบได้เท่านั้น —
                จะไม่ถูกเรนเดอร์ลงวิดีโอ
              </p>
              <span className="flex-1" />
              <Button
                variant="danger"
                className="w-full justify-center"
                icon={<Trash2 size={14} />}
                onClick={() => remove(selected.id)}
              >
                ลบออก
              </Button>
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-sm leading-[1.7] text-muted">
              เลือกการซูมบนแถบเวลา หรือกด “เพิ่มเอฟเฟกต์การซูม” เพื่อเริ่ม
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}
