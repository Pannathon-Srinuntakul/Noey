import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, HelpCircle, Layers, Loader2, Pause, Play, Plus, Redo2, Save, Trash2, Undo2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, type EditCut, type EditTimeline } from '../api'
import { formatUserError } from '../errors'

const PX_PER_SEC = 36
const MIN_CUT_SEC = 0.2
const DEFAULT_NEW_CUT_SEC = 2

interface Props {
  uid: string
  mode: string
  onClose: () => void
  /** Called after a successful save — caller should re-poll project status. */
  onSaved: () => void
}

type WorkingCut = EditCut

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function cutLineId(c: EditCut): number {
  if (c.voiceoverLineId != null && c.voiceoverLineId > 0) return c.voiceoverLineId
  const parsed = parseInt(String(c.label || ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function normalizeDubCuts(cuts: EditCut[]): EditCut[] {
  return cuts.map((c, i) => ({
    ...c,
    voiceoverLineId: c.voiceoverLineId ?? (cutLineId(c) || i + 1),
  }))
}

function nextVoiceoverLineId(cuts: EditCut[]): number {
  const ids = cuts.map(cutLineId).filter((id) => id > 0)
  return ids.length ? Math.max(...ids) + 1 : 1
}

function cutsInLine(cuts: EditCut[], lineId: number): EditCut[] {
  return cuts.filter((c) => cutLineId(c) === lineId)
}

function lineScriptFor(cuts: EditCut[], lineId: number): string {
  return cutsInLine(cuts, lineId).find((c) => c.voiceoverScript?.trim())?.voiceoverScript?.trim() ?? ''
}

function cutIndexInLine(cuts: EditCut[], cut: EditCut): number {
  const idx = cutsInLine(cuts, cutLineId(cut)).findIndex((c) => c.id === cut.id)
  return idx >= 0 ? idx + 1 : 1
}

function countVoiceoverLines(cuts: EditCut[]): number {
  return new Set(cuts.map(cutLineId).filter((id) => id > 0)).size
}

interface EditedSegment {
  cut: EditCut
  editedIn: number
  editedOut: number
}

interface ViewModePlaybackState {
  currentTime: number
  selectedId: string | null
  previewSource: string | null
  editedActiveCutId: string | null
  playRange: { in: number; out: number } | null
  wasPlaying: boolean
}

/** Map cuts onto one continuous "edited" timeline — strict back-to-back, no overlap. */
function computeEditedSegments(cuts: EditCut[]): EditedSegment[] {
  let acc = 0
  return cuts.map((c) => {
    const dur = Math.max(c.out - c.in, 0)
    const seg: EditedSegment = { cut: c, editedIn: acc, editedOut: acc + dur }
    acc += dur
    return seg
  })
}

function computeEditedDuration(cuts: EditCut[]): number {
  return cuts.reduce((sum, c) => sum + Math.max(c.out - c.in, 0), 0)
}

/** Find which cut a position on the concatenated edited timeline falls into. */
function findEditedSegment(cuts: EditCut[], t: number): EditedSegment | null {
  const segs = computeEditedSegments(cuts)
  if (segs.length === 0) return null
  for (const seg of segs) {
    if (t < seg.editedOut - 0.001) return seg
  }
  return segs[segs.length - 1]
}

/** Find which cut on a source lane contains timeline-local time `t`. */
function findSourceCutAtTime(cuts: EditCut[], sourceId: string | null, t: number): EditCut | null {
  if (!sourceId) return null
  for (const c of cuts) {
    if (c.source !== sourceId) continue
    if (t >= c.in - 0.001 && t < c.out + 0.001) return c
  }
  return null
}

/** Prevent cuts on the same source lane from overlapping each other. */
function sourceNeighborBounds(
  cut: EditCut,
  sourceCuts: EditCut[],
  laneDurationSec: number,
): { minIn: number; maxOut: number } {
  const sorted = [...sourceCuts].sort((a, b) => a.in - b.in || a.out - b.out)
  const idx = sorted.findIndex((c) => c.id === cut.id)
  const prev = idx > 0 ? sorted[idx - 1] : null
  const next = idx >= 0 && idx < sorted.length - 1 ? sorted[idx + 1] : null
  return {
    minIn: prev ? prev.out : 0,
    maxOut: next ? next.in : laneDurationSec,
  }
}

const LANE_HEIGHT_PX = 64
/** Fixed bands below the video preview — video gets all remaining height. */
const EDITOR_TIMELINE_BAND_PX = 112
const EDITOR_SCENE_BAND_PX = 96
const EDITOR_SCRIPT_BAND_PX = 128

const IS_MAC = typeof navigator !== 'undefined'
  && (navigator.platform.includes('Mac') || navigator.userAgent.includes('Mac'))

type ShortcutKeyPart =
  | { type: 'mod' }
  | { type: 'shift' }
  | { type: 'key'; code?: string; key?: string }

type ShortcutCategory = 'playback' | 'edit' | 'navigation' | 'help'

interface ShortcutDisplayDef {
  id: string
  category: ShortcutCategory
  labelTh: string
  parts: ShortcutKeyPart[]
  dubOnly?: boolean
}

const SHORTCUT_DISPLAY: ShortcutDisplayDef[] = [
  { id: 'play', category: 'playback', labelTh: 'เล่น / หยุด', parts: [{ type: 'key', code: 'Space' }] },
  { id: 'nudge-back', category: 'playback', labelTh: 'ถอย 0.1 วินาที', parts: [{ type: 'key', code: 'ArrowLeft' }] },
  { id: 'nudge-fwd', category: 'playback', labelTh: 'ไป 0.1 วินาที', parts: [{ type: 'key', code: 'ArrowRight' }] },
  { id: 'jump-back', category: 'playback', labelTh: 'ถอย 1 วินาที', parts: [{ type: 'shift' }, { type: 'key', code: 'ArrowLeft' }] },
  { id: 'jump-fwd', category: 'playback', labelTh: 'ไป 1 วินาที', parts: [{ type: 'shift' }, { type: 'key', code: 'ArrowRight' }] },
  { id: 'home', category: 'playback', labelTh: 'ไปต้น timeline', parts: [{ type: 'key', code: 'Home' }] },
  { id: 'end', category: 'playback', labelTh: 'ไปท้าย timeline', parts: [{ type: 'key', code: 'End' }] },
  { id: 'undo', category: 'edit', labelTh: 'เลิกทำ', parts: [{ type: 'mod' }, { type: 'key', code: 'KeyZ' }] },
  { id: 'redo-y', category: 'edit', labelTh: 'ทำซ้ำ', parts: [{ type: 'mod' }, { type: 'key', code: 'KeyY' }] },
  { id: 'redo-z', category: 'edit', labelTh: 'ทำซ้ำ (ทางเลือก)', parts: [{ type: 'mod' }, { type: 'shift' }, { type: 'key', code: 'KeyZ' }] },
  { id: 'delete', category: 'edit', labelTh: 'ลบ scene ที่เลือก', parts: [{ type: 'key', code: 'Delete' }] },
  { id: 'save', category: 'edit', labelTh: 'บันทึก & Render', parts: [{ type: 'mod' }, { type: 'key', code: 'KeyS' }] },
  { id: 'add-scene', category: 'edit', labelTh: 'เพิ่ม scene ที่ playhead', parts: [{ type: 'key', code: 'KeyN' }] },
  { id: 'add-angle', category: 'edit', labelTh: 'เพิ่มมุม (dub)', parts: [{ type: 'key', code: 'KeyM' }], dubOnly: true },
  { id: 'prev-scene', category: 'navigation', labelTh: 'Scene ก่อนหน้า', parts: [{ type: 'key', code: 'BracketLeft' }] },
  { id: 'next-scene', category: 'navigation', labelTh: 'Scene ถัดไป', parts: [{ type: 'key', code: 'BracketRight' }] },
  { id: 'view-source', category: 'navigation', labelTh: 'โหมดต้นฉบับ', parts: [{ type: 'mod' }, { type: 'key', code: 'Digit1' }] },
  { id: 'view-edited', category: 'navigation', labelTh: 'โหมดตัดแล้ว', parts: [{ type: 'mod' }, { type: 'key', code: 'Digit2' }] },
  { id: 'shortcuts-help', category: 'help', labelTh: 'เปิด/ปิดรายการลัด', parts: [{ type: 'key', key: '?' }] },
  { id: 'escape', category: 'help', labelTh: 'ปิด modal / ปิด editor', parts: [{ type: 'key', code: 'Escape' }] },
]

const SHORTCUT_CATEGORY_TITLES: Record<ShortcutCategory, string> = {
  playback: 'เล่น / Timeline',
  edit: 'แก้ไข',
  navigation: 'นำทาง',
  help: 'ช่วยเหลือ',
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  return Boolean(el.closest('input, textarea, [contenteditable="true"]'))
}

function modKey(e: KeyboardEvent): boolean {
  return IS_MAC ? e.metaKey : e.ctrlKey
}

function formatKeyPart(part: ShortcutKeyPart): string {
  if (part.type === 'mod') return IS_MAC ? '⌘' : 'Ctrl'
  if (part.type === 'shift') return IS_MAC ? '⇧' : 'Shift'
  if (part.code === 'Space') return 'Space'
  if (part.code === 'ArrowLeft') return '←'
  if (part.code === 'ArrowRight') return '→'
  if (part.code === 'Home') return 'Home'
  if (part.code === 'End') return 'End'
  if (part.code === 'Delete' || part.code === 'Backspace') return 'Del'
  if (part.code === 'Escape') return 'Esc'
  if (part.code === 'BracketLeft') return '['
  if (part.code === 'BracketRight') return ']'
  if (part.key === '?') return '?'
  if (part.code?.startsWith('Key')) return part.code.slice(3)
  if (part.code?.startsWith('Digit')) return part.code.slice(5)
  return part.key?.toUpperCase() ?? part.code ?? ''
}

function formatShortcut(parts: ShortcutKeyPart[]): string {
  const bits = parts.map(formatKeyPart)
  return IS_MAC ? bits.join('') : bits.join('+')
}

function withShortcut(label: string, id: string): string {
  const def = SHORTCUT_DISPLAY.find((s) => s.id === id)
  return def ? `${label} (${formatShortcut(def.parts)})` : label
}

function matchesShortcutParts(e: KeyboardEvent, parts: ShortcutKeyPart[]): boolean {
  const needsMod = parts.some((p) => p.type === 'mod')
  const needsShift = parts.some((p) => p.type === 'shift')
  if (needsMod !== modKey(e)) return false
  if (needsShift !== e.shiftKey) return false
  if (!needsMod && !needsShift && (e.metaKey || e.ctrlKey || e.altKey)) return false
  const keyPart = parts.find((p) => p.type === 'key')
  if (!keyPart) return false
  if (keyPart.code && e.code === keyPart.code) return true
  if (keyPart.key === '?' && (e.key === '?' || (e.code === 'Slash' && e.shiftKey))) return true
  return false
}

function ShortcutsHelpModal({ isDub, onClose }: { isDub: boolean; onClose: () => void }) {
  const categories = (Object.keys(SHORTCUT_CATEGORY_TITLES) as ShortcutCategory[])
  return (
    <div
      className="fixed inset-0 z-110 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-xl border border-white/10 bg-zinc-900 shadow-2xl"
        onClick={(ev) => ev.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <h3 className="text-sm font-semibold text-amber-100">แป้นพิมพ์ลัด</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-amber-300/50 hover:bg-white/5 hover:text-amber-100"
          >
            <X size={16} />
          </button>
        </div>
        <div className="scroll-ghost min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {categories.map((cat) => {
            const items = SHORTCUT_DISPLAY.filter(
              (s) => s.category === cat && (!s.dubOnly || isDub),
            )
            if (items.length === 0) return null
            return (
              <section key={cat} className="mb-4 last:mb-0">
                <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-amber-300/45">
                  {SHORTCUT_CATEGORY_TITLES[cat]}
                </h4>
                <ul className="space-y-1.5">
                  {items.map((s) => (
                    <li key={s.id} className="flex items-center justify-between gap-3 text-xs">
                      <span className="text-amber-100/85">{s.labelTh}</span>
                      <kbd className="shrink-0 rounded border border-white/15 bg-white/5 px-2 py-0.5 font-mono text-[10px] text-amber-200/90">
                        {formatShortcut(s.parts)}
                      </kbd>
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}
          <p className="mt-4 border-t border-white/10 pt-3 text-[10px] text-amber-300/40">
            {IS_MAC ? 'แสดงคีย์ตามระบบ Mac ของคุณ (⌘ = Command)' : 'บน Mac ใช้ ⌘ แทน Ctrl'}
          </p>
        </div>
      </div>
    </div>
  )
}

interface Filmstrip {
  thumbs: string[]
  /** Display width per tile — scaled so tiles cover the full lane edge-to-edge. */
  tileWidthPx: number
}

/**
 * Tile a continuous filmstrip across the whole lane width (CapCut-style — no gaps):
 * one frame per native-aspect tile, covering the full clip duration.
 */
async function generateFilmstrip(src: string, durationSec: number): Promise<Filmstrip> {
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.crossOrigin = 'anonymous'
  video.src = src
  await new Promise<void>((resolve, reject) => {
    video.addEventListener('loadedmetadata', () => resolve(), { once: true })
    video.addEventListener('error', () => reject(new Error('video load failed')), { once: true })
  })

  const duration =
    video.duration > 0 && Number.isFinite(video.duration) ? video.duration : durationSec
  const laneWidthPx = Math.max(duration * PX_PER_SEC, 80)

  const ratio = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 9 / 16
  const tileWidthPx = Math.max(1, Math.round(LANE_HEIGHT_PX * ratio))
  // Capture at ~2x display size for sharpness without wasting time on oversized canvases/encodes.
  const captureH = Math.min(video.videoHeight || 320, LANE_HEIGHT_PX * 2)
  const captureW = Math.max(1, Math.round(captureH * ratio))
  const canvas = document.createElement('canvas')
  canvas.width = captureW
  canvas.height = captureH
  const ctx = canvas.getContext('2d')
  if (!ctx) return { thumbs: [], tileWidthPx }

  const count = Math.max(4, Math.ceil(laneWidthPx / tileWidthPx))
  const thumbs: string[] = []
  for (let i = 0; i < count; i++) {
    const t = count <= 1 ? 0 : (duration * i) / (count - 1)
    await new Promise<void>((resolve) => {
      const onSeeked = () => { video.removeEventListener('seeked', onSeeked); resolve() }
      video.addEventListener('seeked', onSeeked)
      video.currentTime = clamp(t, 0, Math.max(duration - 0.05, 0))
    })
    ctx.drawImage(video, 0, 0, captureW, captureH)
    thumbs.push(canvas.toDataURL('image/jpeg', 0.82))
  }
  return { thumbs, tileWidthPx }
}

export function VideoTimelineEditor({ uid, mode, onClose, onSaved }: Props) {
  const [timeline, setTimeline] = useState<EditTimeline | null>(null)
  const [cuts, setCuts] = useState<WorkingCut[]>([])
  const [editorPhase, setEditorPhase] = useState<'loading' | 'preparing' | 'ready'>('loading')
  const [prepareHint, setPrepareHint] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'source' | 'edited'>('source')

  // Two <video> elements so the "next" edited-mode segment can be pre-seeked in the
  // background (hidden) and swapped in instantly — avoids the seek/reload freeze that
  // otherwise shows up as a stutter on every cut boundary during playback.
  const videoARef = useRef<HTMLVideoElement>(null)
  const videoBRef = useRef<HTMLVideoElement>(null)
  const activeVideoKeyRef = useRef<'A' | 'B'>('A')
  const bufferPrimedKeyRef = useRef<string | null>(null)
  const lanesViewportRef = useRef<HTMLDivElement>(null)
  const timeLabelRef = useRef<HTMLSpanElement>(null)
  const isScrubbingRef = useRef(false)
  const isTimelinePointerDragRef = useRef(false)
  const wasPlayingBeforeScrubRef = useRef(false)
  const scrollFinishTimerRef = useRef<number | undefined>(undefined)
  const lastProgrammaticScrollRef = useRef<number | null>(null)
  const scrollMovedRef = useRef(false)
  const currentTimeRef = useRef(0)
  const [lanePadPx, setLanePadPx] = useState(0)
  const [videoDuration, setVideoDuration] = useState(0)
  const previewCache = useRef<Map<string, { src: string; cleanup: () => void }>>(new Map())
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  const [previewSource, setPreviewSource] = useState<string | null>(null)
  const playRangeRef = useRef<{ in: number; out: number } | null>(null)
  /** When preview src swaps (selectCut), only resume if playback was active before the click. */
  const resumePlaybackRef = useRef(true)
  const isCutBlockEditingRef = useRef(false)
  /** Which cut is currently loaded/playing in the shared <video> when viewMode === 'edited'. */
  const editedActiveCutIdRef = useRef<string | null>(null)
  const cutsRef = useRef<WorkingCut[]>([])
  const viewModeRef = useRef<'source' | 'edited'>('source')
  const sourceViewStateRef = useRef<ViewModePlaybackState | null>(null)
  const editedViewStateRef = useRef<ViewModePlaybackState | null>(null)
  const newCutCounter = useRef(0)
  const [filmstrips, setFilmstrips] = useState<Record<string, Filmstrip>>({})
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)

  // Undo/redo: refs hold the stacks (no re-render needed per push), historyTick
  // forces a re-render so the toolbar buttons' disabled state stays accurate.
  const undoStack = useRef<WorkingCut[][]>([])
  const redoStack = useRef<WorkingCut[][]>([])
  const editSnapshot = useRef<WorkingCut[] | null>(null)
  const [, setHistoryTick] = useState(0)

  function pushUndoSnapshot(prev: WorkingCut[]) {
    undoStack.current.push(prev)
    redoStack.current = []
    setHistoryTick((t) => t + 1)
  }

  /** Call at the start of a continuous edit (drag, typing) — pairs with commitEdit(). */
  function beginEdit() {
    editSnapshot.current = cuts
  }

  /** Call at the end of a continuous edit — pushes the pre-edit snapshot onto the undo stack. */
  function commitEdit() {
    if (editSnapshot.current) {
      pushUndoSnapshot(editSnapshot.current)
      editSnapshot.current = null
    }
  }

  function beginCutBlockEdit() {
    isCutBlockEditingRef.current = true
    beginEdit()
  }

  function commitCutBlockEdit() {
    isCutBlockEditingRef.current = false
    commitEdit()
  }

  function undo() {
    const prev = undoStack.current.pop()
    if (!prev) return
    setCuts((curr) => {
      redoStack.current.push(curr)
      return prev
    })
    setSelectedId((id) => (id && prev.some((c) => c.id === id) ? id : null))
    setHistoryTick((t) => t + 1)
  }

  function redo() {
    const next = redoStack.current.pop()
    if (!next) return
    setCuts((curr) => {
      undoStack.current.push(curr)
      return next
    })
    setSelectedId((id) => (id && next.some((c) => c.id === id) ? id : null))
    setHistoryTick((t) => t + 1)
  }

  useEffect(() => {
    let cancelled = false
    setEditorPhase('loading')
    setPrepareHint('')
    setError(null)
    setFilmstrips({})
    setPreviewSrc(null)
    setPreviewSource(null)
    api.videos.getEditTimeline(uid)
      .then(async (t) => {
        if (cancelled) return
        setTimeline(t)
        setCuts(normalizeDubCuts(t.cuts))
        setEditorPhase('preparing')
        await loadFilmstrips(t.sources, (hint) => {
          if (!cancelled) setPrepareHint(hint)
        })
        if (cancelled) return
        const firstCut = t.cuts[0]
        if (firstCut) {
          setSelectedId(firstCut.id)
          playRangeRef.current = { in: firstCut.in, out: firstCut.out }
          setPrepareHint('กำลังโหลดตัวอย่างเล่น…')
          await loadPreviewFor(firstCut.source)
        }
        if (!cancelled) setEditorPhase('ready')
      })
      .catch((e) => {
        if (!cancelled) {
          setError(formatUserError(e))
          setEditorPhase('ready')
        }
      })
    return () => { cancelled = true }
  }, [uid])

  useEffect(() => {
    return () => {
      previewCache.current.forEach((v) => v.cleanup())
      previewCache.current.clear()
    }
  }, [])

  useEffect(() => { cutsRef.current = cuts }, [cuts])
  useEffect(() => { viewModeRef.current = viewMode }, [viewMode])
  useEffect(() => { applyVideoVisibility() }, [])

  // Keep the hidden buffer video pre-seeked to whatever cut plays next, so the eventual
  // boundary crossing is an instant swap instead of a live seek/reload.
  useEffect(() => {
    if (viewMode !== 'edited' || editorPhase !== 'ready') return
    primeNextSegment()
  }, [viewMode, editorPhase, selectedId, cuts])

  // Smooth playhead — rAF drives lane transform directly (no React re-render per frame).
  useEffect(() => {
    if (!isPlaying) return
    let raf = 0
    const tick = () => {
    const v = activeVideo()
    if (v && !v.paused && !isScrubbingRef.current) {
        if (viewMode === 'edited' && maybeAdvanceEditedSegment(v)) {
          raf = requestAnimationFrame(tick)
          return
        }
        let t: number
        let totalForLabel: number
        if (viewMode === 'edited') {
          const cut = currentEditedCut()
          const seg = cut ? computeEditedSegments(cuts).find((s) => s.cut.id === cut.id) : null
          t = seg ? clamp(seg.editedIn + (v.currentTime - cut!.in), 0, computeEditedDuration(cuts)) : 0
          totalForLabel = computeEditedDuration(cuts)
        } else {
          const dur = getPlayDuration(previewSource)
          t = clamp(v.currentTime, 0, dur)
          totalForLabel = v.duration || 0
        }
        currentTimeRef.current = t
        syncScrollFromTime(t)
        syncFocusToPlayhead(t)
        if (timeLabelRef.current) {
          timeLabelRef.current.textContent = `${fmtTime(t)} / ${fmtTime(totalForLabel)}`
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [isPlaying, previewSrc, previewSource, videoDuration, timeline, viewMode, cuts])

  function getSourceDurationSec(sourceId: string | null): number {
    if (!timeline || !sourceId) return videoDuration
    const meta = timeline.sources.find((s) => s.id === sourceId)?.durationSec ?? 0
    const maxCutOut = cuts
      .filter((c) => c.source === sourceId)
      .reduce((m, c) => Math.max(m, c.out), 0)
    const loadedVideo = previewSource === sourceId ? videoDuration : 0
    return Math.max(meta, loadedVideo, maxCutOut)
  }

  function getPlayDuration(sourceId: string | null): number {
    return getSourceDurationSec(sourceId)
  }

  /** Total duration of whichever timeline domain is currently visible (source clip vs. edited sequence). */
  function getActiveDurationSec(): number {
    return viewMode === 'edited' ? computeEditedDuration(cuts) : getPlayDuration(previewSource)
  }

  function currentEditedCut(): WorkingCut | null {
    return cuts.find((c) => c.id === editedActiveCutIdRef.current) ?? null
  }

  function activeVideo(): HTMLVideoElement | null {
    return activeVideoKeyRef.current === 'A' ? videoARef.current : videoBRef.current
  }

  function inactiveVideo(): HTMLVideoElement | null {
    return activeVideoKeyRef.current === 'A' ? videoBRef.current : videoARef.current
  }

  /** Imperative opacity/z-index swap — no React re-render, so the switch itself is instant. */
  function applyVideoVisibility() {
    const a = videoARef.current
    const b = videoBRef.current
    const aIsActive = activeVideoKeyRef.current === 'A'
    if (a) { a.style.opacity = aIsActive ? '1' : '0'; a.style.zIndex = aIsActive ? '2' : '1' }
    if (b) { b.style.opacity = aIsActive ? '0' : '1'; b.style.zIndex = aIsActive ? '1' : '2' }
  }

  function bufferKeyFor(cut: WorkingCut): string {
    return `${cut.id}:${cut.source}:${cut.in}`
  }

  /** True once the hidden buffer video has been seeked and has decoded data ready for `next`. */
  function isBufferReadyFor(next: WorkingCut): boolean {
    const buf = inactiveVideo()
    if (!buf) return false
    return bufferPrimedKeyRef.current === bufferKeyFor(next) && buf.readyState >= 2
  }

  /** Look ahead to the cut after the currently active one and pre-seek the hidden video to it. */
  function primeNextSegment() {
    if (viewModeRef.current !== 'edited') return
    const list = cutsRef.current
    const idx = list.findIndex((c) => c.id === editedActiveCutIdRef.current)
    if (idx < 0) return
    const next = list[idx + 1]
    const buf = inactiveVideo()
    if (!next || !buf) return
    const key = bufferKeyFor(next)
    if (bufferPrimedKeyRef.current === key) return
    bufferPrimedKeyRef.current = key
    void (async () => {
      try {
        const src = await ensureSourceSrc(next.source)
        if (bufferPrimedKeyRef.current !== key) return
        const seekTo = () => {
          if (bufferPrimedKeyRef.current !== key) return
          buf.currentTime = next.in
        }
        if (buf.src !== src) {
          buf.src = src
          buf.addEventListener('loadedmetadata', seekTo, { once: true })
        } else if (buf.readyState >= 1) {
          seekTo()
        } else {
          buf.addEventListener('loadedmetadata', seekTo, { once: true })
        }
      } catch {
        // Buffering is only a smoothness aid — the normal seek/reload path still works as a fallback.
        if (bufferPrimedKeyRef.current === key) bufferPrimedKeyRef.current = null
      }
    })()
  }

  /** Seek the active <video> to a position on the active timeline domain (source-local or edited seconds). */
  function seekActiveTime(t: number) {
    if (viewMode !== 'edited') {
      const v = activeVideo()
      if (v) v.currentTime = t
      return
    }
    const seg = findEditedSegment(cuts, t)
    if (!seg) return
    const localTime = clamp(seg.cut.in + (t - seg.editedIn), seg.cut.in, seg.cut.out)
    editedActiveCutIdRef.current = seg.cut.id
    if (previewSource !== seg.cut.source) {
      resumePlaybackRef.current = false
      playRangeRef.current = { in: localTime, out: seg.cut.out }
      void loadPreviewFor(seg.cut.source)
    } else {
      const v = activeVideo()
      if (v) v.currentTime = localTime
    }
  }

  /** While playing in edited mode: once the active cut's out-point is reached, jump to the next cut. */
  function maybeAdvanceEditedSegment(v: HTMLVideoElement): boolean {
    const cut = currentEditedCut()
    if (!cut) return false
    const EPS = 0.05
    if (v.currentTime < cut.out - EPS) return false
    const idx = cuts.findIndex((c) => c.id === cut.id)
    const next = cuts[idx + 1]
    if (!next) {
      v.pause()
      setIsPlaying(false)
      const dur = computeEditedDuration(cuts)
      currentTimeRef.current = dur
      setCurrentTime(dur)
      syncScrollFromTime(dur)
      updateTimeLabel(dur)
      return true
    }
    editedActiveCutIdRef.current = next.id
    setSelectedId(next.id)
    resumePlaybackRef.current = true
    playRangeRef.current = { in: next.in, out: next.out }

    if (isBufferReadyFor(next)) {
      // Instant swap: the hidden buffer is already seeked & decoded at next.in.
      const buf = inactiveVideo()!
      v.pause()
      activeVideoKeyRef.current = activeVideoKeyRef.current === 'A' ? 'B' : 'A'
      applyVideoVisibility()
      void buf.play()
      setVideoDuration(buf.duration || 0)
      setPreviewSource(next.source)
      setPreviewSrc(buf.currentSrc || buf.src)
      bufferPrimedKeyRef.current = null
    } else if (previewSource !== next.source) {
      void loadPreviewFor(next.source)
    } else {
      v.currentTime = next.in
      if (v.paused) void v.play()
    }
    primeNextSegment()
    return true
  }

  function getMaxScrollLeft(): number {
    const el = lanesViewportRef.current
    if (!el) return getActiveDurationSec() * PX_PER_SEC
    return Math.max(0, el.scrollWidth - el.clientWidth)
  }

  /** CapCut-style fixed center playhead — native horizontal scroll (scrollbar hidden). */
  function syncScrollFromTime(sec: number) {
    const el = lanesViewportRef.current
    if (!el) return
    const dur = getActiveDurationSec()
    const left = clamp(sec, 0, dur) * PX_PER_SEC
    lastProgrammaticScrollRef.current = left
    el.scrollLeft = clamp(left, 0, getMaxScrollLeft())
  }

  function updateTimeLabel(sec: number) {
    if (!timeLabelRef.current) return
    const total = viewMode === 'edited' ? computeEditedDuration(cuts) : (activeVideo()?.duration ?? videoDuration)
    timeLabelRef.current.textContent = `${fmtTime(sec)} / ${fmtTime(total)}`
  }

  function applyScrubTime(sec: number, seekVideo: boolean) {
    const dur = getActiveDurationSec()
    const t = clamp(sec, 0, dur)
    currentTimeRef.current = t
    setCurrentTime(t)
    syncScrollFromTime(t)
    updateTimeLabel(t)
    if (seekVideo) seekActiveTime(t)
    syncFocusToPlayhead(t)
  }

  /** Highlight the scene under the playhead (edited sequence or source lane). */
  function syncFocusToPlayhead(t: number) {
    if (isCutBlockEditingRef.current) return

    const focusId = viewMode === 'edited'
      ? findEditedSegment(cuts, t)?.cut.id ?? null
      : findSourceCutAtTime(cuts, previewSource, t)?.id ?? null

    if (!focusId) return

    setSelectedId((prev) => {
      if (prev === focusId) return prev
      if (viewMode === 'edited') editedActiveCutIdRef.current = focusId
      return focusId
    })
  }

  function pauseForScrub() {
    const v = activeVideo()
    if (!isScrubbingRef.current && v) {
      wasPlayingBeforeScrubRef.current = !v.paused
    }
    isScrubbingRef.current = true
    // A scrub may cross source boundaries in edited mode — don't auto-resume mid-drag.
    resumePlaybackRef.current = false
    setIsPlaying(false)
    if (v && !v.paused) v.pause()
  }

  function resumeAfterScrub() {
    isScrubbingRef.current = false
    if (wasPlayingBeforeScrubRef.current) {
      void activeVideo()?.play()
    }
  }

  function updateScrubTimeFromScroll(scrollLeft: number, seekVideo: boolean) {
    const dur = getActiveDurationSec()
    const sec = clamp(scrollLeft / PX_PER_SEC, 0, dur)
    currentTimeRef.current = sec
    setCurrentTime(sec)
    updateTimeLabel(sec)
    if (seekVideo) seekActiveTime(sec)
  }

  function isTimelineEditBlockInteraction(target: HTMLElement): boolean {
    return Boolean(
      target.closest('[data-timeline-reorder-handle]')
      || target.closest('[data-cut-trim-handle]'),
    )
  }

  function isTimelineScrubTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false
    if (!target.closest('[data-timeline-scroll]')) return false
    // Source lanes have empty space between/around cut blocks for scrub-drag.
    if (viewMode === 'source' && target.closest('[data-cut-block]')) return false
    // Edited lane is only cut blocks — allow scrub-drag on them except reorder/resize handles.
    if (viewMode === 'edited' && isTimelineEditBlockInteraction(target)) return false
    return true
  }

  // Side padding so time 0 / end can sit under the fixed center playhead.
  useEffect(() => {
    const el = lanesViewportRef.current
    if (!el) return
    const sync = () => setLanePadPx(el.clientWidth / 2)
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => ro.disconnect()
  }, [editorPhase, timeline])

  useEffect(() => {
    if (!previewSource || editorPhase !== 'ready') return
    if (isCutBlockEditingRef.current) return
    syncScrollFromTime(currentTimeRef.current)
  }, [previewSource, lanePadPx, videoDuration, editorPhase, timeline, cuts, viewMode])

  useEffect(() => {
    const el = lanesViewportRef.current
    if (!el || editorPhase !== 'ready') return

    function finishUserScroll() {
      if (isTimelinePointerDragRef.current) return
      const dur = getActiveDurationSec()
      const sec = clamp(el!.scrollLeft / PX_PER_SEC, 0, dur)
      applyScrubTime(sec, true)
      resumeAfterScrub()
    }

    function onScroll() {
      if (
        lastProgrammaticScrollRef.current !== null
        && Math.abs(el!.scrollLeft - lastProgrammaticScrollRef.current) < 0.5
      ) {
        return
      }
      lastProgrammaticScrollRef.current = null

      if (!isTimelinePointerDragRef.current) {
        pauseForScrub()
        scrollMovedRef.current = true
      }

      updateScrubTimeFromScroll(el!.scrollLeft, isTimelinePointerDragRef.current)

      if (isTimelinePointerDragRef.current) return

      window.clearTimeout(scrollFinishTimerRef.current)
      scrollFinishTimerRef.current = window.setTimeout(finishUserScroll, 120)
    }

    function onScrollEnd() {
      if (
        lastProgrammaticScrollRef.current !== null
        && Math.abs(el!.scrollLeft - lastProgrammaticScrollRef.current) < 0.5
      ) {
        return
      }
      lastProgrammaticScrollRef.current = null
      if (isTimelinePointerDragRef.current) return
      window.clearTimeout(scrollFinishTimerRef.current)
      finishUserScroll()
    }

    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('scrollend', onScrollEnd)
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('scrollend', onScrollEnd)
      window.clearTimeout(scrollFinishTimerRef.current)
    }
  }, [previewSource, videoDuration, editorPhase, timeline, viewMode, cuts])

  /** Desktop: drag anywhere on the lane to scroll (scrollbar stays hidden). Touch uses native scroll. */
  function onTimelinePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement
    const timelineReady = viewMode === 'edited' ? cuts.length > 0 : Boolean(previewSource)
    if (!timelineReady || e.pointerType !== 'mouse' || e.button !== 0) return
    if (viewMode === 'source') {
      if (target.closest('[data-cut-block]')) return
    } else if (isTimelineEditBlockInteraction(target)) {
      return
    }

    const el = lanesViewportRef.current
    if (!el) return

    window.clearTimeout(scrollFinishTimerRef.current)
    scrollMovedRef.current = false

    const startX = e.clientX
    const startScrollLeft = el.scrollLeft
    const captureTarget = e.currentTarget
    let dragging = false

    function onMove(ev: PointerEvent) {
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) <= 4) return
        dragging = true
        scrollMovedRef.current = true
        isTimelinePointerDragRef.current = true
        pauseForScrub()
        captureTarget.setPointerCapture(ev.pointerId)
        captureTarget.classList.add('cursor-grabbing')
        captureTarget.classList.remove('cursor-grab')
        const v = activeVideo()
        if (v && !v.paused) v.pause()
        setIsPlaying(false)
      }
      const maxScroll = getMaxScrollLeft()
      el.scrollLeft = clamp(startScrollLeft - (ev.clientX - startX), 0, maxScroll)
      updateScrubTimeFromScroll(el.scrollLeft, true)
    }

    function onUp(ev: PointerEvent) {
      if (dragging) {
        isTimelinePointerDragRef.current = false
        if (captureTarget.hasPointerCapture(ev.pointerId)) captureTarget.releasePointerCapture(ev.pointerId)
        captureTarget.classList.remove('cursor-grabbing')
        captureTarget.classList.add('cursor-grab')
        const dur = getActiveDurationSec()
        const sec = clamp(el.scrollLeft / PX_PER_SEC, 0, dur)
        applyScrubTime(sec, true)
        resumeAfterScrub()
      } else if (viewMode === 'edited') {
        isScrubbingRef.current = false
        const cutBlock = target.closest('[data-cut-id]')
        if (cutBlock) {
          const cutId = cutBlock.getAttribute('data-cut-id')
          const cut = cuts.find((c) => c.id === cutId)
          if (cut) void selectCut(cut)
        }
      }
      scrollMovedRef.current = false
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  const isDub = mode === 'dub_first'

  /** Resolve (and cache) the playable src for a source clip — shared by preview and filmstrip generation. */
  async function ensureSourceSrc(sourceId: string): Promise<string> {
    const cached = previewCache.current.get(sourceId)
    if (cached) return cached.src
    const r = await api.videos.resolveSourcePreviewSrc(uid, sourceId)
    previewCache.current.set(sourceId, r)
    return r.src
  }

  async function loadFilmstrips(
    sources: { id: string; durationSec: number }[],
    onProgress?: (hint: string) => void,
  ) {
    for (let i = 0; i < sources.length; i++) {
      const src = sources[i]
      onProgress?.(
        sources.length > 1
          ? `กำลังสร้างภาพตัวอย่างคลิป ${i + 1}/${sources.length}…`
          : 'กำลังสร้างภาพตัวอย่างคลิป…',
      )
      try {
        const playableSrc = await ensureSourceSrc(src.id)
        const strip = await generateFilmstrip(playableSrc, src.durationSec)
        if (strip.thumbs.length > 0) {
          setFilmstrips((prev) => ({ ...prev, [src.id]: strip }))
        }
      } catch {
        // Filmstrip is a visual aid only (e.g. CORS-tainted canvas on S3) — lane still works without it.
      }
    }
  }

  async function loadPreviewFor(sourceId: string) {
    try {
      const src = await ensureSourceSrc(sourceId)
      setPreviewSrc(src)
      setPreviewSource(sourceId)
    } catch (e) {
      setError(formatUserError(e))
    }
  }

  async function selectCut(cut: WorkingCut) {
    const vBefore = activeVideo()
    resumePlaybackRef.current = vBefore ? !vBefore.paused : isPlaying

    setSelectedId(cut.id)
    editedActiveCutIdRef.current = cut.id
    playRangeRef.current = { in: cut.in, out: cut.out }
    const needsSrcSwap = previewSource !== cut.source
    if (needsSrcSwap) {
      await loadPreviewFor(cut.source)
    }
    const v = activeVideo()
    if (v) {
      v.currentTime = cut.in
      const activeT = viewMode === 'edited'
        ? (computeEditedSegments(cuts).find((s) => s.cut.id === cut.id)?.editedIn ?? cut.in)
        : cut.in
      currentTimeRef.current = activeT
      setCurrentTime(activeT)
      syncScrollFromTime(activeT)
      updateTimeLabel(activeT)
      if (!needsSrcSwap && resumePlaybackRef.current) void v.play()
    }
  }

  // Once the preview video src swaps in, seek + play the pending range. `editorPhase` is in the
  // dependency array because the <video> elements only mount once it reaches 'ready' — previewSrc
  // is typically already set by then, so without this the effect would fire while the refs are
  // still null and never apply the src once the elements actually exist.
  useEffect(() => {
    const v = activeVideo()
    const range = playRangeRef.current
    if (!v || !range || !previewSrc) return
    if (v.src !== previewSrc) v.src = previewSrc
    const onLoaded = () => {
      v.currentTime = range.in
      setVideoDuration(v.duration || 0)
      const cutId = editedActiveCutIdRef.current
      const activeT = viewModeRef.current === 'edited' && cutId
        ? (computeEditedSegments(cutsRef.current).find((s) => s.cut.id === cutId)?.editedIn ?? range.in)
        : range.in
      currentTimeRef.current = activeT
      setCurrentTime(activeT)
      syncScrollFromTime(activeT)
      updateTimeLabel(activeT)
      if (resumePlaybackRef.current) void v.play()
    }
    if (v.readyState >= 1 && v.src === previewSrc) onLoaded()
    else v.addEventListener('loadedmetadata', onLoaded, { once: true })
    return () => v.removeEventListener('loadedmetadata', onLoaded)
  }, [previewSrc, editorPhase])

  function syncTimeFromVideo() {
    if (isScrubbingRef.current) return
    const v = activeVideo()
    if (!v) return
    let t: number
    if (viewMode === 'edited') {
      const cut = currentEditedCut()
      const seg = cut ? computeEditedSegments(cuts).find((s) => s.cut.id === cut.id) : null
      if (!seg) return
      t = clamp(seg.editedIn + (v.currentTime - cut!.in), 0, computeEditedDuration(cuts))
    } else {
      const dur = getPlayDuration(previewSource)
      t = clamp(v.currentTime, 0, dur)
    }
    currentTimeRef.current = t
    setCurrentTime(t)
    syncScrollFromTime(t)
    updateTimeLabel(t)
    syncFocusToPlayhead(t)
  }
  function isActiveVideoEvent(e: React.SyntheticEvent<HTMLVideoElement>): boolean {
    return e.currentTarget === activeVideo()
  }

  function onVideoLoadedMetadata() {
    const v = activeVideo()
    if (!v) return
    setVideoDuration(v.duration || 0)
    if (!isScrubbingRef.current) syncTimeFromVideo()
  }

  function onTimeUpdate() {
    const v = activeVideo()
    if (viewMode === 'edited' && v && maybeAdvanceEditedSegment(v)) return
    syncTimeFromVideo()
  }

  function onVideoEnded() {
    setIsPlaying(false)
    const dur = getActiveDurationSec()
    currentTimeRef.current = dur
    setCurrentTime(dur)
    syncScrollFromTime(dur)
    updateTimeLabel(dur)
  }

  function captureViewModeState(mode: 'source' | 'edited') {
    const v = activeVideo()
    const state: ViewModePlaybackState = {
      currentTime: currentTimeRef.current,
      selectedId,
      previewSource,
      editedActiveCutId: editedActiveCutIdRef.current,
      playRange: playRangeRef.current ? { ...playRangeRef.current } : null,
      wasPlaying: v ? !v.paused : isPlaying,
    }
    if (mode === 'source') sourceViewStateRef.current = state
    else editedViewStateRef.current = state
  }

  async function restoreViewModeState(mode: 'source' | 'edited') {
    const saved = mode === 'source' ? sourceViewStateRef.current : editedViewStateRef.current
    let nextTime: number
    let nextSelectedId: string | null
    let nextEditedCutId: string | null
    let nextPlayRange: { in: number; out: number } | null
    let nextPreviewSource: string | null
    let nextWasPlaying: boolean

    if (saved) {
      nextTime = saved.currentTime
      nextSelectedId = saved.selectedId
      nextEditedCutId = saved.editedActiveCutId
      nextPlayRange = saved.playRange
      nextPreviewSource = saved.previewSource
      nextWasPlaying = saved.wasPlaying
    } else if (mode === 'edited') {
      const first = cuts[0]
      if (!first) return
      nextTime = 0
      nextSelectedId = first.id
      nextEditedCutId = first.id
      nextPlayRange = { in: first.in, out: first.out }
      nextPreviewSource = first.source
      nextWasPlaying = false
    } else {
      return
    }

    setSelectedId(nextSelectedId)
    editedActiveCutIdRef.current = nextEditedCutId
    playRangeRef.current = nextPlayRange
    currentTimeRef.current = nextTime
    setCurrentTime(nextTime)
    resumePlaybackRef.current = nextWasPlaying

    if (nextPreviewSource && nextPreviewSource !== previewSource) {
      await loadPreviewFor(nextPreviewSource)
    }

    const v = activeVideo()
    if (!v) return

    if (mode === 'edited') {
      const seg = nextEditedCutId
        ? computeEditedSegments(cuts).find((s) => s.cut.id === nextEditedCutId)
        : findEditedSegment(cuts, nextTime)
      if (seg) {
        const localT = clamp(seg.cut.in + (nextTime - seg.editedIn), seg.cut.in, seg.cut.out)
        v.currentTime = localT
        playRangeRef.current = { in: seg.cut.in, out: seg.cut.out }
        editedActiveCutIdRef.current = seg.cut.id
      }
    } else {
      v.currentTime = clamp(nextTime, 0, v.duration || nextTime)
    }

    syncScrollFromTime(nextTime)
    updateTimeLabel(nextTime)

    if (nextWasPlaying) void v.play()
    else {
      v.pause()
      setIsPlaying(false)
    }

    if (mode === 'edited') primeNextSegment()
  }

  /** Switch view — each mode keeps its own playhead position and play/pause state. */
  function switchViewMode(next: 'source' | 'edited') {
    if (next === viewMode) return
    captureViewModeState(viewMode)
    setViewMode(next)
    void restoreViewModeState(next)
  }

  function togglePlay() {
    const v = activeVideo()
    if (!v) return
    if (v.paused) {
      if (v.currentTime >= (v.duration || 0) - 0.05) v.currentTime = 0
      void v.play()
    } else {
      v.pause()
    }
  }

  function nudgePlayhead(deltaSec: number) {
    applyScrubTime(currentTimeRef.current + deltaSec, true)
  }

  function selectAdjacentCut(dir: -1 | 1) {
    if (!selectedId || cuts.length === 0) return
    const idx = cuts.findIndex((c) => c.id === selectedId)
    const next = cuts[idx + dir]
    if (next) void selectCut(next)
  }

  function deleteSelectedCut() {
    if (selectedId) deleteCut(selectedId)
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.code === 'Escape') {
        if (shortcutsOpen) {
          e.preventDefault()
          setShortcutsOpen(false)
          return
        }
        if (editorPhase === 'ready') {
          e.preventDefault()
          onClose()
        }
        return
      }

      if (editorPhase !== 'ready' || !previewSrc) return
      if (isTypingTarget(e.target)) return

      const isQuestion = e.key === '?' || (e.code === 'Slash' && e.shiftKey)
      if (isQuestion && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        setShortcutsOpen((open) => !open)
        return
      }

      if (matchesShortcutParts(e, [{ type: 'key', code: 'Space' }])) {
        e.preventDefault()
        togglePlay()
        return
      }

      if (matchesShortcutParts(e, [{ type: 'mod' }, { type: 'key', code: 'KeyZ' }]) && !e.shiftKey) {
        e.preventDefault()
        undo()
        return
      }

      if (
        matchesShortcutParts(e, [{ type: 'mod' }, { type: 'key', code: 'KeyY' }])
        || matchesShortcutParts(e, [{ type: 'mod' }, { type: 'shift' }, { type: 'key', code: 'KeyZ' }])
      ) {
        e.preventDefault()
        redo()
        return
      }

      if (
        matchesShortcutParts(e, [{ type: 'key', code: 'Delete' }])
        || matchesShortcutParts(e, [{ type: 'key', code: 'Backspace' }])
      ) {
        e.preventDefault()
        deleteSelectedCut()
        return
      }

      if (matchesShortcutParts(e, [{ type: 'mod' }, { type: 'key', code: 'KeyS' }])) {
        e.preventDefault()
        if (!saving && cuts.length > 0) void handleSave()
        return
      }

      if (matchesShortcutParts(e, [{ type: 'key', code: 'KeyN' }])) {
        e.preventDefault()
        addSceneAtPlayhead()
        return
      }

      if (isDub && matchesShortcutParts(e, [{ type: 'key', code: 'KeyM' }])) {
        e.preventDefault()
        addMontageCut()
        return
      }

      if (matchesShortcutParts(e, [{ type: 'key', code: 'BracketLeft' }])) {
        e.preventDefault()
        selectAdjacentCut(-1)
        return
      }

      if (matchesShortcutParts(e, [{ type: 'key', code: 'BracketRight' }])) {
        e.preventDefault()
        selectAdjacentCut(1)
        return
      }

      if (
        matchesShortcutParts(e, [{ type: 'mod' }, { type: 'key', code: 'Digit1' }])
        || matchesShortcutParts(e, [{ type: 'mod' }, { type: 'key', code: 'Numpad1' }])
      ) {
        e.preventDefault()
        switchViewMode('source')
        return
      }

      if (
        matchesShortcutParts(e, [{ type: 'mod' }, { type: 'key', code: 'Digit2' }])
        || matchesShortcutParts(e, [{ type: 'mod' }, { type: 'key', code: 'Numpad2' }])
      ) {
        e.preventDefault()
        switchViewMode('edited')
        return
      }

      if (matchesShortcutParts(e, [{ type: 'shift' }, { type: 'key', code: 'ArrowLeft' }])) {
        e.preventDefault()
        nudgePlayhead(-1)
        return
      }

      if (matchesShortcutParts(e, [{ type: 'shift' }, { type: 'key', code: 'ArrowRight' }])) {
        e.preventDefault()
        nudgePlayhead(1)
        return
      }

      if (matchesShortcutParts(e, [{ type: 'key', code: 'ArrowLeft' }])) {
        e.preventDefault()
        nudgePlayhead(-0.1)
        return
      }

      if (matchesShortcutParts(e, [{ type: 'key', code: 'ArrowRight' }])) {
        e.preventDefault()
        nudgePlayhead(0.1)
        return
      }

      if (matchesShortcutParts(e, [{ type: 'key', code: 'Home' }])) {
        e.preventDefault()
        applyScrubTime(0, true)
        return
      }

      if (matchesShortcutParts(e, [{ type: 'key', code: 'End' }])) {
        e.preventDefault()
        applyScrubTime(getActiveDurationSec(), true)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    editorPhase,
    previewSrc,
    shortcutsOpen,
    selectedId,
    cuts,
    saving,
    isDub,
    viewMode,
    onClose,
  ])

  function updateCut(id: string, patch: Partial<WorkingCut>) {
    setCuts((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)))
  }

  function deleteCut(id: string) {
    setCuts((prev) => {
      pushUndoSnapshot(prev)
      return prev.filter((c) => c.id !== id)
    })
    if (selectedId === id) setSelectedId(null)
  }

  function addCut(
    sourceId: string,
    atSec: number,
    durationSec: number,
    opts?: { insertAtPlayhead?: boolean },
  ) {
    const start = clamp(atSec, 0, Math.max(durationSec, 0))
    const end = clamp(start + DEFAULT_NEW_CUT_SEC, start + MIN_CUT_SEC, durationSec)
    newCutCounter.current += 1
    const cutId = `new${newCutCounter.current}`
    let created: WorkingCut | null = null
    setCuts((prev) => {
      pushUndoSnapshot(prev)
      const newLineId = isDub ? nextVoiceoverLineId(prev) : undefined
      created = {
        id: cutId,
        source: sourceId,
        in: start,
        out: end,
        label: isDub ? `บรรทัด ${newLineId}` : 'scene ใหม่',
        voiceoverLineId: newLineId,
        voiceoverScript: isDub ? '' : undefined,
      }
      let insertIdx = prev.length
      if (opts?.insertAtPlayhead) {
        let placed = false
        for (let i = 0; i < prev.length; i += 1) {
          if (prev[i].source === sourceId && prev[i].in >= start - 0.01) {
            insertIdx = i
            placed = true
            break
          }
        }
        if (!placed) {
          for (let i = prev.length - 1; i >= 0; i -= 1) {
            if (prev[i].source === sourceId) {
              insertIdx = i + 1
              break
            }
          }
        }
      }
      return [...prev.slice(0, insertIdx), created, ...prev.slice(insertIdx)]
    })
    if (created) void selectCut(created)
  }

  function addMontageCut() {
    if (!selectedCut || !isDub || !timeline) return
    const lineId = cutLineId(selectedCut)
    const srcDur = timeline.sources.find((s) => s.id === selectedCut.source)?.durationSec ?? 60
    const start = clamp(selectedCut.out, 0, Math.max(srcDur - MIN_CUT_SEC, 0))
    const end = clamp(start + DEFAULT_NEW_CUT_SEC, start + MIN_CUT_SEC, srcDur)
    newCutCounter.current += 1
    const cutId = `new${newCutCounter.current}`
    let created: WorkingCut | null = null
    setCuts((prev) => {
      pushUndoSnapshot(prev)
      const angleNum = cutsInLine(prev, lineId).length + 1
      created = {
        id: cutId,
        source: selectedCut.source,
        in: start,
        out: end,
        label: `บรรทัด ${lineId} · มุม ${angleNum}`,
        voiceoverLineId: lineId,
        voiceoverScript: '',
      }
      let insertIdx = prev.length
      for (let i = prev.length - 1; i >= 0; i -= 1) {
        if (cutLineId(prev[i]) === lineId) {
          insertIdx = i + 1
          break
        }
      }
      return [...prev.slice(0, insertIdx), created, ...prev.slice(insertIdx)]
    })
    if (created) void selectCut(created)
  }

  function addSceneAtPlayhead() {
    if (!timeline) return
    const sourceId = previewSource ?? timeline.sources[0]?.id
    if (!sourceId) return
    const dur = getSourceDurationSec(sourceId)
    const atSec = clamp(currentTimeRef.current, 0, Math.max(dur - MIN_CUT_SEC, 0))
    addCut(sourceId, atSec, dur, { insertAtPlayhead: true })
  }

  function updateLineScript(lineId: number, script: string) {
    setCuts((prev) => {
      const firstId = prev.find((c) => cutLineId(c) === lineId)?.id
      if (!firstId) return prev
      return prev.map((c) => {
        if (cutLineId(c) !== lineId) return c
        if (c.id === firstId) return { ...c, voiceoverScript: script }
        return { ...c, voiceoverScript: '' }
      })
    })
  }

  function handleSequenceDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    setCuts((prev) => {
      const oldIndex = prev.findIndex((c) => c.id === active.id)
      const newIndex = prev.findIndex((c) => c.id === over.id)
      if (oldIndex < 0 || newIndex < 0) return prev
      pushUndoSnapshot(prev)
      return arrayMove(prev, oldIndex, newIndex)
    })
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  async function handleSave() {
    if (cuts.length === 0) {
      setError('ต้องมีอย่างน้อย 1 scene')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const payload: EditCut[] = cuts.map((c) => ({
        source: c.source,
        in: c.in,
        out: c.out,
        label: c.label,
        voiceoverLineId: isDub ? (c.voiceoverLineId ?? (cutLineId(c) || null)) : undefined,
        voiceoverScript: isDub ? (c.voiceoverScript ?? '') : undefined,
      } as EditCut))
      await api.videos.saveEditTimeline(uid, payload)
      onSaved()
      onClose()
    } catch (e) {
      setError(formatUserError(e))
    } finally {
      setSaving(false)
    }
  }

  const selectedCut = cuts.find((c) => c.id === selectedId) ?? null

  return (
    <div className="fixed inset-0 z-100 flex flex-col bg-zinc-950/98 text-amber-50">
      <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
        <div>
          <h2 className="text-sm font-semibold text-amber-100">แก้ไขวิดีโอ — Timeline Editor</h2>
          <p className="text-[11px] text-amber-300/45">ลาก/เลื่อน timeline · ขยับ/เพิ่ม/ลบ scene แล้วกดบันทึก — ไม่เรียก AI ใหม่</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShortcutsOpen(true)}
            title={withShortcut('แป้นพิมพ์ลัด', 'shortcuts-help')}
            className="rounded-lg p-2 text-amber-300/60 hover:bg-white/5 hover:text-amber-100"
          >
            <HelpCircle size={16} />
          </button>
          <button
            type="button"
            onClick={undo}
            disabled={undoStack.current.length === 0}
            title={withShortcut('เลิกทำ', 'undo')}
            className="rounded-lg p-2 text-amber-300/60 hover:bg-white/5 hover:text-amber-100 disabled:opacity-30"
          >
            <Undo2 size={16} />
          </button>
          <button
            type="button"
            onClick={redo}
            disabled={redoStack.current.length === 0}
            title={withShortcut('ทำซ้ำ', 'redo-y')}
            className="rounded-lg p-2 text-amber-300/60 hover:bg-white/5 hover:text-amber-100 disabled:opacity-30"
          >
            <Redo2 size={16} />
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || editorPhase !== 'ready' || cuts.length === 0}
            title={withShortcut('บันทึก & Render', 'save')}
            className="ml-2 flex items-center gap-1.5 rounded-lg bg-amber-500 px-4 py-2 text-xs font-bold text-black shadow hover:bg-amber-400 disabled:opacity-40"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            {saving ? 'กำลังบันทึก…' : 'บันทึก & Render'}
          </button>
          <button
            type="button"
            onClick={onClose}
            title={withShortcut('ปิด editor', 'escape')}
            className="rounded-lg p-2 text-amber-300/60 hover:bg-white/5 hover:text-amber-100"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {shortcutsOpen && (
        <ShortcutsHelpModal isDub={isDub} onClose={() => setShortcutsOpen(false)} />
      )}

      {error && (
        <p className="mx-5 mt-3 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      {editorPhase !== 'ready' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-amber-500/20 bg-amber-500/10">
            <Loader2 size={24} className="animate-spin text-amber-400" />
          </div>
          <p className="text-sm font-medium text-amber-100/90">
            {editorPhase === 'loading' ? 'กำลังโหลด timeline…' : 'กำลังเตรียมวิดีโอ…'}
          </p>
          {prepareHint && (
            <p className="max-w-xs text-[11px] text-amber-300/45">{prepareHint}</p>
          )}
        </div>
      ) : !timeline ? null : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {/* Video — hero: fills all space left after fixed bands below */}
          <div className="flex min-h-0 flex-1 flex-col items-center overflow-hidden px-5 pt-2 pb-1">
            <div className="relative flex h-full min-h-0 max-w-full flex-1 items-center justify-center" style={{ width: 'auto', aspectRatio: '9 / 16' }}>
              {/* Two elements so the "next" edited-mode segment can be pre-seeked hidden, then swapped in instantly. */}
              <video
                ref={videoARef}
                onTimeUpdate={(e) => isActiveVideoEvent(e) && onTimeUpdate()}
                onLoadedMetadata={(e) => isActiveVideoEvent(e) && onVideoLoadedMetadata()}
                onSeeked={(e) => isActiveVideoEvent(e) && syncTimeFromVideo()}
                onEnded={(e) => isActiveVideoEvent(e) && onVideoEnded()}
                onPlay={(e) => isActiveVideoEvent(e) && setIsPlaying(true)}
                onPause={(e) => isActiveVideoEvent(e) && setIsPlaying(false)}
                className="absolute inset-0 h-full w-full rounded-xl bg-black object-contain"
                style={{ opacity: 1 }}
              />
              <video
                ref={videoBRef}
                onTimeUpdate={(e) => isActiveVideoEvent(e) && onTimeUpdate()}
                onLoadedMetadata={(e) => isActiveVideoEvent(e) && onVideoLoadedMetadata()}
                onSeeked={(e) => isActiveVideoEvent(e) && syncTimeFromVideo()}
                onEnded={(e) => isActiveVideoEvent(e) && onVideoEnded()}
                onPlay={(e) => isActiveVideoEvent(e) && setIsPlaying(true)}
                onPause={(e) => isActiveVideoEvent(e) && setIsPlaying(false)}
                className="absolute inset-0 h-full w-full rounded-xl bg-black object-contain"
                style={{ opacity: 0 }}
              />
            </div>
            {selectedCut && (
              <p className="mt-1 shrink-0 text-center text-[11px] text-amber-300/50">
                {isDub && (
                  <>
                    บรรทัด {cutLineId(selectedCut)} · มุม {cutIndexInLine(cuts, selectedCut)}/{cutsInLine(cuts, cutLineId(selectedCut)).length}
                    {' · '}
                  </>
                )}
                {selectedCut.source} · {selectedCut.in.toFixed(2)}s → {selectedCut.out.toFixed(2)}s
                ({(selectedCut.out - selectedCut.in).toFixed(2)}s)
              </p>
            )}
          </div>

          {/* Source timeline — fixed height */}
          <div
            className="flex shrink-0 flex-col overflow-hidden border-t border-white/10 px-5 py-2"
            style={{ height: EDITOR_TIMELINE_BAND_PX }}
          >
            <div className="relative mb-1 flex h-6 shrink-0 items-center">
              <div className="flex items-center gap-0.5 rounded-md border border-white/10 bg-white/5 p-0.5">
                <button
                  type="button"
                  onClick={() => switchViewMode('source')}
                  title={withShortcut('โหมดต้นฉบับ', 'view-source')}
                  className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
                    viewMode === 'source'
                      ? 'bg-amber-500 text-black'
                      : 'text-amber-300/60 hover:text-amber-100'
                  }`}
                >
                  ต้นฉบับ
                </button>
                <button
                  type="button"
                  onClick={() => switchViewMode('edited')}
                  title={withShortcut('โหมดตัดแล้ว', 'view-edited')}
                  className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
                    viewMode === 'edited'
                      ? 'bg-amber-500 text-black'
                      : 'text-amber-300/60 hover:text-amber-100'
                  }`}
                >
                  ตัดแล้ว
                </button>
              </div>
              <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-2">
                <button
                  type="button"
                  onClick={togglePlay}
                  disabled={!previewSrc}
                  title={isPlaying ? withShortcut('หยุด', 'play') : withShortcut('เล่น', 'play')}
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-amber-500 text-black hover:bg-amber-400 disabled:opacity-30"
                >
                  {isPlaying ? <Pause size={13} /> : <Play size={13} className="ml-0.5" />}
                </button>
                <span ref={timeLabelRef} className="text-[11px] tabular-nums text-amber-300/50">
                  {fmtTime(currentTime)} / {fmtTime(viewMode === 'edited' ? computeEditedDuration(cuts) : videoDuration)}
                </span>
              </div>
            </div>
            <div
              className="scroll-none-clip relative min-h-0 flex-1"
              onPointerDownCapture={(e) => {
                if (!isTimelineScrubTarget(e.target)) return
                const el = e.target as HTMLElement
                // Edited cut-block click selects a scene — only pause once a drag actually starts.
                if (
                  viewMode === 'edited'
                  && el.closest('[data-cut-id]')
                  && !isTimelineEditBlockInteraction(el)
                ) return
                pauseForScrub()
              }}
            >
              <div
                ref={lanesViewportRef}
                data-timeline-scroll
                onPointerDown={onTimelinePointerDown}
                title="ลากเพื่อเลื่อน timeline"
                className="scroll-none absolute inset-x-0 top-0 cursor-grab overflow-x-auto overflow-y-hidden select-none active:cursor-grabbing"
                style={{
                  WebkitOverflowScrolling: 'touch',
                  height: 'calc(100% + 14px)',
                  paddingBottom: 14,
                  marginBottom: -14,
                }}
              >
              {viewMode === 'source' ? (
              <div
                className="space-y-1"
                style={{
                  paddingLeft: lanePadPx,
                  paddingRight: lanePadPx,
                  minWidth: lanePadPx * 2 + getPlayDuration(previewSource) * PX_PER_SEC,
                }}
              >
                {timeline.sources.map((src) => {
                  const laneDurationSec = getSourceDurationSec(src.id)
                  return (
                    <SourceLane
                      key={src.id}
                      source={src}
                      laneDurationSec={laneDurationSec}
                      strip={filmstrips[src.id] ?? null}
                      cuts={cuts.filter((c) => c.source === src.id)}
                      selectedId={selectedId}
                      onHighlight={setSelectedId}
                      onSelect={(c) => void selectCut(c)}
                      onChange={updateCut}
                      onDragStart={beginCutBlockEdit}
                      onDragEnd={commitCutBlockEdit}
                      isActive={previewSource === src.id}
                      compact
                    />
                  )
                })}
              </div>
              ) : (
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleSequenceDragEnd}>
                  <SortableContext items={cuts.map((c) => c.id)} strategy={horizontalListSortingStrategy}>
                    <div
                      className="flex items-center overflow-visible"
                      style={{
                        paddingLeft: lanePadPx,
                        paddingRight: lanePadPx,
                        height: LANE_HEIGHT_PX,
                        minWidth: lanePadPx * 2 + Math.max(computeEditedDuration(cuts) * PX_PER_SEC, 1),
                      }}
                    >
                      {cuts.map((c) => (
                        <EditedCutBlock
                          key={c.id}
                          cut={c}
                          selected={c.id === selectedId}
                          filmstrip={filmstrips[c.source] ?? null}
                          sourceDurationSec={timeline.sources.find((s) => s.id === c.source)?.durationSec ?? 0}
                          onHighlight={() => setSelectedId(c.id)}
                          onChange={(patch) => updateCut(c.id, patch)}
                          onDragStart={beginCutBlockEdit}
                          onDragEnd={commitCutBlockEdit}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              )}
              </div>
              {(viewMode === 'source' ? previewSource : selectedId) && (
                <div className="pointer-events-none absolute inset-0 z-20">
                  <div className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.9)]" />
                  <div className="absolute top-0 left-1/2 h-3 w-3 -translate-x-1/2 rotate-45 border border-red-300 bg-red-500 shadow" />
                </div>
              )}
            </div>
          </div>

          {/* Scene sequence — fixed height, horizontal scroll */}
          <div
            className="flex shrink-0 flex-col overflow-hidden border-t border-white/10 px-5 py-2"
            style={{ height: EDITOR_SCENE_BAND_PX }}
          >
            <div className="mb-1.5 flex shrink-0 items-center justify-between gap-2">
              <h3 className="text-xs font-semibold text-amber-200/60 uppercase tracking-widest">
                ลำดับเล่นจริง ({cuts.length} scene
                {isDub ? ` · ${countVoiceoverLines(cuts)} บรรทัด` : ''})
              </h3>
              <button
                type="button"
                onClick={addSceneAtPlayhead}
                title={withShortcut('เพิ่ม scene ที่ตำแหน่งขีดแดง (playhead)', 'add-scene')}
                className="flex shrink-0 items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] font-medium text-amber-200 hover:bg-amber-500/20"
              >
                <Plus size={11} />
                เพิ่ม scene
              </button>
            </div>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleSequenceDragEnd}>
              <SortableContext items={cuts.map((c) => c.id)} strategy={horizontalListSortingStrategy}>
                <ul className="scroll-ghost flex min-h-0 flex-1 gap-2 overflow-x-auto overflow-y-hidden pb-1">
                  {cuts.map((c, i) => (
                    <SequenceItem
                      key={c.id}
                      cut={c}
                      index={i}
                      allCuts={cuts}
                      isDub={isDub}
                      selected={c.id === selectedId}
                      onSelect={() => void selectCut(c)}
                      onDelete={() => deleteCut(c.id)}
                    />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
          </div>

          {/* Voiceover script — fixed height when dub_first */}
          {isDub && selectedCut && (
            <div
              className="flex shrink-0 flex-col overflow-hidden border-t border-white/10 px-5 py-2"
              style={{ height: EDITOR_SCRIPT_BAND_PX }}
            >
              <div className="mb-1 flex shrink-0 items-center justify-between gap-2">
                <h3 className="text-xs font-semibold text-amber-200/60 uppercase tracking-widest">
                  สคริปต์เสียงพากย์ — บรรทัด {cutLineId(selectedCut)}
                  {cutsInLine(cuts, cutLineId(selectedCut)).length > 1 && (
                    <span className="ml-1.5 font-normal normal-case text-amber-300/45">
                      (มุม {cutIndexInLine(cuts, selectedCut)}/{cutsInLine(cuts, cutLineId(selectedCut)).length})
                    </span>
                  )}
                </h3>
                <button
                  type="button"
                  onClick={addMontageCut}
                  title={withShortcut('เพิ่มมุม', 'add-angle')}
                  className="flex shrink-0 items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] font-medium text-amber-200 hover:bg-amber-500/20"
                >
                  <Layers size={11} />
                  เพิ่มมุม
                </button>
              </div>
              <textarea
                value={lineScriptFor(cuts, cutLineId(selectedCut))}
                onChange={(e) => updateLineScript(cutLineId(selectedCut), e.target.value)}
                onFocus={beginEdit}
                onBlur={commitEdit}
                className="min-h-0 flex-1 resize-none rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-amber-50 outline-none focus:border-amber-400/50"
                placeholder="พิมพ์สคริปต์สำหรับบรรทัดนี้ (ใช้ร่วมทุกมุม)…"
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function SourceLane({
  source,
  laneDurationSec,
  strip,
  cuts,
  selectedId,
  onHighlight,
  onSelect,
  onChange,
  onDragStart,
  onDragEnd,
  isActive,
  compact = false,
}: {
  source: { id: string; durationSec: number }
  laneDurationSec: number
  strip: Filmstrip | null
  cuts: WorkingCut[]
  selectedId: string | null
  onHighlight: (id: string) => void
  onSelect: (c: WorkingCut) => void
  onChange: (id: string, patch: Partial<WorkingCut>) => void
  onDragStart: () => void
  onDragEnd: () => void
  isActive: boolean
  compact?: boolean
}) {
  const width = Math.max(laneDurationSec * PX_PER_SEC, 80)
  const thumbWidthPx = strip && strip.thumbs.length > 0
    ? Math.max(strip.tileWidthPx, width / strip.thumbs.length)
    : strip?.tileWidthPx ?? 0

  return (
    <div>
      {!compact && (
        <p className="mb-0.5 text-[10px] text-amber-300/40">{source.id} · {source.durationSec.toFixed(1)}s</p>
      )}
      <div
        className={`relative overflow-hidden rounded-md border bg-zinc-800 ${
          isActive ? 'border-amber-400/40 ring-1 ring-amber-400/30' : 'border-white/10'
        }`}
        style={{ width, height: LANE_HEIGHT_PX }}
      >
        {strip ? (
          <div className="pointer-events-none absolute inset-0 flex opacity-45">
            {strip.thumbs.map((t, i) => (
              <img
                key={i}
                src={t}
                alt=""
                draggable={false}
                className="h-full shrink-0 object-cover"
                style={{ width: thumbWidthPx }}
              />
            ))}
          </div>
        ) : (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[10px] text-amber-300/30">
            กำลังโหลดภาพตัวอย่าง…
          </div>
        )}
        {cuts.map((c) => (
          <CutBlock
            key={c.id}
            cut={c}
            sourceCuts={cuts}
            laneDurationSec={laneDurationSec}
            selected={c.id === selectedId}
            onHighlight={() => onHighlight(c.id)}
            onSelect={() => onSelect(c)}
            onChange={(patch) => onChange(c.id, patch)}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
          />
        ))}
      </div>
    </div>
  )
}

type DragMode = 'move' | 'resize-left' | 'resize-right'

type TrimEdge = 'left' | 'right'

/** Window-level trim drag — reliable even when the pointer leaves the small diamond handle. */
function bindTrimDrag(opts: {
  e: React.PointerEvent
  edge: TrimEdge
  startIn: number
  startOut: number
  minIn?: number
  maxOut: number
  onChange: (patch: Partial<WorkingCut>) => void
  onDragStart: () => void
  onDragEnd: () => void
}) {
  opts.e.stopPropagation()
  opts.e.preventDefault()
  opts.onDragStart()
  const startX = opts.e.clientX
  const { startIn, startOut, minIn = 0, maxOut, edge, onChange, onDragEnd } = opts

  function onMove(ev: PointerEvent) {
    const deltaSec = (ev.clientX - startX) / PX_PER_SEC
    if (edge === 'left') {
      onChange({ in: clamp(startIn + deltaSec, minIn, startOut - MIN_CUT_SEC) })
    } else {
      onChange({ out: clamp(startOut + deltaSec, startIn + MIN_CUT_SEC, maxOut) })
    }
  }

  function onUp() {
    onDragEnd()
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
  }

  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp)
}

/** CapCut-style diamond trim handle — only shown on the focused scene. */
function SceneTrimHandle({
  edge,
  onTrimDown,
}: {
  edge: TrimEdge
  onTrimDown: (e: React.PointerEvent, edge: TrimEdge) => void
}) {
  return (
    <button
      type="button"
      data-cut-trim-handle
      data-cut-resize-handle
      title={edge === 'left' ? 'ลากเพื่อปรับจุดเริ่ม' : 'ลากเพื่อปรับจุดจบ'}
      onPointerDown={(e) => onTrimDown(e, edge)}
      className={`absolute top-1/2 z-30 flex h-6 w-6 -translate-y-1/2 cursor-ew-resize touch-none items-center justify-center ${
        edge === 'left' ? '-left-3' : '-right-3'
      }`}
    >
      <span className="block h-2.5 w-2.5 rotate-45 border border-amber-100 bg-amber-300 shadow-md shadow-black/50" />
    </button>
  )
}

function CutBlock({
  cut,
  sourceCuts,
  laneDurationSec,
  selected,
  onHighlight,
  onSelect,
  onChange,
  onDragStart,
  onDragEnd,
}: {
  cut: WorkingCut
  sourceCuts: EditCut[]
  laneDurationSec: number
  selected: boolean
  onHighlight: () => void
  onSelect: () => void
  onChange: (patch: Partial<WorkingCut>) => void
  onDragStart: () => void
  onDragEnd: () => void
}) {
  const bounds = sourceNeighborBounds(cut, sourceCuts, laneDurationSec)
  const dragState = useRef<{
    mode: DragMode
    startX: number
    startIn: number
    startOut: number
    moved: boolean
  } | null>(null)

  function onPointerDown(mode: DragMode) {
    return (e: React.PointerEvent) => {
      e.stopPropagation()
      onHighlight()
      onDragStart()
      dragState.current = {
        mode,
        startX: e.clientX,
        startIn: cut.in,
        startOut: cut.out,
        moved: false,
      }
      const target = e.currentTarget as HTMLElement
      target.setPointerCapture(e.pointerId)
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = dragState.current
    if (!d) return
    if (Math.abs(e.clientX - d.startX) > 3) d.moved = true
    const deltaSec = (e.clientX - d.startX) / PX_PER_SEC
    if (d.mode === 'move') {
      const dur = d.startOut - d.startIn
      const newIn = clamp(d.startIn + deltaSec, bounds.minIn, bounds.maxOut - dur)
      onChange({ in: newIn, out: newIn + dur })
    } else if (d.mode === 'resize-left') {
      onChange({ in: clamp(d.startIn + deltaSec, bounds.minIn, d.startOut - MIN_CUT_SEC) })
    } else {
      onChange({ out: clamp(d.startOut + deltaSec, d.startIn + MIN_CUT_SEC, bounds.maxOut) })
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    const d = dragState.current
    if (d?.moved === false) onSelect()
    if (d) onDragEnd()
    dragState.current = null
    const target = e.currentTarget as HTMLElement
    if (target.hasPointerCapture(e.pointerId)) target.releasePointerCapture(e.pointerId)
  }

  const left = cut.in * PX_PER_SEC
  const width = Math.max((cut.out - cut.in) * PX_PER_SEC, 6)

  return (
    <div
      data-cut-block
      onPointerDown={onPointerDown('move')}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      className={`absolute top-1 bottom-1 cursor-grab rounded-md border px-1 text-[10px] leading-tight active:cursor-grabbing ${
        selected
          ? 'border-amber-300 bg-amber-500/70 text-black'
          : 'border-amber-500/50 bg-amber-500/30 text-amber-100'
      }`}
      style={{ left, width }}
    >
      {selected && (
        <>
          <SceneTrimHandle
            edge="left"
            onTrimDown={(e) => bindTrimDrag({
              e,
              edge: 'left',
              startIn: cut.in,
              startOut: cut.out,
              minIn: bounds.minIn,
              maxOut: bounds.maxOut,
              onChange,
              onDragStart,
              onDragEnd,
            })}
          />
          <SceneTrimHandle
            edge="right"
            onTrimDown={(e) => bindTrimDrag({
              e,
              edge: 'right',
              startIn: cut.in,
              startOut: cut.out,
              minIn: bounds.minIn,
              maxOut: bounds.maxOut,
              onChange,
              onDragStart,
              onDragEnd,
            })}
          />
        </>
      )}
      <p className="truncate pt-3">{cut.label || 'scene'}</p>
    </div>
  )
}

/**
 * Concatenated "edited" view of a scene: a cropped window of its source's full
 * filmstrip so scenes read as trimmed clips laid back-to-back, no gaps.
 */
function EditedCutBlock({
  cut,
  selected,
  filmstrip,
  sourceDurationSec,
  onHighlight,
  onChange,
  onDragStart,
  onDragEnd,
}: {
  cut: WorkingCut
  selected: boolean
  filmstrip: Filmstrip | null
  sourceDurationSec: number
  onHighlight: () => void
  onChange: (patch: Partial<WorkingCut>) => void
  onDragStart: () => void
  onDragEnd: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: cut.id })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 30 : undefined,
  }
  const durationSec = Math.max(cut.out - cut.in, 0)
  const widthPx = Math.max(durationSec * PX_PER_SEC, 28)
  const fullSourcePx = Math.max(sourceDurationSec * PX_PER_SEC, 80)
  const thumbWidthPx = filmstrip && filmstrip.thumbs.length > 0
    ? Math.max(filmstrip.tileWidthPx, fullSourcePx / filmstrip.thumbs.length)
    : filmstrip?.tileWidthPx ?? 0

  const maxOut = Math.max(sourceDurationSec, cut.out)

  function onTrimDown(e: React.PointerEvent, edge: TrimEdge) {
    onHighlight()
    bindTrimDrag({
      e,
      edge,
      startIn: cut.in,
      startOut: cut.out,
      minIn: 0,
      maxOut,
      onChange,
      onDragStart,
      onDragEnd,
    })
  }

  return (
    <li
      ref={setNodeRef}
      data-cut-block
      data-cut-id={cut.id}
      style={{ ...style, width: widthPx, height: LANE_HEIGHT_PX }}
      className={`relative shrink-0 list-none ${selected ? 'z-20' : 'z-0'}`}
    >
      <div
        className={`relative h-full w-full cursor-grab overflow-hidden rounded-md border active:cursor-grabbing ${
          selected ? 'border-amber-300 ring-1 ring-amber-300/60' : 'border-amber-500/40'
        }`}
      >
        <div
          className="pointer-events-none absolute inset-y-0"
          style={{ width: fullSourcePx, left: -cut.in * PX_PER_SEC }}
        >
          {filmstrip ? (
            <div className="absolute inset-0 flex opacity-60">
              {filmstrip.thumbs.map((t, i) => (
                <img
                  key={i}
                  src={t}
                  alt=""
                  draggable={false}
                  className="h-full shrink-0 object-cover"
                  style={{ width: thumbWidthPx }}
                />
              ))}
            </div>
          ) : (
            <div className="absolute inset-0 bg-zinc-800" />
          )}
        </div>
        <div className="pointer-events-none absolute inset-0 bg-linear-to-t from-black/60 via-black/5 to-transparent" />
        <p className="pointer-events-none absolute bottom-0.5 left-1 right-1 truncate text-[9px] font-medium text-amber-50">
          {cut.label || 'scene'}
        </p>
        <button
          type="button"
          data-timeline-reorder-handle
          {...attributes}
          {...listeners}
          onClick={(e) => e.stopPropagation()}
          title="ลากเพื่อสลับตำแหน่ง"
          className="absolute left-1/2 top-0.5 flex h-4 w-6 -translate-x-1/2 cursor-grab touch-none items-center justify-center rounded bg-black/40 text-white/60 hover:text-amber-300 active:cursor-grabbing"
        >
          <GripVertical size={10} className="rotate-90" />
        </button>
      </div>
      {selected && (
        <>
          <SceneTrimHandle edge="left" onTrimDown={onTrimDown} />
          <SceneTrimHandle edge="right" onTrimDown={onTrimDown} />
        </>
      )}
    </li>
  )
}

function SequenceItem({
  cut,
  index,
  allCuts,
  isDub,
  selected,
  onSelect,
  onDelete,
}: {
  cut: WorkingCut
  index: number
  allCuts: WorkingCut[]
  isDub: boolean
  selected: boolean
  onSelect: () => void
  onDelete: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: cut.id })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.55 : 1,
  }
  const lineId = cutLineId(cut)
  const lineCuts = cutsInLine(allCuts, lineId)
  const angleIdx = cutIndexInLine(allCuts, cut)
  const badgeLabel = isDub ? String(lineId) : String(index + 1)
  const subLabel = isDub && lineCuts.length > 1
    ? `มุม ${angleIdx}/${lineCuts.length} · ${(cut.out - cut.in).toFixed(1)}s`
    : `${(cut.out - cut.in).toFixed(1)}s`

  return (
    <li
      ref={setNodeRef}
      style={style}
      onClick={onSelect}
      className={`flex w-36 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border px-2 py-2 text-[11px] ${
        selected ? 'border-amber-300 bg-amber-500/20' : 'border-white/10 bg-white/5'
      }`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        onClick={(e) => e.stopPropagation()}
        className="cursor-grab touch-none text-white/30 hover:text-amber-300 active:cursor-grabbing"
      >
        <GripVertical size={12} />
      </button>
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-500/20 text-[10px] font-bold text-amber-200">
        {badgeLabel}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-amber-100/90">
          {isDub ? `บรรทัด ${lineId}${lineCuts.length > 1 ? ` · มุม ${angleIdx}` : ''}` : (cut.label || cut.source)}
        </p>
        <p className="text-amber-300/40">{subLabel}</p>
      </div>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onDelete() }}
        className="shrink-0 text-white/30 hover:text-red-400"
      >
        <Trash2 size={12} />
      </button>
    </li>
  )
}
