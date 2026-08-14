/**
 * Video timeline editor — R3.
 *
 * Three regions: video stage (centre) + inspector (right) + timeline (bottom).
 * The timeline is STATIC with a MOVING playhead: `currentTime` is the source
 * of truth and the playhead is a positioned element painted imperatively —
 * scrolling the timeline never changes the time (the pre-R3 editor was the
 * inverse: a fixed centre playhead with `scrollLeft` as the clock).
 *
 * Time domains:
 * - edited (ตัดแล้ว): t ∈ [0, sum of cut durations], cuts back-to-back.
 * - source (ต้นฉบับ): t is LOCAL to the active source file; files stack as
 *   parallel lanes sharing one time axis (R3 sub-frame จ), so there is no
 *   concatenated "global" source domain anymore.
 *
 * Pure geometry/edit math lives in lib/timelineMath.ts (unit-tested).
 */
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors
} from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  AlertTriangle,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  HelpCircle,
  Loader2,
  Magnet,
  Maximize2,
  Music2,
  Plus,
  Redo2,
  RefreshCw,
  Save,
  Scissors,
  Sparkles,
  Trash2,
  Undo2,
  Volume2,
  VolumeX
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  editorApi,
  initialCaptionLines,
  initialCaptionTimeBase,
  initialCaptionStyle,
  initialMusic,
  type CaptionLine,
  type EditCut,
  type EditorMusic,
  type EditTimeline,
  type MusicPatch
} from '../lib/editorApi'
import { formatUserError } from '../lib/editorApi'
import { CAPTION_FONTS, CAPTION_MODES, type CaptionStyle } from '../lib/captionStyle'
import { captionLinesToSrt } from '../lib/captionLines'
import {
  BASE_PX_PER_SEC,
  MIN_CUT_SEC,
  DEFAULT_NEW_CUT_SEC,
  bindTrimDrag,
  captionChipSpans,
  captionChipSpansFromOutput,
  dragCaptionEdge,
  clamp,
  computeEditedDuration,
  computeEditedSegments,
  cutIndexInLine,
  cutLineId,
  cutsInLine,
  findEditedSegment,
  findSourceCutAtTime,
  fmtTime,
  fmtTimeTenths,
  lineScriptFor,
  mapSourceTimeToOutput,
  nextVoiceoverLineId,
  normalizeDubCuts,
  parseTimecode,
  removedSpanStats,
  rulerStepSec,
  BEAT_SNAP_THRESHOLD_SEC,
  snapCandidateToBeat,
  snapMusicOffsetToCut,
  snapToMarkers,
  cutBoundariesSec,
  sourceNeighborBounds,
  splitCutAt,
  voiceoverLineBlocks,
  type CaptionChipSpan,
  type TrimEdge
} from '../lib/timelineMath'
import { decodeAudioPeaks } from '../lib/waveform'
import { OverlayTitleBarSpacer } from './OverlayTitleBarSpacer'
import { CaptionPanel } from './wizard/CaptionPanel'
import { Button } from './ui/Button'
import { Dialog } from './ui/Dialog'
import { Slider } from './ui/Slider'
import { Tabs } from './ui/Tabs'
import { useFxJobs } from '../lib/fxJobs'
import { useUnsavedGuard } from '../lib/unsavedGuard'
import {
  sameCaptionStyle,
  sameMusic,
  sameSnapshot,
  type EditorSnapshot
} from '../lib/editorHistory'
import { paintSeekProgress } from '../lib/seekProgress'
import { VideoTransport } from './ui/VideoTransport'
import { Textarea } from './ui/Input'

// ---- geometry constants (R3: ruler + lanes line up at 40px per second) -----
// HANDOFF §3 Timeline primitives — these five are a spec, not taste: the ruler,
// the header column and every lane are drawn from them, so changing one without
// the others puts the labels out of line with the footage.
const HEADER_COL_PX = 92
const RULER_PX = 22
const IMG_LANE_PX = 40
const VO_LANE_PX = 32
const MUSIC_LANE_PX = 32
const CAPTION_LANE_PX = 24
const TRACK_GAP_PX = 3
/** Empty room after the last block so the end of the cut is grabbable. */
const TAIL_PX = 160
const MIN_LANE_PX = 80
const MIN_PX_PER_SEC = 4
const MAX_PX_PER_SEC = 160
/** One video frame at the 30fps the pipeline renders — the ←/→ nudge unit. */
const FRAME_SEC = 1 / 30

interface Props {
  uid: string
  mode: string
  /** Shown in the overlay's own title strip, like the shell's would be. */
  projectName?: string
  onClose: () => void
  /** Called after a successful save — caller should re-poll project status. */
  onSaved: () => void
}

type WorkingCut = EditCut

function captionStyleSummary(style: CaptionStyle): string {
  const font = CAPTION_FONTS.find((f) => f.value === style.font)?.label ?? style.font
  const mode = CAPTION_MODES.find((m) => m.value === style.mode)?.label ?? style.mode
  return `${font} · ${mode} · ขนาด ${style.size}`
}

interface ViewModePlaybackState {
  currentTime: number
  selectedId: string | null
  previewSource: string | null
  editedActiveCutId: string | null
  playRange: { in: number; out: number } | null
  wasPlaying: boolean
}

const IS_MAC =
  typeof navigator !== 'undefined' &&
  (navigator.platform.includes('Mac') || navigator.userAgent.includes('Mac'))

type ShortcutKeyPart =
  { type: 'mod' } | { type: 'shift' } | { type: 'key'; code?: string; key?: string }

type ShortcutCategory = 'playback' | 'view' | 'edit'

interface ShortcutDisplayDef {
  id: string
  category: ShortcutCategory
  labelTh: string
  parts: ShortcutKeyPart[]
  dubOnly?: boolean
}

/** R3 sheet ข — grouped เล่น / มุมมอง / แก้ไข. */
const SHORTCUT_DISPLAY: ShortcutDisplayDef[] = [
  {
    id: 'play',
    category: 'playback',
    labelTh: 'เล่น / หยุด',
    parts: [{ type: 'key', code: 'Space' }]
  },
  {
    id: 'frame-back',
    category: 'playback',
    labelTh: 'ถอย / เดินหน้า 1 เฟรม',
    parts: [
      { type: 'key', code: 'ArrowLeft' },
      { type: 'key', code: 'ArrowRight' }
    ]
  },
  {
    id: 'jump-back',
    category: 'playback',
    labelTh: 'ถอย / เดินหน้า 1 วิ',
    parts: [
      { type: 'shift' },
      { type: 'key', code: 'ArrowLeft' },
      { type: 'key', code: 'ArrowRight' }
    ]
  },
  {
    id: 'home',
    category: 'playback',
    labelTh: 'ต้นคลิป / ท้ายคลิป',
    parts: [
      { type: 'key', code: 'Home' },
      { type: 'key', code: 'End' }
    ]
  },
  {
    id: 'view-source',
    category: 'view',
    labelTh: 'ดูคลิปต้นฉบับ',
    parts: [{ type: 'mod' }, { type: 'key', code: 'Digit1' }]
  },
  {
    id: 'view-edited',
    category: 'view',
    labelTh: 'ดูแบบตัดแล้ว',
    parts: [{ type: 'mod' }, { type: 'key', code: 'Digit2' }]
  },
  {
    id: 'shortcuts-help',
    category: 'view',
    labelTh: 'เปิด–ปิดแผ่นนี้',
    parts: [{ type: 'key', key: '?' }]
  },
  {
    id: 'split',
    category: 'edit',
    labelTh: 'แยกฉากที่หัวเล่น',
    parts: [{ type: 'key', code: 'KeyS' }]
  },
  {
    id: 'add-scene',
    category: 'edit',
    labelTh: 'เพิ่มฉากที่หัวเล่น',
    parts: [{ type: 'key', code: 'KeyN' }]
  },
  {
    id: 'add-angle',
    category: 'edit',
    labelTh: 'เพิ่มมุมให้ประโยคนี้',
    parts: [{ type: 'key', code: 'KeyM' }],
    dubOnly: true
  },
  {
    id: 'set-in',
    category: 'edit',
    labelTh: 'ตั้งจุดเข้า / จุดออก',
    parts: [
      { type: 'key', code: 'BracketLeft' },
      { type: 'key', code: 'BracketRight' }
    ]
  },
  {
    id: 'delete',
    category: 'edit',
    labelTh: 'ลบฉากที่เลือก',
    parts: [{ type: 'key', code: 'Delete' }]
  },
  {
    id: 'undo',
    category: 'edit',
    labelTh: 'เลิกทำ / ทำซ้ำ',
    parts: [
      { type: 'mod' },
      { type: 'key', code: 'KeyZ' },
      { type: 'mod' },
      { type: 'key', code: 'KeyY' }
    ]
  },
  {
    id: 'save',
    category: 'edit',
    labelTh: 'บันทึกและเรนเดอร์',
    parts: [{ type: 'mod' }, { type: 'key', code: 'KeyS' }]
  },
  {
    id: 'escape',
    category: 'edit',
    labelTh: 'ปิดหน้านี้',
    parts: [{ type: 'key', code: 'Escape' }]
  }
]

const SHORTCUT_CATEGORY_TITLES: Record<ShortcutCategory, string> = {
  playback: 'เล่น',
  view: 'มุมมอง',
  edit: 'แก้ไข'
}

/** The shortcut letter, drawn beside a toolbar label in muted (R3 toolbar). */
function ShortcutKey({ id }: { id: string }): React.JSX.Element | null {
  const def = SHORTCUT_DISPLAY.find((s) => s.id === id)
  if (!def) return null
  return <span className="text-muted">{formatShortcut(def.parts)}</span>
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

/**
 * A shortcut's keys as one string.
 *
 * Modifier+key is a chord and joins tight ("⌘Z" / "Ctrl+Z"); a second key after
 * a complete chord is an ALTERNATIVE ("← →", "Home End", "⌘Z ⌘Y") and is space
 * separated, or the sheet reads "Home+End" as if both were pressed together.
 */
function formatShortcut(parts: ShortcutKeyPart[]): string {
  const groups: ShortcutKeyPart[][] = []
  for (const p of parts) {
    const last = groups[groups.length - 1]
    // A new group starts on a modifier that follows a finished chord, or on a
    // second plain key.
    if (!last || last.some((q) => q.type === 'key')) groups.push([p])
    else last.push(p)
  }
  return groups
    .map((g) => {
      const bits = g.map(formatKeyPart)
      return IS_MAC ? bits.join('') : bits.join('+')
    })
    .join(' ')
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

/** R3 sheet ข — two-column grouped shortcut sheet on the Dialog primitive. */
function ShortcutsSheet({ isDub, onClose }: { isDub: boolean; onClose: () => void }) {
  const categories = Object.keys(SHORTCUT_CATEGORY_TITLES) as ShortcutCategory[]
  return (
    <Dialog open onClose={onClose} title="แป้นพิมพ์ลัด" width={640}>
      <div className="grid grid-cols-2 gap-x-10 gap-y-6">
        {categories.map((cat) => {
          const items = SHORTCUT_DISPLAY.filter((s) => s.category === cat && (!s.dubOnly || isDub))
          if (items.length === 0) return null
          return (
            <section key={cat} className={cat === 'edit' ? 'row-span-2' : undefined}>
              <h4 className="mb-2 text-[13px] font-medium tracking-wide text-muted">
                {SHORTCUT_CATEGORY_TITLES[cat]}
              </h4>
              <ul className="space-y-2">
                {items.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-ink">{s.labelTh}</span>
                    <kbd className="shrink-0 font-mono text-[13px] tabular-nums text-muted">
                      {formatShortcut(s.parts)}
                    </kbd>
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
      </div>
      <p className="mt-5 border-t border-divider pt-3 text-[13px] text-muted">
        {IS_MAC ? 'แสดงคีย์ตามระบบ Mac ของคุณ (⌘ = Command)' : 'บน Mac ใช้ ⌘ แทน Ctrl'}
      </p>
    </Dialog>
  )
}

interface AiReeditLine {
  id: number
  script: string
  cutCount: number
}

/** R3 sub-frame ก — pick the sentences, say what to change. */
function AiReeditDialog({
  lines,
  checked,
  onToggle,
  instruction,
  onInstructionChange,
  busy,
  errorMsg,
  onSubmit,
  onClose
}: {
  lines: AiReeditLine[]
  checked: Set<number>
  onToggle: (lineId: number) => void
  instruction: string
  onInstructionChange: (v: string) => void
  busy: boolean
  errorMsg: string | null
  onSubmit: () => void
  onClose: () => void
}) {
  return (
    <Dialog
      open
      onClose={() => {
        if (!busy) onClose()
      }}
      title="ให้ AI แก้ให้"
      subtitle="เลือกประโยคที่อยากให้แก้ แล้วบอกว่าจะแก้อะไร"
      width={560}
    >
      <ul className="mb-4 space-y-2">
        {lines.map((l, i) => {
          const isChecked = checked.has(l.id)
          return (
            <li key={l.id}>
              <label
                className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-sm transition-colors duration-state ${
                  isChecked
                    ? 'border-accent bg-accent-nav text-ink'
                    : 'border-border text-ink hover:border-border-strong'
                }`}
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => onToggle(l.id)}
                  disabled={busy}
                  className="accent-[var(--color-accent)]"
                />
                <span className="w-4 shrink-0 text-right tabular-nums text-muted">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate">
                  {l.script || '(ไม่มีบทพูด)'}
                  {l.cutCount > 1 ? <span className="text-muted"> · {l.cutCount} มุม</span> : null}
                </span>
              </label>
            </li>
          )
        })}
      </ul>
      <p className="mb-1.5 text-[13px] text-muted">อยากให้แก้ว่าอะไร</p>
      {busy ? (
        <Textarea
          value={instruction}
          onChange={(e) => onInstructionChange(e.target.value)}
          disabled
          disabledReason="กำลังแก้ไขอยู่"
          placeholder="เช่น ตัดให้กระชับกว่านี้ · เอาช่วงที่พูดซ้ำออก"
          rows={3}
        />
      ) : (
        <Textarea
          value={instruction}
          onChange={(e) => onInstructionChange(e.target.value)}
          placeholder="เช่น ตัดให้กระชับกว่านี้ · เอาช่วงที่พูดซ้ำออก"
          rows={3}
        />
      )}
      {errorMsg && (
        <p className="mt-2 rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-sm text-error">
          {errorMsg}
        </p>
      )}
      <div className="mt-4 flex items-center justify-end gap-2">
        {busy ? (
          <Button variant="ghost" disabled reasonAs="tooltip" disabledReason="กำลังแก้ไขอยู่">
            ยกเลิก
          </Button>
        ) : (
          <Button variant="ghost" onClick={onClose}>
            ยกเลิก
          </Button>
        )}
        {instruction.trim() ? (
          <Button variant="primary" icon={<Sparkles size={14} />} loading={busy} onClick={onSubmit}>
            {busy ? 'กำลังแก้ไข…' : 'เริ่มแก้'}
          </Button>
        ) : (
          <Button
            variant="primary"
            icon={<Sparkles size={14} />}
            disabled
            disabledReason="พิมพ์คำสั่งก่อนถึงจะเริ่มได้"
          >
            เริ่มแก้
          </Button>
        )}
      </div>
    </Dialog>
  )
}

interface Filmstrip {
  /** Sparse — index `undefined` means that tile hasn't been generated yet (lazy). */
  thumbs: (string | undefined)[]
  /** Display width per tile at BASE_PX_PER_SEC — scaled by the current zoom. */
  tileWidthPx: number
}

// A few extra seconds generated past each edge of the visible viewport, so a small
// scroll doesn't show a blank gap while the next tile is still seeking in.
const FILMSTRIP_PREFETCH_SEC = 6

/** How long auto-follow stays out of the way after the user scrolls. */
const FOLLOW_RESUME_MS = 4000

/** Upper bound on thumbnails per source — see getFilmstripMeta. */
const MAX_FILMSTRIP_TILES = 240

/** Paint captured tiles this often instead of once at the end of a pass. */
const FILMSTRIP_PUBLISH_EVERY = 4

export function VideoTimelineEditor({ uid, mode, projectName, onClose, onSaved }: Props) {
  // AI re-edit runs at app level so leaving the editor doesn't kill it.
  const fxJobs = useFxJobs()
  const [timeline, setTimeline] = useState<EditTimeline | null>(null)
  const [cuts, setCuts] = useState<WorkingCut[]>([])
  const [editorPhase, setEditorPhase] = useState<'loading' | 'preparing' | 'ready'>('loading')
  const [prepareHint, setPrepareHint] = useState('')
  const [error, setError] = useState<string | null>(null)
  // What "ลองอีกครั้ง" on the error bar re-runs — only a failed save is retryable.
  const [errorRetry, setErrorRetry] = useState<'save' | null>(null)
  const [saving, setSaving] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'source' | 'edited'>('edited')
  const [captionLines, setCaptionLines] = useState<CaptionLine[] | null>(null)
  // Which clock the lines are on — see initialCaptionTimeBase. dub_first
  // captions are OUTPUT-timed; treating them as source time dropped all but
  // one chip from the lane (live 2026-08-13).
  const captionsOnOutputClock = initialCaptionTimeBase() === 'output'
  const [captionCursor, setCaptionCursor] = useState(0)
  const [captionStyle, setCaptionStyle] = useState<CaptionStyle | null>(null)
  const [captionStyleOpen, setCaptionStyleOpen] = useState(false)
  const [inspectorTab, setInspectorTab] = useState<'script' | 'caption'>('script')
  // Transport auto-hide, the way a video player does it: on screen while the
  // pointer is on the stage, and for a moment after it stops moving; always on
  // while paused, because then it is the only thing to act on.
  const [transportOn, setTransportOn] = useState(false)
  const transportTimer = useRef<number | undefined>(undefined)
  const showTransport = (): void => {
    setTransportOn(true)
    window.clearTimeout(transportTimer.current)
    transportTimer.current = window.setTimeout(() => setTransportOn(false), 2000)
  }
  useEffect(() => () => window.clearTimeout(transportTimer.current), [])

  const [srtBusy, setSrtBusy] = useState(false)
  const [srtNote, setSrtNote] = useState<string | null>(null)
  // Zoom — px per second of timeline. State (not a constant) because of the
  // px/วิ slider, พอดีจอ and Alt+wheel. Filmstrip tile math stays anchored to
  // BASE_PX_PER_SEC so zooming never regenerates thumbnails.
  const [pxPerSec, setPxPerSec] = useState(BASE_PX_PER_SEC)
  const pxPerSecRef = useRef(BASE_PX_PER_SEC)
  useEffect(() => {
    pxPerSecRef.current = pxPerSec
  }, [pxPerSec])
  /** Scene boundaries in the SAME clock the caption lines are stored in — the
   * window-level drag handler reads this, so it has to be a ref. dub lines are
   * output-time; talking_head lines are source-time (see captionsOnOutputClock),
   * and snapping against the wrong clock would move edges to nonsense. */
  const boundariesRef = useRef<number[]>([])

  // Caption overlay on the preview. Painted imperatively from the rAF loop like
  // the playhead is — a React re-render per frame would fight the video.
  const captionOverlayRef = useRef<HTMLDivElement | null>(null)
  const captionLinesRef = useRef<CaptionLine[] | null>(null)
  const [music, setMusic] = useState<EditorMusic | null>(null)
  const [musicPeaks, setMusicPeaks] = useState<number[] | null>(null)
  const [musicDurationSec, setMusicDurationSec] = useState(0)
  const [snapToBeatEnabled, setSnapToBeatEnabled] = useState(true)
  const [musicBusy, setMusicBusy] = useState(false)
  const [musicDraft, setMusicDraft] = useState<MusicPatch | null>(null)

  // Two <video> elements so the "next" edited-mode segment can be pre-seeked in the
  // background (hidden) and swapped in instantly — avoids the seek/reload freeze that
  // otherwise shows up as a stutter on every cut boundary during playback.
  const videoARef = useRef<HTMLVideoElement>(null)
  const videoBRef = useRef<HTMLVideoElement>(null)
  const activeVideoKeyRef = useRef<'A' | 'B'>('A')
  const bufferPrimedKeyRef = useRef<string | null>(null)
  // The one scroll container (ruler + lanes share it; labels are sticky-left).
  const viewportRef = useRef<HTMLDivElement>(null)
  // Playhead line + transport widgets, all painted imperatively per frame.
  const playheadRef = useRef<HTMLDivElement>(null)
  const seekbarRef = useRef<HTMLInputElement>(null)
  const timeLabelRef = useRef<HTMLSpanElement>(null)
  const isScrubbingRef = useRef(false)
  const wasPlayingBeforeScrubRef = useRef(false)
  const isSourceSwapPendingRef = useRef(false)
  const currentTimeRef = useRef(0)
  const musicAudioRef = useRef<HTMLAudioElement>(null)
  const [videoDuration, setVideoDuration] = useState(0)
  const previewCache = useRef<Map<string, { src: string; cleanup: () => void }>>(new Map())
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  const [previewSource, setPreviewSource] = useState<string | null>(null)
  const playRangeRef = useRef<{ in: number; out: number } | null>(null)
  const resumePlaybackRef = useRef(true)
  const isCutBlockEditingRef = useRef(false)
  const editedActiveCutIdRef = useRef<string | null>(null)
  const cutsRef = useRef<WorkingCut[]>([])
  const viewModeRef = useRef<'source' | 'edited'>('edited')
  const sourceViewStateRef = useRef<ViewModePlaybackState | null>(null)
  const editedViewStateRef = useRef<ViewModePlaybackState | null>(null)
  const newCutCounter = useRef(0)
  const [filmstrips, setFilmstrips] = useState<Record<string, Filmstrip>>({})
  const filmstripsRef = useRef<Record<string, Filmstrip>>({})
  useEffect(() => {
    filmstripsRef.current = filmstrips
  }, [filmstrips])
  const filmstripVideoCache = useRef<Map<string, HTMLVideoElement>>(new Map())
  const filmstripMetaCache = useRef<
    Map<string, { duration: number; tileWidthPx: number; totalTiles: number }>
  >(new Map())
  const filmstripQueueRef = useRef<Map<string, Promise<void>>>(new Map())
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)

  // AI re-edit (dub_first, pre-render only) — selection is by voiceoverLineId.
  const [aiPanelOpen, setAiPanelOpen] = useState(false)
  const [aiChecked, setAiChecked] = useState<Set<number>>(new Set())
  const [aiInstruction, setAiInstruction] = useState('')
  // Busy/error for the AI re-edit come from the app-level job store (the work
  // outlives this screen); only a locally-raised error lives here.
  const [localAiError, setLocalAiError] = useState<string | null>(null)

  // Undo/redo: refs hold the stacks (no re-render needed per push), historyTick
  // forces a re-render so the toolbar buttons' disabled state stays accurate.
  const undoStack = useRef<EditorSnapshot[]>([])
  const redoStack = useRef<EditorSnapshot[]>([])
  const editSnapshot = useRef<EditorSnapshot | null>(null)
  const [, setHistoryTick] = useState(0)
  const [editCount, setEditCount] = useState(0)
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null)
  // Mirrors for the fields a snapshot has to read from event handlers and from
  // inside setCuts updaters (captionLinesRef is declared with the overlay refs).
  const captionStyleRef = useRef<CaptionStyle | null>(null)
  const musicRef = useRef<EditorMusic | null>(null)
  useEffect(() => {
    captionStyleRef.current = captionStyle
  }, [captionStyle])
  useEffect(() => {
    musicRef.current = music
  }, [music])

  const playOrderMap = useMemo(() => new Map(cuts.map((c, i) => [c.id, i + 1])), [cuts])

  /** The state as it is right now, with any part the caller already holds. */
  function snapshotNow(overrides?: Partial<EditorSnapshot>): EditorSnapshot {
    return {
      cuts: cutsRef.current,
      captionLines: captionLinesRef.current,
      captionStyle: captionStyleRef.current,
      music: musicRef.current,
      ...overrides
    }
  }

  function pushHistory(snapshot: EditorSnapshot) {
    undoStack.current.push(snapshot)
    redoStack.current = []
    setEditCount((n) => n + 1)
    setHistoryTick((t) => t + 1)
  }

  /** Cut edits: the caller is inside a setCuts updater and holds the true
   * pre-edit `prev`, which is more reliable than the ref during a batch. */
  function pushUndoSnapshot(prev: WorkingCut[]) {
    pushHistory(snapshotNow({ cuts: prev }))
  }

  /** Everything that is not a cut edit — call BEFORE applying the change. */
  function pushHistoryNow() {
    pushHistory(snapshotNow())
  }

  /** Call at the start of a continuous edit (drag, typing) — pairs with commitEdit(). */
  function beginEdit() {
    editSnapshot.current = snapshotNow({ cuts })
  }

  /** Call at the end of a continuous edit — pushes the pre-edit snapshot onto
   * the undo stack, unless nothing actually changed (focusing a text box and
   * tabbing away must not fill the history with no-ops).
   *
   * The comparison is deferred one tick on purpose: some callers apply their
   * change with a setState and call this in the SAME handler (the caption
   * timecode inputs do), so right now the mirrors still describe the pre-edit
   * state and the edit would look like a no-op. */
  function commitEdit() {
    const before = editSnapshot.current
    editSnapshot.current = null
    if (!before) return
    window.setTimeout(() => {
      if (!sameSnapshot(before, snapshotNow())) pushHistory(before)
    }, 0)
  }

  function beginCutBlockEdit() {
    isCutBlockEditingRef.current = true
    beginEdit()
  }

  function commitCutBlockEdit() {
    isCutBlockEditingRef.current = false
    commitEdit()
  }

  /**
   * Put a snapshot back on screen AND on disk.
   *
   * Caption appearance and the music track are not editor-local: they live on
   * the project and the music mix is re-rendered from them, so restoring them
   * means writing them back through the same seam that changed them. Cuts and
   * caption lines are editor-local until the next save/draft-save.
   */
  async function applySnapshot(next: EditorSnapshot): Promise<void> {
    setCuts(next.cuts)
    cutsRef.current = next.cuts
    setSelectedId((id) => (id && next.cuts.some((c) => c.id === id) ? id : null))
    setCaptionLines(next.captionLines)
    captionLinesRef.current = next.captionLines

    if (!sameCaptionStyle(next.captionStyle, captionStyleRef.current)) {
      setCaptionStyle(next.captionStyle)
      captionStyleRef.current = next.captionStyle
      if (next.captionStyle) {
        void editorApi.updateCaptionStyle(next.captionStyle).catch(() => undefined)
      }
    }

    if (!sameMusic(next.music, musicRef.current)) {
      const target = next.music
      setMusic(target)
      musicRef.current = target
      setMusicDraft(null)
      setMusicBusy(true)
      try {
        await editorApi.setMusic(target)
      } catch (err) {
        setError(formatUserError(err))
        setErrorRetry(null)
      } finally {
        setMusicBusy(false)
      }
    }
  }

  function undo() {
    const prev = undoStack.current.pop()
    if (!prev) return
    redoStack.current.push(snapshotNow())
    setEditCount((n) => n + 1)
    setHistoryTick((t) => t + 1)
    void applySnapshot(prev)
  }

  function redo() {
    const next = redoStack.current.pop()
    if (!next) return
    undoStack.current.push(snapshotNow())
    setEditCount((n) => n + 1)
    setHistoryTick((t) => t + 1)
    void applySnapshot(next)
  }

  useEffect(() => {
    let cancelled = false
    setEditorPhase('loading')
    setPrepareHint('')
    setError(null)
    setFilmstrips({})
    setPreviewSrc(null)
    setPreviewSource(null)
    editorApi
      .getEditTimeline(uid)
      .then(async (t) => {
        if (cancelled) return
        setTimeline(t)
        setCuts(normalizeDubCuts(t.cuts))
        setCaptionLines(initialCaptionLines() ?? null)
        setCaptionStyle(initialCaptionStyle() ?? null)
        setMusic(initialMusic() ?? null)
        setEditorPhase('preparing')
        if (cancelled) return
        const firstCut = t.cuts[0]
        if (firstCut) {
          setSelectedId(firstCut.id)
          editedActiveCutIdRef.current = firstCut.id
          playRangeRef.current = { in: firstCut.in, out: firstCut.out }
          setPrepareHint('กำลังโหลดตัวอย่างเล่น…')
          await loadPreviewFor(firstCut.source)
          if (cancelled) return
          // Wait for the first scene's own thumbnail window before letting the
          // user in — only this bounded window, never the whole clip.
          setPrepareHint('กำลังโหลดภาพตัวอย่าง…')
          const firstSourceDuration =
            t.sources.find((s) => s.id === firstCut.source)?.durationSec ?? firstCut.out
          await fillFilmstripRange(firstCut.source, firstSourceDuration, firstCut.in, firstCut.out)
        }
        if (!cancelled) setEditorPhase('ready')
      })
      .catch((e) => {
        if (!cancelled) {
          setError(formatUserError(e))
          setEditorPhase('ready')
        }
      })
    return () => {
      cancelled = true
    }
  }, [uid])

  useEffect(() => {
    return () => {
      previewCache.current.forEach((v) => v.cleanup())
      previewCache.current.clear()
    }
  }, [])

  useEffect(() => {
    cutsRef.current = cuts
  }, [cuts])
  useEffect(() => {
    viewModeRef.current = viewMode
  }, [viewMode])
  // Repaint on every caption edit so the overlay shows the text being typed.
  useEffect(() => {
    captionLinesRef.current = captionLines
    syncCaptionOverlay()
  }, [captionLines])
  useEffect(() => {
    applyVideoVisibility()
  }, [])

  // Keep the hidden buffer video pre-seeked to whatever cut plays next.
  useEffect(() => {
    if (viewMode !== 'edited' || editorPhase !== 'ready') return
    primeNextSegment()
  }, [viewMode, editorPhase, selectedId, cuts])

  // Smooth playhead — rAF paints the positioned playhead + transport directly
  // (no React re-render per frame).
  useEffect(() => {
    if (!isPlaying) return
    let raf = 0
    const tick = () => {
      const v = activeVideo()
      if (v && !v.paused && !isScrubbingRef.current && !isSourceSwapPendingRef.current) {
        if (viewMode === 'edited' && maybeAdvanceEditedSegment(v)) {
          raf = requestAnimationFrame(tick)
          return
        }
        let t: number
        if (viewMode === 'edited') {
          const cut = currentEditedCut()
          const seg = cut ? computeEditedSegments(cuts).find((s) => s.cut.id === cut.id) : null
          t = seg
            ? clamp(seg.editedIn + (v.currentTime - cut!.in), 0, computeEditedDuration(cuts))
            : 0
        } else {
          t = clamp(v.currentTime, 0, getActiveDurationSec())
        }
        currentTimeRef.current = t
        paintTime(t)
        followPlayhead(t)
        syncFocusToPlayhead(t)
        syncMusicAudio(t, true)
        syncCaptionOverlay()
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [isPlaying, previewSrc, previewSource, videoDuration, timeline, viewMode, cuts, pxPerSec])

  function getSourceDurationSec(sourceId: string | null): number {
    if (!timeline || !sourceId) return videoDuration
    const meta = timeline.sources.find((s) => s.id === sourceId)?.durationSec ?? 0
    const maxCutOut = cuts
      .filter((c) => c.source === sourceId)
      .reduce((m, c) => Math.max(m, c.out), 0)
    const loadedVideo = previewSource === sourceId ? videoDuration : 0
    return Math.max(meta, loadedVideo, maxCutOut)
  }

  /** Longest source file — the shared time axis all source lanes sit under. */
  function getSourceAxisDurationSec(): number {
    if (!timeline) return videoDuration
    return timeline.sources.reduce((m, s) => Math.max(m, getSourceDurationSec(s.id)), 0)
  }

  /** Total duration of the domain the playhead currently lives in. Source mode
   * is LOCAL to the active file (lanes share the axis, the clock is the file's). */
  function getActiveDurationSec(): number {
    return viewMode === 'edited' ? computeEditedDuration(cuts) : getSourceDurationSec(previewSource)
  }

  /** Width of the drawable timeline content (excludes the sticky label column). */
  function getContentWidthPx(): number {
    const axis = viewMode === 'edited' ? computeEditedDuration(cuts) : getSourceAxisDurationSec()
    return Math.max(axis * pxPerSec, MIN_LANE_PX) + TAIL_PX
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
    if (a) {
      a.style.opacity = aIsActive ? '1' : '0'
      a.style.zIndex = aIsActive ? '2' : '1'
    }
    if (b) {
      b.style.opacity = aIsActive ? '0' : '1'
      b.style.zIndex = aIsActive ? '1' : '2'
    }
  }

  function bufferKeyFor(cut: WorkingCut): string {
    return `${cut.id}:${cut.source}:${cut.in}`
  }

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
        if (bufferPrimedKeyRef.current === key) bufferPrimedKeyRef.current = null
      }
    })()
  }

  /** Seek the active <video> to a position on the active timeline domain.
   * Source mode is local to the active file, so no clip-boundary crossing —
   * cross-file moves happen only through selectCut (clicking another lane). */
  function seekActiveTime(t: number) {
    if (viewMode !== 'edited') {
      const v = activeVideo()
      if (v) v.currentTime = clamp(t, 0, getActiveDurationSec())
      return
    }
    const seg = findEditedSegment(cuts, t)
    if (!seg) return
    const localTime = clamp(seg.cut.in + (t - seg.editedIn), seg.cut.in, seg.cut.out)
    editedActiveCutIdRef.current = seg.cut.id
    if (previewSource !== seg.cut.source) {
      isSourceSwapPendingRef.current = true
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
      paintTime(dur)
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
      isSourceSwapPendingRef.current = true
      void loadPreviewFor(next.source)
    } else {
      v.currentTime = next.in
      if (v.paused) void v.play()
    }
    primeNextSegment()
    return true
  }

  /** Paint the playhead line + transport clock + seekbar for time `t` — all
   * imperative; React state is only touched on discrete events. */
  function paintTime(t: number) {
    const px = pxPerSecRef.current
    if (playheadRef.current) {
      playheadRef.current.style.transform = `translateX(${HEADER_COL_PX + t * px}px)`
    }
    if (seekbarRef.current && !isScrubbingSeekbarRef.current) {
      seekbarRef.current.value = String(t)
      // The value is written straight to the DOM, so the played-portion fill
      // has to be pushed the same way — React never re-renders this input.
      paintSeekProgress(seekbarRef.current)
    }
    if (timeLabelRef.current) {
      timeLabelRef.current.textContent = `${fmtTimeTenths(t)} / ${fmtTime(getActiveDurationSec())}`
    }
  }
  const isScrubbingSeekbarRef = useRef(false)

  /**
   * Until when auto-follow stays out of the way, in ms (performance.now).
   *
   * Following the playhead is right by default, but during playback it fought
   * anyone trying to look somewhere else: drag the scrollbar to 2:00 while the
   * head is at 0:05 and the next frame yanks it straight back, so the far end
   * of a long clip was unreachable without pausing (live report 2026-08-13).
   * A hand on the scrollbar suspends the follow, and it resumes on its own.
   */
  const followSuspendedUntilRef = useRef(0)

  /** Called from the viewport's own scroll/wheel handlers when the SCROLL was
   * the user's doing — the follow's own writes are marked so they don't
   * suspend it (see onViewportScroll). */
  function suspendFollow(): void {
    followSuspendedUntilRef.current = performance.now() + FOLLOW_RESUME_MS
  }

  /** Re-arm the follow now. Anything that means "take me to this moment" —
   * picking a scene, jumping to a line, switching view — is the user asking to
   * be moved, so it must not sit out the suspension from an earlier scroll. */
  function resumeFollow(): void {
    followSuspendedUntilRef.current = 0
  }

  /** Set while followPlayhead itself writes scrollLeft, so the scroll event it
   * causes is not mistaken for the user scrolling. */
  const autoScrollingRef = useRef(false)

  /** Keep the playhead on screen while playing — nudge scrollLeft only when it
   * leaves the viewport (scroll position itself never means anything now). */
  function followPlayhead(t: number) {
    const el = viewportRef.current
    if (!el) return
    if (performance.now() < followSuspendedUntilRef.current) return
    const x = HEADER_COL_PX + t * pxPerSecRef.current
    const leftEdge = el.scrollLeft + HEADER_COL_PX + 16
    const rightEdge = el.scrollLeft + el.clientWidth - 48
    if (x < leftEdge || x > rightEdge) {
      autoScrollingRef.current = true
      el.scrollLeft = Math.max(0, x - HEADER_COL_PX - 16)
      // Cleared after the scroll event this write queues has been delivered.
      requestAnimationFrame(() => {
        autoScrollingRef.current = false
      })
    }
  }

  /** One scroll listener for the viewport: a scroll this component did not
   * cause is the user looking around, and pauses the follow. */
  function onViewportScroll(): void {
    if (autoScrollingRef.current) return
    suspendFollow()
  }

  function applyScrubTime(sec: number, seekVideo: boolean) {
    const dur = getActiveDurationSec()
    const t = clamp(sec, 0, dur)
    currentTimeRef.current = t
    setCurrentTime(t)
    paintTime(t)
    if (seekVideo) seekActiveTime(t)
    syncFocusToPlayhead(t)
    syncMusicAudio(t, false)
  }

  /** Highlight the scene under the playhead (edited sequence or source lane). */
  function syncFocusToPlayhead(t: number) {
    if (isCutBlockEditingRef.current) return

    let focusId: string | null
    if (viewMode === 'edited') {
      focusId = findEditedSegment(cuts, t)?.cut.id ?? null
    } else {
      focusId = findSourceCutAtTime(cuts, previewSource, t)?.id ?? null
    }

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

  /** clientX → timeline seconds, via the scroll container's content box. */
  function timeAtClientX(clientX: number): number {
    const el = viewportRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    const contentX = clientX - rect.left + el.scrollLeft - HEADER_COL_PX
    return clamp(contentX / pxPerSecRef.current, 0, getActiveDurationSec())
  }

  /** Ruler / playhead-grip drag: scrub while moving, commit + resume on release. */
  function onRulerPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return
    e.preventDefault()
    pauseForScrub()
    applyScrubTime(timeAtClientX(e.clientX), true)
    const onMove = (ev: PointerEvent) => {
      applyScrubTime(timeAtClientX(ev.clientX), true)
    }
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      applyScrubTime(timeAtClientX(ev.clientX), true)
      resumeAfterScrub()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  /** Click on empty lane background = move the playhead there. Blocks and
   * handles stopPropagation, so anything that reaches this IS background. */
  function onLaneBackgroundPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest('[data-cut-block]') || target.closest('[data-trim-handle]')) return
    onRulerPointerDown(e)
  }

  /** Alt+wheel zoom, anchored so the time under the cursor stays put. */
  function onTimelineWheel(e: React.WheelEvent) {
    if (!e.altKey) return
    e.preventDefault()
    const el = viewportRef.current
    if (!el) return
    const anchorTime = timeAtClientX(e.clientX)
    const factor = Math.pow(1.0015, -e.deltaY)
    const next = clamp(pxPerSecRef.current * factor, MIN_PX_PER_SEC, MAX_PX_PER_SEC)
    const rect = el.getBoundingClientRect()
    const pointerVX = e.clientX - rect.left
    setPxPerSec(next)
    // scrollLeft so that anchorTime lands back under the pointer.
    requestAnimationFrame(() => {
      el.scrollLeft = Math.max(0, HEADER_COL_PX + anchorTime * next - pointerVX)
    })
  }

  function fitToScreen() {
    const el = viewportRef.current
    const dur = viewMode === 'edited' ? computeEditedDuration(cuts) : getSourceAxisDurationSec()
    if (!el || dur <= 0) return
    const usable = Math.max(el.clientWidth - HEADER_COL_PX - TAIL_PX, 120)
    setPxPerSec(clamp(usable / dur, MIN_PX_PER_SEC, MAX_PX_PER_SEC))
    el.scrollLeft = 0
  }

  // Zoom or view-mode change moves where the playhead must be drawn.
  useEffect(() => {
    paintTime(currentTimeRef.current)
  }, [pxPerSec, viewMode, editorPhase, cuts, videoDuration])

  // Source mode: load filmstrip tiles for whatever's actually visible (plus a
  // small prefetch margin). All lanes share the axis, so one visible window
  // covers every file.
  useEffect(() => {
    if (viewMode !== 'source' || editorPhase !== 'ready' || !timeline) return
    const el = viewportRef.current
    if (!el) return
    let raf = 0
    const handler = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const px = pxPerSecRef.current
        const startSec = Math.max((el.scrollLeft - HEADER_COL_PX) / px - FILMSTRIP_PREFETCH_SEC, 0)
        const endSec =
          (el.scrollLeft + el.clientWidth - HEADER_COL_PX) / px + FILMSTRIP_PREFETCH_SEC
        for (const src of timeline.sources) {
          const dur = getSourceDurationSec(src.id)
          if (startSec >= dur) continue
          queueFilmstripRange(src.id, dur, startSec, Math.min(endSec, dur))
        }
      })
    }
    handler()
    el.addEventListener('scroll', handler, { passive: true })
    return () => {
      cancelAnimationFrame(raf)
      el.removeEventListener('scroll', handler)
    }
  }, [viewMode, editorPhase, timeline, cuts, pxPerSec])

  // Decode the attached music file client-side into a peak array for the
  // waveform canvas (shared with the wizard's MusicRangePicker).
  useEffect(() => {
    if (!music?.path) {
      setMusicPeaks(null)
      setMusicDurationSec(0)
      return
    }
    let cancelled = false
    const src = window.noey.media.urlFor(uid, music.path)
    void decodeAudioPeaks(src)
      .then(({ peaks, durationSec }) => {
        if (cancelled) return
        setMusicPeaks(peaks)
        setMusicDurationSec(durationSec)
      })
      .catch(async (err: unknown) => {
        void window.noey.log.write('TimelineEditor', `music waveform decode failed: ${String(err)}`)
        // No waveform, but the LENGTH still matters: the trim handles and their
        // clamps are built from it, and without one the track cannot be
        // trimmed at all. ffprobe reads containers Web Audio refuses.
        try {
          const abs = await window.noey.projects.resolvePath(uid, music.path)
          const probed = Number((await window.noey.sidecar.probe(abs)).duration)
          if (!cancelled && Number.isFinite(probed) && probed > 0) setMusicDurationSec(probed)
        } catch {
          // Leave it at 0 — the UI then offers no trim rather than a wrong one.
        }
      })
    return () => {
      cancelled = true
    }
  }, [music?.path, uid])

  const commitMusic = async (patch: MusicPatch): Promise<void> => {
    if (!music) return
    const next = { ...music, ...patch }
    if (sameMusic(next, music)) return
    // Before the change, and once per COMMITTED move: the audio track reports
    // a live draft while the block is being dragged and calls this only on
    // pointer-up, so one drag is one undo step.
    pushHistoryNow()
    setMusic(next)
    musicRef.current = next
    setMusicBusy(true)
    try {
      await editorApi.updateMusic(patch)
    } catch (err) {
      setError(formatUserError(err))
      setErrorRetry(null)
    } finally {
      setMusicBusy(false)
    }
  }

  const effectiveMusic: EditorMusic | null = music ? { ...music, ...musicDraft } : null

  // Seeks/starts/stops the hidden <audio> element to match the main preview's
  // timeline-domain position `t`.
  function syncMusicAudio(t: number, allowPlay: boolean): void {
    const a = musicAudioRef.current
    const em = effectiveMusic
    if (!a || !em || !em.path || viewModeRef.current !== 'edited') {
      if (a && !a.paused) a.pause()
      return
    }
    const trimIn = em.trimInSec
    const trimOut = em.trimOutSec ?? musicDurationSec
    const blockDur = Math.max(trimOut - trimIn, 0)
    const start = em.offsetSec
    const end = start + blockDur
    const inWindow = blockDur > 0 && !em.muted && t >= start && t < end
    if (!inWindow || !allowPlay) {
      if (!a.paused) a.pause()
      if (inWindow) {
        const target = trimIn + (t - start)
        if (Number.isFinite(target) && Math.abs(a.currentTime - target) > 0.05)
          a.currentTime = target
      }
      return
    }
    const target = trimIn + (t - start)
    if (Math.abs(a.currentTime - target) > 0.25) a.currentTime = target
    if (a.paused) void a.play().catch(() => undefined)
  }

  useEffect(() => {
    const a = musicAudioRef.current
    if (!a) return
    a.src = music?.path ? window.noey.media.urlFor(uid, music.path) : ''
    // editorPhase dep: the <audio> element only mounts once editorPhase becomes
    // 'ready' — see the pre-R3 editor's identical note.
  }, [music?.path, uid, editorPhase])

  useEffect(() => {
    const a = musicAudioRef.current
    if (!a || !effectiveMusic) return
    a.volume = effectiveMusic.muted ? 0 : effectiveMusic.volume
  }, [effectiveMusic?.volume, effectiveMusic?.muted, editorPhase])

  useEffect(() => {
    syncMusicAudio(currentTimeRef.current, isPlaying)
  }, [
    effectiveMusic?.offsetSec,
    effectiveMusic?.trimInSec,
    effectiveMusic?.trimOutSec,
    effectiveMusic?.muted,
    musicDurationSec,
    viewMode,
    editorPhase
  ])

  useEffect(() => {
    if (!isPlaying) syncMusicAudio(currentTimeRef.current, false)
  }, [isPlaying, editorPhase])

  const handlePickMusic = async (): Promise<void> => {
    const before = musicRef.current
    setMusicBusy(true)
    try {
      const next = await editorApi.pickMusic()
      // Pushed only once the picker actually returned something different —
      // cancelling the file dialog must not leave an empty step in the history.
      if (!sameMusic(next ?? null, before)) pushHistory(snapshotNow({ music: before }))
      setMusic(next ?? null)
      musicRef.current = next ?? null
    } catch (err) {
      setError(formatUserError(err))
      setErrorRetry(null)
    } finally {
      setMusicBusy(false)
    }
  }

  const handleRemoveMusic = async (): Promise<void> => {
    if (!musicRef.current) return
    pushHistoryNow()
    setMusicBusy(true)
    try {
      await editorApi.removeMusic()
      setMusic(null)
      musicRef.current = null
      setMusicPeaks(null)
    } catch (err) {
      setError(formatUserError(err))
      setErrorRetry(null)
    } finally {
      setMusicBusy(false)
    }
  }

  const isDub = mode === 'dub_first' || mode === 'highlight'
  const isHighlight = mode === 'highlight'

  /** Resolve (and cache) the playable src for a source clip — shared by preview and filmstrip generation. */
  async function ensureSourceSrc(sourceId: string): Promise<string> {
    const cached = previewCache.current.get(sourceId)
    if (cached) return cached.src
    const r = await editorApi.resolveSourcePreviewSrc(uid, sourceId)
    previewCache.current.set(sourceId, r)
    return r.src
  }

  async function getFilmstripVideo(sourceId: string): Promise<HTMLVideoElement | null> {
    const cached = filmstripVideoCache.current.get(sourceId)
    if (cached) return cached
    try {
      const src = await ensureSourceSrc(sourceId)
      const video = document.createElement('video')
      video.muted = true
      video.playsInline = true
      video.crossOrigin = 'anonymous'
      video.src = src
      await new Promise<void>((resolve, reject) => {
        video.addEventListener('loadedmetadata', () => resolve(), { once: true })
        video.addEventListener('error', () => reject(new Error('video load failed')), {
          once: true
        })
      })
      filmstripVideoCache.current.set(sourceId, video)
      return video
    } catch {
      return null
    }
  }

  function getFilmstripMeta(
    sourceId: string,
    video: HTMLVideoElement,
    declaredDurationSec: number
  ): { duration: number; tileWidthPx: number; totalTiles: number } {
    const cached = filmstripMetaCache.current.get(sourceId)
    if (cached) return cached
    const duration =
      video.duration > 0 && Number.isFinite(video.duration) ? video.duration : declaredDurationSec
    // Tile math is anchored to BASE_PX_PER_SEC — zooming stretches the display,
    // it never regenerates tiles.
    const laneWidthPx = Math.max(duration * BASE_PX_PER_SEC, MIN_LANE_PX)
    const ratio =
      video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 9 / 16
    const tileWidthPx = Math.max(1, Math.round(IMG_LANE_PX * ratio))
    // Capped: one tile per ~23px of lane means a 5-minute source wants ~530
    // thumbnails, and every one of them is a seek + a canvas draw. The tiles
    // are stretched to fill the lane at whatever zoom is current (see
    // SourceLane), so a lower count only costs resolution — and below this cap
    // nothing changes for the short clips this editor mostly sees.
    const totalTiles = clamp(Math.ceil(laneWidthPx / tileWidthPx), 4, MAX_FILMSTRIP_TILES)
    const meta = { duration, tileWidthPx, totalTiles }
    filmstripMetaCache.current.set(sourceId, meta)
    return meta
  }

  /** Fill only the thumbnail tiles overlapping [startSec, endSec] for one source,
   *  skipping tiles already cached — never a whole clip up front. */
  async function fillFilmstripRange(
    sourceId: string,
    declaredDurationSec: number,
    startSec: number,
    endSec: number
  ) {
    const video = await getFilmstripVideo(sourceId)
    if (!video) return
    const { duration, tileWidthPx, totalTiles } = getFilmstripMeta(
      sourceId,
      video,
      declaredDurationSec
    )
    const tileDur = totalTiles > 0 ? duration / totalTiles : duration
    const startIdx = clamp(Math.floor(startSec / Math.max(tileDur, 0.001)), 0, totalTiles - 1)
    const endIdx = clamp(Math.ceil(endSec / Math.max(tileDur, 0.001)), 0, totalTiles - 1)

    const existing = filmstripsRef.current[sourceId]
    const thumbs: (string | undefined)[] =
      existing?.thumbs && existing.thumbs.length === totalTiles
        ? [...existing.thumbs]
        : new Array(totalTiles).fill(undefined)

    // Publishing only at the END of the loop is why a long source looked like
    // it never loaded at all: ~60 seeks at ~150ms each is ten seconds of blank
    // lane, and any scroll in the meantime queued another pass behind this one
    // (live report 2026-08-13). Tiles now go on screen as they are captured,
    // and a newer request for the same source cancels this one at the next
    // tile instead of waiting it out.
    const publish = (): void => {
      setFilmstrips((prev) => ({ ...prev, [sourceId]: { thumbs: [...thumbs], tileWidthPx } }))
    }
    // Nothing missing in this window — the common case once a lane has been
    // looked at, and the reason repeated requests (every cut block asks for
    // its own window on mount, every scroll asks again) cost nothing.
    let missing = false
    for (let i = startIdx; i <= endIdx && !missing; i++) if (!thumbs[i]) missing = true
    if (!missing) return

    let pending = 0
    try {
      for (let i = startIdx; i <= endIdx; i++) {
        if (thumbs[i]) continue
        const t = totalTiles <= 1 ? 0 : (duration * i) / (totalTiles - 1)
        await new Promise<void>((resolve) => {
          const onSeeked = () => {
            video.removeEventListener('seeked', onSeeked)
            resolve()
          }
          video.addEventListener('seeked', onSeeked)
          video.currentTime = clamp(t, 0, Math.max(duration - 0.05, 0))
        })
        const ratio =
          video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 9 / 16
        const captureH = Math.min(video.videoHeight || 320, IMG_LANE_PX * 2)
        const captureW = Math.max(1, Math.round(captureH * ratio))
        const canvas = document.createElement('canvas')
        canvas.width = captureW
        canvas.height = captureH
        const ctx = canvas.getContext('2d')
        if (!ctx) break
        ctx.drawImage(video, 0, 0, captureW, captureH)
        thumbs[i] = canvas.toDataURL('image/jpeg', 0.82)
        pending += 1
        if (pending >= FILMSTRIP_PUBLISH_EVERY) {
          pending = 0
          publish()
        }
      }
    } catch {
      // Filmstrip is a visual aid only — lane still works without it.
    }
    if (pending > 0) publish()
  }

  /**
   * Serialize fill requests per source — they share one hidden <video>.
   *
   * Requests are never superseded, they queue: in edited mode EVERY cut block
   * asks for its own window on mount, so treating a newer request as "the only
   * one that matters" left most blocks blank and made the lane look like it
   * had loaded the wrong clip (live report 2026-08-13). A window whose tiles
   * are already captured returns immediately, which is what keeps the queue
   * cheap under scroll spam.
   */
  function queueFilmstripRange(
    sourceId: string,
    declaredDurationSec: number,
    startSec: number,
    endSec: number
  ) {
    const prev = filmstripQueueRef.current.get(sourceId) ?? Promise.resolve()
    const next = prev
      .catch(() => undefined)
      .then(() => fillFilmstripRange(sourceId, declaredDurationSec, startSec, endSec))
    filmstripQueueRef.current.set(sourceId, next)
  }

  async function loadPreviewFor(sourceId: string) {
    try {
      const src = await ensureSourceSrc(sourceId)
      setPreviewSrc(src)
      setPreviewSource(sourceId)
    } catch (e) {
      setError(formatUserError(e))
      setErrorRetry(null)
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
      // The previewSrc effect applies the seek once the new source has actually
      // swapped in — seeking here raced with that effect (see pre-R3 notes).
      isSourceSwapPendingRef.current = true
      await loadPreviewFor(cut.source)
      return
    }
    const v = activeVideo()
    if (v) {
      v.currentTime = cut.in
      const activeT =
        viewMode === 'edited'
          ? (computeEditedSegments(cuts).find((s) => s.cut.id === cut.id)?.editedIn ?? 0)
          : cut.in
      currentTimeRef.current = activeT
      setCurrentTime(activeT)
      paintTime(activeT)
      resumeFollow()
      followPlayhead(activeT)
      if (resumePlaybackRef.current) void v.play()
    }
  }

  // Once the preview video src swaps in, seek + play the pending range.
  useEffect(() => {
    const v = activeVideo()
    if (!v || !playRangeRef.current || !previewSrc) return
    if (v.src !== previewSrc) v.src = previewSrc
    const onLoaded = () => {
      const range = playRangeRef.current
      if (!range) return
      v.currentTime = range.in
      setVideoDuration(v.duration || 0)
      const cutId = editedActiveCutIdRef.current
      const activeT =
        viewModeRef.current === 'edited' && cutId
          ? (computeEditedSegments(cutsRef.current).find((s) => s.cut.id === cutId)?.editedIn ?? 0)
          : range.in
      currentTimeRef.current = activeT
      setCurrentTime(activeT)
      paintTime(activeT)
      resumeFollow()
      followPlayhead(activeT)
      isSourceSwapPendingRef.current = false
      if (resumePlaybackRef.current) void v.play()
    }
    if (v.readyState >= 1 && v.src === previewSrc) onLoaded()
    else v.addEventListener('loadedmetadata', onLoaded, { once: true })
    return () => v.removeEventListener('loadedmetadata', onLoaded)
  }, [previewSrc, editorPhase])

  /** Source-absolute time of whatever the active <video> is showing — the clock
   * caption lines are timed against. The <video> is always seeked to a
   * source-local position, so this is just its currentTime. */
  function activeSourceTime(): number | null {
    const v = activeVideo()
    if (!v) return null
    return v.currentTime
  }

  /** Paint the caption line under the playhead onto the preview overlay. */
  function syncCaptionOverlay(): void {
    const el = captionOverlayRef.current
    if (!el) return
    const lines = captionLinesRef.current
    const t =
      lines && lines.length > 0
        ? captionsOnOutputClock
          ? currentTimeRef.current
          : activeSourceTime()
        : null
    const line = t === null ? undefined : lines!.find((l) => t >= l.start && t < l.end)
    const text = line?.text ?? ''
    if (el.textContent !== text) el.textContent = text
  }

  function syncTimeFromVideo() {
    syncCaptionOverlay()
    if (isScrubbingRef.current || isSourceSwapPendingRef.current) return
    const v = activeVideo()
    if (!v) return
    let t: number
    if (viewMode === 'edited') {
      const cut = currentEditedCut()
      const seg = cut ? computeEditedSegments(cuts).find((s) => s.cut.id === cut.id) : null
      if (!seg) return
      t = clamp(seg.editedIn + (v.currentTime - cut!.in), 0, computeEditedDuration(cuts))
    } else {
      t = clamp(v.currentTime, 0, getActiveDurationSec())
    }
    currentTimeRef.current = t
    setCurrentTime(t)
    paintTime(t)
    syncFocusToPlayhead(t)
  }
  function isActiveVideoEvent(e: React.SyntheticEvent<HTMLVideoElement>): boolean {
    return e.currentTarget === activeVideo()
  }

  function onVideoLoadedMetadata() {
    const v = activeVideo()
    if (!v) return
    setVideoDuration(v.duration || 0)
    if (!isScrubbingRef.current && !isSourceSwapPendingRef.current) syncTimeFromVideo()
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
    paintTime(dur)
  }

  function captureViewModeState(m: 'source' | 'edited') {
    const v = activeVideo()
    const state: ViewModePlaybackState = {
      currentTime: currentTimeRef.current,
      selectedId,
      previewSource,
      editedActiveCutId: editedActiveCutIdRef.current,
      playRange: playRangeRef.current ? { ...playRangeRef.current } : null,
      wasPlaying: v ? !v.paused : isPlaying
    }
    if (m === 'source') sourceViewStateRef.current = state
    else editedViewStateRef.current = state
  }

  async function restoreViewModeState(m: 'source' | 'edited') {
    const saved = m === 'source' ? sourceViewStateRef.current : editedViewStateRef.current
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
    } else if (m === 'edited') {
      const first = cuts[0]
      if (!first) return
      nextTime = 0
      nextSelectedId = first.id
      nextEditedCutId = first.id
      nextPlayRange = { in: first.in, out: first.out }
      nextPreviewSource = first.source
      nextWasPlaying = false
    } else {
      // First visit to source view: keep the active file, land on the selected
      // cut's own source position so the two views feel continuous.
      const sel = cuts.find((c) => c.id === selectedId)
      nextTime = sel ? sel.in : 0
      nextSelectedId = selectedId
      nextEditedCutId = editedActiveCutIdRef.current
      nextPlayRange = sel ? { in: sel.in, out: sel.out } : null
      nextPreviewSource = sel?.source ?? previewSource
      nextWasPlaying = false
    }

    setSelectedId(nextSelectedId)
    editedActiveCutIdRef.current = nextEditedCutId
    playRangeRef.current = nextPlayRange
    currentTimeRef.current = nextTime
    setCurrentTime(nextTime)
    resumePlaybackRef.current = nextWasPlaying

    if (nextPreviewSource && nextPreviewSource !== previewSource) {
      isSourceSwapPendingRef.current = true
      await loadPreviewFor(nextPreviewSource)
    }

    const v = activeVideo()
    if (!v) return

    if (m === 'edited') {
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

    paintTime(nextTime)
    resumeFollow()
    followPlayhead(nextTime)

    if (nextWasPlaying) void v.play()
    else {
      v.pause()
      setIsPlaying(false)
    }

    if (m === 'edited') primeNextSegment()
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
    if (!v.paused) {
      v.pause()
      return
    }
    // Rewind when the PLAYHEAD is at the end of the domain being played, not
    // when the <video> element is at the end of its own file. In edited mode
    // the last cut's out-point is nowhere near the source file's duration, so
    // the old `v.currentTime >= v.duration` test never fired: pressing play at
    // the end resumed at a position the sequence had already finished on, and
    // maybeAdvanceEditedSegment paused it again on the next frame — the clip
    // looked stuck (live report 2026-08-13).
    const dur = getActiveDurationSec()
    if (dur > 0 && currentTimeRef.current >= dur - 0.05) {
      applyScrubTime(0, true)
      if (isSourceSwapPendingRef.current) {
        // The first cut lives in another source file; the previewSrc effect
        // starts playback once that file has swapped in.
        resumePlaybackRef.current = true
        return
      }
      const rewound = activeVideo()
      if (rewound) void rewound.play()
      return
    }
    void v.play()
  }

  function nudgePlayhead(deltaSec: number) {
    applyScrubTime(currentTimeRef.current + deltaSec, true)
  }

  function deleteSelectedCut() {
    if (selectedId) deleteCut(selectedId)
  }

  // ---- edits ---------------------------------------------------------------

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
    opts?: { insertAtPlayhead?: boolean }
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
        label: isDub ? `บรรทัด ${newLineId}` : 'ฉากใหม่',
        voiceoverLineId: newLineId,
        voiceoverScript: isDub ? '' : undefined
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
        voiceoverScript: ''
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
    // In edited mode the playhead is an output position — the new scene starts
    // at the SOURCE position under the playhead, same as the source view.
    let atSrc = currentTimeRef.current
    if (viewMode === 'edited') {
      const seg = findEditedSegment(cuts, currentTimeRef.current)
      atSrc = seg ? seg.cut.in + (currentTimeRef.current - seg.editedIn) : 0
    }
    addCut(sourceId, clamp(atSrc, 0, Math.max(dur - MIN_CUT_SEC, 0)), dur, {
      insertAtPlayhead: true
    })
  }

  /** แยกที่หัวเล่น (S) — split the scene under the playhead into two. */
  function splitAtPlayhead() {
    const t = currentTimeRef.current
    let cutId: string | null = null
    let atSrc = 0
    if (viewMode === 'edited') {
      const seg = findEditedSegment(cuts, t)
      if (!seg) return
      cutId = seg.cut.id
      atSrc = seg.cut.in + (t - seg.editedIn)
    } else {
      const c = findSourceCutAtTime(cuts, previewSource, t)
      if (!c) return
      cutId = c.id
      atSrc = t
    }
    newCutCounter.current += 1
    const next = splitCutAt(cuts, cutId, atSrc, `new${newCutCounter.current}`)
    if (!next) return
    setCuts((prev) => {
      pushUndoSnapshot(prev)
      return next
    })
  }

  /** ทำซ้ำ — duplicate the selected scene right after itself. */
  function duplicateSelectedCut() {
    if (!selectedCut) return
    newCutCounter.current += 1
    const cutId = `new${newCutCounter.current}`
    setCuts((prev) => {
      pushUndoSnapshot(prev)
      const idx = prev.findIndex((c) => c.id === selectedCut.id)
      if (idx < 0) return prev
      const src = prev[idx]
      const newLineId = isDub ? nextVoiceoverLineId(prev) : undefined
      const copy: WorkingCut = {
        ...src,
        id: cutId,
        label: isDub ? `บรรทัด ${newLineId}` : src.label,
        voiceoverLineId: newLineId ?? src.voiceoverLineId,
        voiceoverScript: isDub ? (src.voiceoverScript ?? '') : src.voiceoverScript
      }
      return [...prev.slice(0, idx + 1), copy, ...prev.slice(idx + 1)]
    })
  }

  /** ตั้งจุดเข้า/จุดออก ([ / ]) — trim the selected cut to the playhead. */
  function setPointAtPlayhead(edge: TrimEdge) {
    if (!selectedCut) return
    const t = currentTimeRef.current
    let atSrc: number
    if (viewMode === 'edited') {
      const seg = computeEditedSegments(cuts).find((s) => s.cut.id === selectedCut.id)
      if (!seg || t < seg.editedIn - 0.001 || t > seg.editedOut + 0.001) return
      atSrc = selectedCut.in + (t - seg.editedIn)
    } else {
      atSrc = t
    }
    if (edge === 'left') {
      if (atSrc > selectedCut.out - MIN_CUT_SEC) return
      setCuts((prev) => {
        pushUndoSnapshot(prev)
        return prev.map((c) => (c.id === selectedCut.id ? { ...c, in: Math.max(atSrc, 0) } : c))
      })
    } else {
      if (atSrc < selectedCut.in + MIN_CUT_SEC) return
      const maxOut = getSourceDurationSec(selectedCut.source)
      setCuts((prev) => {
        pushUndoSnapshot(prev)
        return prev.map((c) =>
          c.id === selectedCut.id ? { ...c, out: Math.min(atSrc, maxOut) } : c
        )
      })
    }
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
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  function updateCaptionLine(id: string, patch: Partial<CaptionLine>): void {
    setCaptionLines((prev) =>
      prev ? prev.map((l) => (l.id === id ? { ...l, ...patch } : l)) : prev
    )
  }

  function deleteCaptionLine(id: string): void {
    pushHistoryNow()
    setCaptionLines((prev) => (prev ? prev.filter((l) => l.id !== id) : prev))
  }

  /** The cut list in the shape both the draft save and the render save send. */
  function cutPayload(list: WorkingCut[]): EditCut[] {
    return list.map(
      (c) =>
        ({
          source: c.source,
          in: c.in,
          out: c.out,
          label: c.label,
          voiceoverLineId: isDub ? (c.voiceoverLineId ?? (cutLineId(c) || null)) : undefined,
          voiceoverScript: isDub ? (c.voiceoverScript ?? '') : undefined
        }) as EditCut
    )
  }

  /** Edits made since the last draft write. Refs, not state: the flush on the
   * way out runs from an event handler and must see the newest values. */
  const draftDirtyRef = useRef(false)
  const draftSavingRef = useRef<Promise<void> | null>(null)

  /**
   * Write the draft NOW (used by the debounce and by the way out).
   *
   * Leaving the editor within the debounce window used to drop the last edit
   * on the floor: the timer was cleared by the unmount and nothing else wrote
   * it. Everything else about closing is a warning; this is the part that
   * actually preserves the work.
   */
  async function saveDraftNow(): Promise<void> {
    // A save already in flight cannot contain edits made after it started, so
    // returning it as "done" let the way-out flush report success while the
    // newest edits were still only in memory — then the editor unmounted.
    // Chain behind it and write again instead.
    if (draftSavingRef.current) {
      await draftSavingRef.current.catch(() => undefined)
      return saveDraftNow()
    }
    if (!draftDirtyRef.current) return
    if (editorPhase !== 'ready' || cutsRef.current.length === 0) return
    draftDirtyRef.current = false
    const run = editorApi
      .saveDraft(cutPayload(cutsRef.current), captionLinesRef.current ?? undefined)
      .then(() =>
        setDraftSavedAt(
          new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
        )
      )
      .catch(() => {
        // Keep it pending so the next tick (or the way out) tries again.
        draftDirtyRef.current = true
      })
      .finally(() => {
        draftSavingRef.current = null
      })
    draftSavingRef.current = run
    return run
  }

  // Draft autosave (R3 header). Debounced, and never while a render save is
  // in flight — the two write the same document.
  const draftFirstRef = useRef(true)
  useEffect(() => {
    if (draftFirstRef.current) {
      draftFirstRef.current = false
      return
    }
    if (saving || editorPhase !== 'ready' || cuts.length === 0 || editCount === 0) return
    draftDirtyRef.current = true
    const t = setTimeout(() => void saveDraftNow(), 2000)
    return () => clearTimeout(t)
  }, [cuts, captionLines, saving, editorPhase, isDub, editCount])

  /**
   * What is at stake if the user walks out now, or null when nothing is.
   *
   * Not "unsaved" in the usual sense — the draft is written continuously, so
   * nothing is LOST. What is pending is the render: the finished clip on disk
   * is still the one from before these edits, and that is the surprise worth a
   * dialog (live report 2026-08-13).
   */
  const unrenderedReason =
    editorPhase === 'ready' && editCount > 0 && !saving
      ? `แก้ไว้ ${editCount} อย่างแล้วแต่ยังไม่ได้กด "บันทึกและเรนเดอร์" — ระบบเก็บร่างไว้ให้ กลับมาแก้ต่อได้ แต่คลิปที่ได้จะยังเป็นของเดิมจนกว่าจะเรนเดอร์ใหม่`
      : null
  const { confirmLeave } = useUnsavedGuard(unrenderedReason, saveDraftNow)

  /** The one way out of the editor — flushes the draft, then asks. */
  async function requestClose(): Promise<void> {
    await saveDraftNow()
    if (await confirmLeave()) onClose()
  }

  async function handleSave() {
    if (cuts.length === 0) {
      setError('ต้องมีอย่างน้อย 1 ฉาก')
      setErrorRetry(null)
      return
    }
    setSaving(true)
    setError(null)
    setErrorRetry(null)
    try {
      const payload: EditCut[] = cuts.map(
        (c) =>
          ({
            source: c.source,
            in: c.in,
            out: c.out,
            label: c.label,
            voiceoverLineId: isDub ? (c.voiceoverLineId ?? (cutLineId(c) || null)) : undefined,
            voiceoverScript: isDub ? (c.voiceoverScript ?? '') : undefined
          }) as EditCut
      )
      await editorApi.saveEditTimeline(uid, payload, captionLines ?? undefined)
      onSaved()
      onClose()
    } catch (e) {
      setError(formatUserError(e))
      setErrorRetry('save')
    } finally {
      setSaving(false)
    }
  }

  const aiLines: AiReeditLine[] = (() => {
    const seen = new Map<number, AiReeditLine>()
    for (const c of cuts) {
      const lid = cutLineId(c)
      const existing = seen.get(lid)
      if (existing) existing.cutCount += 1
      else seen.set(lid, { id: lid, script: lineScriptFor(cuts, lid), cutCount: 1 })
    }
    return Array.from(seen.values()).sort((a, b) => a.id - b.id)
  })()

  function toggleAiLine(lineId: number) {
    setAiChecked((prev) => {
      const next = new Set(prev)
      if (next.has(lineId)) next.delete(lineId)
      else next.add(lineId)
      return next
    })
  }

  /**
   * Hand the re-edit to the app-level job store rather than awaiting it here:
   * closing the editor while the AI is thinking used to throw the answer away
   * (and hide the fact that anything was running). `fxResult` below applies it
   * whenever the editor is on screen again.
   */
  function handleAiReedit(): void {
    if (!aiInstruction.trim()) return
    setLocalAiError(null)
    fxJobs.clearError(uid)
    const payload: EditCut[] = cuts.map(
      (c) =>
        ({
          source: c.source,
          in: c.in,
          out: c.out,
          label: c.label,
          voiceoverLineId: c.voiceoverLineId ?? (cutLineId(c) || null),
          voiceoverScript: c.voiceoverScript ?? ''
        }) as EditCut
    )
    const selectedLineIds = Array.from(aiChecked)
    const instruction = aiInstruction.trim()
    void fxJobs.run(uid, 'reedit', 'AI กำลังแก้การตัด', () =>
      editorApi.requestAiReedit(uid, payload, selectedLineIds, instruction)
    )
    setAiChecked(new Set())
    setAiInstruction('')
    setAiPanelOpen(false)
  }

  const fxJob = fxJobs.jobFor(uid)
  const fxResult = fxJobs.resultFor(uid)
  const aiBusy = fxJob?.kind === 'reedit'
  const aiError = localAiError ?? fxJobs.errorFor(uid) ?? null
  useEffect(() => {
    if (!fxResult || fxResult.kind !== 'reedit') return
    // Deferred: applying the answer is a fresh update, not part of this commit.
    const t = window.setTimeout(() => {
      pushUndoSnapshot(cutsRef.current)
      setCuts(fxResult.value as EditCut[])
      setSelectedId(null)
      fxJobs.clearResult(uid)
    }, 0)
    return () => window.clearTimeout(t)
  }, [fxResult, fxJobs, uid])

  const canAiReedit = isDub && timeline?.editTarget === 'edit_script'
  const selectedCut = cuts.find((c) => c.id === selectedId) ?? null

  // ---- keyboard ------------------------------------------------------------

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
          void requestClose()
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

      if (
        matchesShortcutParts(e, [{ type: 'mod' }, { type: 'key', code: 'KeyZ' }]) &&
        !e.shiftKey
      ) {
        e.preventDefault()
        undo()
        return
      }

      if (
        matchesShortcutParts(e, [{ type: 'mod' }, { type: 'key', code: 'KeyY' }]) ||
        matchesShortcutParts(e, [{ type: 'mod' }, { type: 'shift' }, { type: 'key', code: 'KeyZ' }])
      ) {
        e.preventDefault()
        redo()
        return
      }

      if (
        matchesShortcutParts(e, [{ type: 'key', code: 'Delete' }]) ||
        matchesShortcutParts(e, [{ type: 'key', code: 'Backspace' }])
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

      if (matchesShortcutParts(e, [{ type: 'key', code: 'KeyS' }])) {
        e.preventDefault()
        splitAtPlayhead()
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
        setPointAtPlayhead('left')
        return
      }

      if (matchesShortcutParts(e, [{ type: 'key', code: 'BracketRight' }])) {
        e.preventDefault()
        setPointAtPlayhead('right')
        return
      }

      if (
        matchesShortcutParts(e, [{ type: 'mod' }, { type: 'key', code: 'Digit1' }]) ||
        matchesShortcutParts(e, [{ type: 'mod' }, { type: 'key', code: 'Numpad1' }])
      ) {
        e.preventDefault()
        switchViewMode('source')
        return
      }

      if (
        matchesShortcutParts(e, [{ type: 'mod' }, { type: 'key', code: 'Digit2' }]) ||
        matchesShortcutParts(e, [{ type: 'mod' }, { type: 'key', code: 'Numpad2' }])
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
        nudgePlayhead(-FRAME_SEC)
        return
      }

      if (matchesShortcutParts(e, [{ type: 'key', code: 'ArrowRight' }])) {
        e.preventDefault()
        nudgePlayhead(FRAME_SEC)
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
  }, [editorPhase, previewSrc, shortcutsOpen, selectedId, cuts, saving, isDub, viewMode, onClose])

  // ---- derived render values ----------------------------------------------

  const editedDur = computeEditedDuration(cuts)
  const axisDur = viewMode === 'edited' ? editedDur : getSourceAxisDurationSec()
  const contentW = getContentWidthPx()
  const voBlocks = isDub && viewMode === 'edited' ? voiceoverLineBlocks(cuts) : []
  // The line the playhead is inside right now. Selection says what you are
  // EDITING; this says what the clip is SAYING — while it plays you want to
  // read along without every scene change stealing your selection.
  const playingLineId =
    voBlocks.find((b) => currentTime >= b.outStart && currentTime < b.outStart + b.durationSec)
      ?.lineId ?? null
  const capSpans =
    captionLines && viewMode === 'edited'
      ? captionsOnOutputClock
        ? captionChipSpansFromOutput(cuts, captionLines)
        : captionChipSpans(cuts, captionLines)
      : []
  /** Scene boundaries on the output clock — what music snaps to. */
  const outputCutBoundaries = cutBoundariesSec(cuts)
  boundariesRef.current = captionsOnOutputClock
    ? outputCutBoundaries
    : cuts.flatMap((c) => [c.in, c.out])
  const thStats = !isDub && timeline ? removedSpanStats(cuts, timeline.sources) : null
  const captionCursorIdx = captionLines
    ? clamp(captionCursor, 0, Math.max(captionLines.length - 1, 0))
    : 0
  const cursorLine = captionLines?.[captionCursorIdx]
  const showTabs = isDub
  const activeInspectorTab = showTabs ? inspectorTab : 'caption'
  const lineCuts = selectedCut && isDub ? cutsInLine(cuts, cutLineId(selectedCut)) : []

  // One frame per angle of the selected line. The angle buttons were black
  // rectangles — "2 มุม" with nothing to tell them apart (live report
  // 2026-08-13). Captured from the same cached <video> elements the filmstrip
  // uses, keyed by source+in so re-selecting a line is free and dragging a cut
  // re-captures only that angle.
  const [angleThumbs, setAngleThumbs] = useState<Record<string, string>>({})
  const angleThumbKey = (cut: WorkingCut): string => `${cut.source}@${cut.in.toFixed(2)}`
  const angleKeys = lineCuts.map(angleThumbKey).join('|')
  useEffect(() => {
    if (lineCuts.length === 0) return
    let cancelled = false
    void (async () => {
      for (const cut of lineCuts) {
        const key = angleThumbKey(cut)
        if (cancelled || angleThumbs[key]) continue
        const video = await getFilmstripVideo(cut.source)
        if (!video || cancelled) return
        // A hair into the cut: the first frame of a trim is often a fade or a
        // transition frame, which reads as the black box this replaces.
        const at = Math.max(0, Math.min(cut.in + 0.08, (video.duration || cut.out) - 0.05))
        await new Promise<void>((resolve) => {
          const onSeeked = () => {
            video.removeEventListener('seeked', onSeeked)
            resolve()
          }
          video.addEventListener('seeked', onSeeked)
          video.currentTime = at
        })
        if (cancelled) return
        const ratio =
          video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 9 / 16
        const canvas = document.createElement('canvas')
        canvas.height = 88
        canvas.width = Math.max(1, Math.round(88 * ratio))
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        const url = canvas.toDataURL('image/jpeg', 0.8)
        if (!cancelled) setAngleThumbs((prev) => (prev[key] ? prev : { ...prev, [key]: url }))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [angleKeys])

  // "ท่อนที่ตรงกับฉากนี้" has to mean it: selecting a scene moves the caption
  // cursor onto the first line inside that scene, if there is one. Typing in
  // the box must not yank the cursor, so this only reacts to the selection.
  useEffect(() => {
    if (!captionLines || captionLines.length === 0 || !selectedCut) return
    const seg = computeEditedSegments(cuts).find((x) => x.cut.id === selectedCut.id)
    const [winIn, winOut] = captionsOnOutputClock
      ? [seg?.editedIn ?? 0, seg?.editedOut ?? 0]
      : [selectedCut.in, selectedCut.out]
    const idx = captionLines.findIndex((l) => l.end > winIn + 0.01 && l.start < winOut - 0.01)
    if (idx >= 0) setCaptionCursor(idx)
  }, [selectedId])

  function jumpToCaption(idx: number) {
    if (!captionLines || captionLines.length === 0) return
    const next = clamp(idx, 0, captionLines.length - 1)
    setCaptionCursor(next)
    const line = captionLines[next]
    if (captionsOnOutputClock) {
      // Already an output time — only the source view needs a conversion, and
      // there is none to make (a line can span scenes there), so stay put.
      if (viewMode === 'edited') applyScrubTime(line.start + 0.01, true)
    } else if (viewMode === 'edited') {
      const mapped = mapSourceTimeToOutput(cuts, line.start + 0.01)
      if (mapped !== null) applyScrubTime(mapped, true)
    } else {
      applyScrubTime(line.start, true)
    }
  }

  /**
   * "ส่งออก .srt" (R7): the lines as they are RIGHT NOW, not the ones the last
   * render burned in. Written into the project dir first so the existing
   * export-file dialog can copy it out — no new main-process surface needed.
   */
  async function exportSrt(): Promise<void> {
    if (!captionLines || captionLines.length === 0) return
    setSrtBusy(true)
    setSrtNote(null)
    try {
      const text = captionLinesToSrt(captionLines)
      const rel = 'captions/subtitles_edit.srt'
      await window.noey.projects.writeFile(uid, rel, new TextEncoder().encode(text))
      const dest = await window.noey.projects.exportFile(uid, rel, 'subtitles.srt')
      setSrtNote(dest ? `บันทึกไว้ที่ ${dest}` : null)
    } catch (e) {
      setSrtNote(formatUserError(e))
    } finally {
      setSrtBusy(false)
    }
  }

  /** Retime a caption by dragging one of its edges on the คำบรรยาย track. */
  function dragCaption(chip: CaptionChipSpan, edge: TrimEdge, e: React.PointerEvent): void {
    e.stopPropagation()
    e.preventDefault()
    const line = captionLines?.find((l) => l.id === chip.id)
    if (!line) return
    const startX = e.clientX
    const from = { start: line.start, end: line.end }
    beginEdit()
    const onMove = (ev: PointerEvent): void => {
      const deltaSec = (ev.clientX - startX) / pxPerSecRef.current
      const patch = dragCaptionEdge(from, chip, edge, deltaSec)
      // A caption that spills a few frames past a cut reads as a mistake in the
      // finished clip, and hitting the boundary by hand is fiddly — pull the
      // dragged edge onto the nearest scene boundary within ~10px.
      // Snap the edge BEING DRAGGED — dragCaptionEdge always returns both
      // fields, so which one moved has to come from `edge`, not from an
      // undefined check.
      const tol = 10 / Math.max(pxPerSecRef.current, 1)
      const snapped =
        edge === 'right'
          ? { ...patch, end: snapToMarkers(patch.end, boundariesRef.current, tol) }
          : { ...patch, start: snapToMarkers(patch.start, boundariesRef.current, tol) }
      updateCaptionLine(chip.id, snapped)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      commitEdit()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  function copyErrorReport() {
    const report = `โปรเจกต์ ${uid} · ${new Date().toISOString()}\n${error ?? ''}`
    void navigator.clipboard?.writeText(report).catch(() => undefined)
  }

  /** Source-lane background click: activate that file (if needed) and seek. */
  function onSourceLanePointerDown(sourceId: string, e: React.PointerEvent) {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest('[data-cut-block]') || target.closest('[data-trim-handle]')) return
    if (sourceId === previewSource) {
      onRulerPointerDown(e)
      return
    }
    const sec = timeAtClientX(e.clientX)
    const dur = getSourceDurationSec(sourceId)
    resumePlaybackRef.current = false
    isSourceSwapPendingRef.current = true
    playRangeRef.current = { in: clamp(sec, 0, dur), out: dur }
    currentTimeRef.current = clamp(sec, 0, dur)
    setCurrentTime(currentTimeRef.current)
    void loadPreviewFor(sourceId)
  }

  const transportVisible = transportOn || !isPlaying

  // Track NAMES are ink-3; only the count beside ภาพ is muted (design R3).
  // pl-3: the labels sat flush against the window edge — a sticky column with
  // no left padding reads as clipped text (live report 2026-08-13).
  // z-40, above every lane element (blocks are z-0/z-20, trim handles z-30):
  // the label column is what lane content scrolls UNDER, and at the same
  // z-index DOM order won instead — a cut block dragged to the left edge was
  // painted on top of its own track name (live report 2026-08-13).
  const trackLabelCls =
    'sticky left-0 z-40 flex h-full shrink-0 items-center gap-1.5 bg-ground pr-3 pl-3 text-[13px] text-ink-3'

  return (
    <div className="fixed inset-0 z-100 flex flex-col bg-ground text-ink">
      <OverlayTitleBarSpacer
        label={`แก้ไขวิดีโอ${projectName ? ` — ${projectName}` : ''} · ${
          isDub ? 'ตัดฉากเด่น' : 'ตัดช่วงเงียบ'
        }`}
        rightNote={draftSavedAt ? `บันทึกร่างอัตโนมัติ · ${draftSavedAt}` : undefined}
      />
      {/* header (R3): leave, history, what state the cut is in, then act */}
      <div className="flex items-center gap-3 border-b border-divider px-6 py-3">
        <Button variant="ghost" icon={<ArrowLeft size={16} />} onClick={() => void requestClose()}>
          กลับไปหน้าโปรเจกต์
        </Button>
        <span className="h-5 w-px bg-divider" />
        {undoStack.current.length > 0 ? (
          <Button icon={<Undo2 size={15} />} onClick={undo} title={withShortcut('เลิกทำ', 'undo')}>
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
        {redoStack.current.length > 0 ? (
          <Button icon={<Redo2 size={15} />} onClick={redo} title={withShortcut('ทำซ้ำ', 'undo')}>
            ทำซ้ำ
          </Button>
        ) : (
          <Button
            icon={<Redo2 size={15} />}
            disabled
            reasonAs="tooltip"
            disabledReason="ย้อนก่อนถึงจะทำซ้ำได้"
          >
            ทำซ้ำ
          </Button>
        )}

        <p className="min-w-0 flex-1 truncate text-sm text-muted">
          {editCount > 0 ? `แก้แล้ว ${editCount} อย่าง · ยังไม่ได้เรนเดอร์` : 'ยังไม่ได้แก้อะไร'}
          {draftSavedAt ? ` · บันทึกร่างอัตโนมัติ ${draftSavedAt}` : ''}
        </p>

        <Button
          variant="ghost"
          icon={<HelpCircle size={16} />}
          onClick={() => setShortcutsOpen(true)}
          title={withShortcut('แป้นพิมพ์ลัด', 'shortcuts-help')}
        >
          แป้นพิมพ์ลัด
        </Button>
        {canAiReedit &&
          (editorPhase === 'ready' && cuts.length > 0 ? (
            <Button icon={<Sparkles size={16} />} onClick={() => setAiPanelOpen(true)}>
              ให้ AI แก้ให้
            </Button>
          ) : (
            <Button icon={<Sparkles size={16} />} disabled disabledReason="ต้องมีอย่างน้อย 1 ฉาก">
              ให้ AI แก้ให้
            </Button>
          ))}
        {editorPhase === 'ready' && cuts.length > 0 ? (
          <Button
            variant="primary"
            icon={<Save size={16} />}
            loading={saving}
            onClick={handleSave}
            title={withShortcut('บันทึกและเรนเดอร์', 'save')}
          >
            {saving ? 'กำลังบันทึก…' : 'บันทึกและเรนเดอร์'}
          </Button>
        ) : (
          <Button
            variant="primary"
            icon={<Save size={16} />}
            disabled
            disabledReason={cuts.length === 0 ? 'ต้องมีอย่างน้อย 1 ฉาก' : 'กำลังเตรียมวิดีโอ'}
          >
            บันทึกและเรนเดอร์
          </Button>
        )}
      </div>

      {shortcutsOpen && <ShortcutsSheet isDub={isDub} onClose={() => setShortcutsOpen(false)} />}

      {/* Caption appearance — the same panel the wizard shows, reachable after
          the cut. The style is stored on the project and burned in on the next
          render, so nothing here re-renders anything on its own. */}
      {captionStyleOpen && captionStyle && (
        <Dialog
          open
          onClose={() => setCaptionStyleOpen(false)}
          title="หน้าตาคำบรรยาย"
          subtitle="มีผลกับการเรนเดอร์ครั้งถัดไป"
          width={620}
        >
          <CaptionPanel
            style={captionStyle}
            onChange={(next) => {
              if (sameCaptionStyle(next, captionStyleRef.current)) return
              pushHistoryNow()
              setCaptionStyle(next)
              captionStyleRef.current = next
              void editorApi.updateCaptionStyle(next)
            }}
            previewThumb={null}
          />
        </Dialog>
      )}

      {aiPanelOpen && (
        <AiReeditDialog
          lines={aiLines}
          checked={aiChecked}
          onToggle={toggleAiLine}
          instruction={aiInstruction}
          onInstructionChange={setAiInstruction}
          busy={aiBusy}
          errorMsg={aiError}
          onSubmit={handleAiReedit}
          onClose={() => {
            if (!aiBusy) setAiPanelOpen(false)
          }}
        />
      )}

      {/* R3 sub-frame ง — the error bar names the failure, keeps the reassurance,
          and offers retry + copy (text stays selectable for แจ้งปัญหา). */}
      {error && (
        <div className="mx-6 mt-3 rounded-lg border border-error/40 bg-error/10 px-4 py-3 select-text">
          <p className="flex items-start gap-2 text-sm text-error">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span className="min-w-0">{error}</span>
          </p>
          <p className="mt-1 pl-6 text-[13px] text-muted">งานที่แก้ไว้ยังอยู่ในเครื่อง ไม่ได้หาย</p>
          <div className="mt-2 flex items-center gap-2 pl-6">
            {errorRetry === 'save' && (
              <Button onClick={handleSave} loading={saving}>
                ลองอีกครั้ง
              </Button>
            )}
            <Button variant="ghost" onClick={copyErrorReport}>
              คัดลอกข้อมูลแจ้งปัญหา
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setError(null)
                setErrorRetry(null)
              }}
            >
              ปิด
            </Button>
          </div>
        </div>
      )}

      {editorPhase !== 'ready' ? (
        /* R3 sub-frame ค — preparing. One-time per project, so say that. */
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <div className="h-1 w-56 overflow-hidden rounded-full bg-border-faint">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" />
          </div>
          <p className="text-sm font-medium text-ink">กำลังเตรียมวิดีโอให้พร้อมแก้ไข</p>
          <p className="max-w-xs text-[13px] text-muted">
            ทำครั้งเดียวต่อโปรเจกต์ · ครั้งต่อไปจะเปิดได้ทันที
          </p>
          {prepareHint && (
            <p className="flex items-center gap-1.5 text-[13px] text-muted">
              <Loader2 size={13} className="animate-spin" /> {prepareHint}
            </p>
          )}
        </div>
      ) : !timeline ? null : (
        <>
          {/* middle: stage (centre) + inspector (right) */}
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-2 px-5 py-3">
              <div
                className="group/stage relative flex h-full min-h-0 max-w-full flex-1 items-center justify-center"
                style={{ width: 'auto', aspectRatio: '9 / 16' }}
                onPointerMove={showTransport}
                onPointerLeave={() => setTransportOn(false)}
              >
                {/* Two elements so the "next" edited-mode segment can be pre-seeked hidden, then swapped in instantly. */}
                {/* Clicking the picture toggles playback, the way every video
                    player does — the transport button was the only way before
                    (live report 2026-08-13). It sits on both elements because
                    which one is on top changes with every scene swap. */}
                <video
                  onClick={togglePlay}
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
                  onClick={togglePlay}
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
                    it — the video is the hero and the controls belong on it. */}
                <VideoTransport
                  className="rounded-b-xl"
                  visible={transportVisible}
                  playing={isPlaying}
                  currentSec={currentTime}
                  durationSec={getActiveDurationSec()}
                  seekRef={seekbarRef}
                  timeLabelRef={timeLabelRef}
                  onTogglePlay={togglePlay}
                  onSeek={(sec) => applyScrubTime(sec, true)}
                  onScrubStart={() => {
                    isScrubbingSeekbarRef.current = true
                    pauseForScrub()
                  }}
                  onScrubEnd={() => {
                    isScrubbingSeekbarRef.current = false
                    resumeAfterScrub()
                  }}
                  onStepBack={() => nudgePlayhead(-FRAME_SEC)}
                  onStepForward={() => nudgePlayhead(FRAME_SEC)}
                  stepBackTitle={withShortcut('ถอย 1 เฟรม', 'frame-back')}
                  stepForwardTitle={withShortcut('เดินหน้า 1 เฟรม', 'frame-back')}
                  playTitle={withShortcut(isPlaying ? 'หยุด' : 'เล่น', 'play')}
                  playDisabledReason={previewSrc ? undefined : 'ยังไม่มีวิดีโอให้เล่น'}
                />
              </div>
            </div>

            {/* inspector — R3 right rail */}
            <aside className="flex w-[360px] shrink-0 flex-col overflow-hidden border-l border-divider">
              <div className="shrink-0 border-b border-divider px-4 py-3">
                <p className="text-[13px] text-muted">ฉากที่เลือกอยู่</p>
                {selectedCut ? (
                  <p className="mt-0.5 min-w-0 text-sm text-muted">
                    <span className="text-lg font-semibold text-ink">
                      ฉาก {playOrderMap.get(selectedCut.id) ?? '–'}
                    </span>{' '}
                    จาก {cuts.length} · ยาว {(selectedCut.out - selectedCut.in).toFixed(2)} วิ ·{' '}
                    {selectedCut.source} ที่ {fmtTime(selectedCut.in)}
                  </p>
                ) : (
                  <p className="mt-0.5 text-sm text-muted">คลิกฉากบนเส้นเวลาเพื่อเลือก</p>
                )}
              </div>

              {showTabs && (
                <Tabs
                  className="shrink-0 px-4"
                  items={[
                    { key: 'script', label: isHighlight ? 'โน้ตประกอบ' : 'เสียงพากย์' },
                    captionLines
                      ? { key: 'caption', label: 'คำบรรยายบนภาพ' }
                      : {
                          key: 'caption',
                          label: 'คำบรรยายบนภาพ',
                          disabled: true,
                          disabledReason: 'โปรเจกต์นี้ไม่ได้เปิดคำบรรยาย'
                        }
                  ]}
                  activeKey={activeInspectorTab}
                  onChange={(k) => setInspectorTab(k as 'script' | 'caption')}
                />
              )}

              <div className="scroll-ghost min-h-0 flex-1 overflow-y-auto px-4 py-3">
                {activeInspectorTab === 'script' && isDub ? (
                  selectedCut ? (
                    <>
                      <p className="mb-1.5 text-[13px] text-muted">
                        {isHighlight
                          ? `โน้ตของฉากนี้ (ไม่บังคับ)`
                          : `ประโยคพากย์ที่ ${cutLineId(selectedCut)}` +
                            (lineCuts.length > 1
                              ? ` — แก้ที่นี่ เปลี่ยนทั้ง ${lineCuts.length} มุม`
                              : '')}
                      </p>
                      <Textarea
                        value={lineScriptFor(cuts, cutLineId(selectedCut))}
                        onChange={(e) => updateLineScript(cutLineId(selectedCut), e.target.value)}
                        onFocus={beginEdit}
                        onBlur={commitEdit}
                        rows={4}
                        placeholder={
                          isHighlight
                            ? 'พิมพ์โน้ตสำหรับฉากนี้…'
                            : 'พิมพ์สคริปต์สำหรับประโยคนี้ (ใช้ร่วมทุกมุม)…'
                        }
                      />
                      {!isHighlight && (
                        <>
                          <p className="mt-4 mb-1.5 text-[13px] text-muted">
                            มุมของประโยคนี้{' '}
                            <span className="font-semibold text-ink">{lineCuts.length} มุม</span>
                          </p>
                          <div className="flex items-center gap-1.5">
                            {lineCuts.map((c) => (
                              <button
                                key={c.id}
                                type="button"
                                onClick={() => void selectCut(c)}
                                title={`มุม ${cutIndexInLine(cuts, c)} · ${(c.out - c.in).toFixed(1)} วิ`}
                                className={`h-11 w-[26px] overflow-hidden rounded border bg-black transition-colors duration-state ${
                                  c.id === selectedId
                                    ? 'border-accent'
                                    : 'border-border hover:border-border-strong'
                                }`}
                              >
                                {angleThumbs[angleThumbKey(c)] ? (
                                  <img
                                    src={angleThumbs[angleThumbKey(c)]}
                                    alt=""
                                    className="h-full w-full object-cover"
                                  />
                                ) : null}
                              </button>
                            ))}
                            <button
                              type="button"
                              onClick={addMontageCut}
                              title={withShortcut('เพิ่มมุมให้ประโยคนี้', 'add-angle')}
                              className="flex h-11 w-[26px] items-center justify-center rounded border border-dashed border-border text-muted transition-colors duration-state hover:border-border-strong hover:text-ink"
                            >
                              <Plus size={12} />
                            </button>
                          </div>
                        </>
                      )}
                    </>
                  ) : (
                    <p className="text-sm text-muted">เลือกฉากก่อนถึงจะแก้บทพากย์ได้</p>
                  )
                ) : captionLines && captionLines.length > 0 && cursorLine ? (
                  <>
                    {/* R7 order: header · text · timecodes+delete · prev/next */}
                    <div className="mb-2 flex items-baseline justify-between gap-2">
                      <p className="text-[13px] text-muted">ท่อนที่ตรงกับฉากนี้</p>
                      <p className="shrink-0 text-[13px] tabular-nums text-muted">
                        ท่อน {captionCursorIdx + 1} จาก {captionLines.length}
                      </p>
                    </div>
                    <Textarea
                      value={cursorLine.text}
                      onChange={(e) => updateCaptionLine(cursorLine.id, { text: e.target.value })}
                      onFocus={beginEdit}
                      onBlur={commitEdit}
                      rows={2}
                    />
                    {/* Timecodes, not raw seconds (R7): the rest of the editor
                        speaks 0:22.4, so this field must too. Typing is parsed
                        back through parseTimecode, which also accepts a plain
                        number for anyone who prefers seconds. */}
                    <div className="mt-3 flex items-center gap-2 text-sm">
                      <TimecodeInput
                        value={cursorLine.start}
                        onFocus={beginEdit}
                        onCommit={(v) => {
                          updateCaptionLine(cursorLine.id, {
                            start: clamp(v, 0, cursorLine.end)
                          })
                          commitEdit()
                        }}
                      />
                      <span className="text-muted">ถึง</span>
                      <TimecodeInput
                        value={cursorLine.end}
                        onFocus={beginEdit}
                        onCommit={(v) => {
                          updateCaptionLine(cursorLine.id, {
                            end: Math.max(v, cursorLine.start)
                          })
                          commitEdit()
                        }}
                      />
                      <Button
                        className="ml-auto"
                        variant="danger"
                        icon={<Trash2 size={15} />}
                        iconOnly
                        aria-label="ลบท่อนนี้"
                        title="ลบท่อนนี้"
                        onClick={() => {
                          deleteCaptionLine(cursorLine.id)
                          setCaptionCursor((i) => Math.max(0, i - 1))
                        }}
                      />
                    </div>
                    <div className="mt-3 flex items-center gap-1.5 [&_button]:whitespace-nowrap">
                      {captionCursorIdx > 0 ? (
                        <Button
                          icon={<ChevronLeft size={14} />}
                          onClick={() => jumpToCaption(captionCursorIdx - 1)}
                        >
                          ก่อนหน้า
                        </Button>
                      ) : (
                        <Button
                          icon={<ChevronLeft size={14} />}
                          disabled
                          reasonAs="tooltip"
                          disabledReason="นี่คือท่อนแรกแล้ว"
                        >
                          ก่อนหน้า
                        </Button>
                      )}
                      {captionCursorIdx < captionLines.length - 1 ? (
                        <Button
                          icon={<ChevronRight size={14} />}
                          onClick={() => jumpToCaption(captionCursorIdx + 1)}
                        >
                          ถัดไป
                        </Button>
                      ) : (
                        <Button
                          icon={<ChevronRight size={14} />}
                          disabled
                          reasonAs="tooltip"
                          disabledReason="นี่คือท่อนสุดท้ายแล้ว"
                        >
                          ถัดไป
                        </Button>
                      )}
                    </div>
                    <p className="mt-2 text-[13px] text-muted">
                      แก้คำที่ถอดเสียงผิดได้ · ลบท่อนที่ AI ฟังผิดได้
                    </p>
                    {captionStyle && (
                      // Appearance row (R7): an "Aa" tile in the chosen font so
                      // the choice is visible, the summary, and its own button.
                      <div className="mt-4 flex items-center gap-3 border-t border-divider pt-3">
                        <span
                          className="flex h-9 w-[52px] shrink-0 items-center justify-center rounded border border-border bg-black text-[15px] font-bold"
                          style={{ color: captionStyle.color, fontFamily: captionStyle.font }}
                        >
                          Aa
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-ink">
                            {captionStyleSummary(captionStyle)}
                          </span>
                          <span className="block text-[13px] text-muted">
                            หน้าตาคำบรรยายใช้กับทั้งคลิป
                          </span>
                        </span>
                        <Button onClick={() => setCaptionStyleOpen(true)}>ปรับหน้าตา</Button>
                      </div>
                    )}
                    {srtNote && <p className="mt-2 text-[13px] text-muted">{srtNote}</p>}
                  </>
                ) : (
                  <p className="text-sm text-muted">
                    {captionLines
                      ? 'ยังไม่มีท่อนคำบรรยายในโปรเจกต์นี้'
                      : 'โปรเจกต์นี้ไม่ได้เปิดคำบรรยาย'}
                  </p>
                )}
              </div>

              {/* Caption footer (R7): what the whole set is, and the export —
                  pinned outside the scrolling body so it is always reachable. */}
              {activeInspectorTab === 'caption' && captionLines && captionLines.length > 0 && (
                <div className="flex shrink-0 items-center justify-between gap-2 border-t border-divider px-4 py-3">
                  <p className="min-w-0 truncate text-[13px] text-muted">
                    <span className="tabular-nums">{captionLines.length}</span> ท่อน ·{' '}
                    {isDub ? 'สร้างจากสคริปต์พากย์' : 'สร้างจากการถอดเสียง'}
                  </p>
                  <Button
                    icon={<Download size={14} />}
                    loading={srtBusy}
                    onClick={exportSrt}
                    title="บันทึกท่อนคำบรรยายที่แก้อยู่ตอนนี้เป็นไฟล์ .srt"
                  >
                    ส่งออก .srt
                  </Button>
                </div>
              )}

              {/* pinned actions — แยกฉาก / ทำซ้ำ / ลบ (R3) */}
              <div className="flex shrink-0 items-center gap-2 border-t border-divider px-4 py-3">
                <Button
                  className="flex-1"
                  icon={<Scissors size={14} />}
                  onClick={splitAtPlayhead}
                  title={withShortcut('แยกฉากตรงหัวเล่น', 'split')}
                >
                  แยกฉาก
                </Button>
                {selectedCut ? (
                  <>
                    <Button
                      className="flex-1"
                      icon={<Copy size={14} />}
                      onClick={duplicateSelectedCut}
                    >
                      ทำซ้ำ
                    </Button>
                    <Button
                      variant="danger"
                      icon={<Trash2 size={15} />}
                      iconOnly
                      aria-label="ลบฉากที่เลือก"
                      onClick={deleteSelectedCut}
                    />
                  </>
                ) : (
                  <>
                    <Button
                      className="flex-1"
                      icon={<Copy size={14} />}
                      disabled
                      reasonAs="tooltip"
                      disabledReason="เลือกฉากก่อน"
                    >
                      ทำซ้ำ
                    </Button>
                    <Button
                      variant="danger"
                      icon={<Trash2 size={15} />}
                      iconOnly
                      aria-label="ลบฉากที่เลือก"
                      disabled
                      reasonAs="tooltip"
                      disabledReason="เลือกฉากก่อน"
                    />
                  </>
                )}
              </div>
            </aside>
          </div>

          {/* timeline — toolbar · ruler+tracks (one scroll container) · hint */}
          <div className="shrink-0 border-t border-divider">
            <div className="flex items-center gap-2 px-4 py-2">
              <div className="flex items-center gap-1 rounded-lg border border-border p-0.5">
                <button
                  type="button"
                  onClick={() => switchViewMode('edited')}
                  title={withShortcut('ดูแบบตัดแล้ว', 'view-edited')}
                  className={`rounded-md border px-2.5 py-1 text-[13px] font-medium transition-colors duration-state ${
                    viewMode === 'edited'
                      ? 'border-accent bg-accent-nav text-accent'
                      : 'border-transparent text-muted hover:text-ink'
                  }`}
                >
                  ตัดแล้ว
                </button>
                <button
                  type="button"
                  onClick={() => switchViewMode('source')}
                  title={withShortcut('ดูคลิปต้นฉบับ', 'view-source')}
                  className={`rounded-md border px-2.5 py-1 text-[13px] font-medium transition-colors duration-state ${
                    viewMode === 'source'
                      ? 'border-accent bg-accent-nav text-accent'
                      : 'border-transparent text-muted hover:text-ink'
                  }`}
                >
                  ต้นฉบับ
                </button>
              </div>
              {thStats && (
                <p className="text-[13px] text-muted">
                  <span className="font-medium text-ink">ตัดช่วงเงียบ</span> · ตัดออกแล้ว{' '}
                  {thStats.removedCount} ช่วง · {fmtTime(thStats.keptSec)} จาก{' '}
                  {fmtTime(thStats.totalSec)}
                </p>
              )}
              <span className="h-5 w-px bg-divider" />
              {/* The key is drawn beside the label (R3), not hidden in a
                  title= — a shortcut nobody can see is a shortcut nobody uses. */}
              <Button
                icon={<Scissors size={14} />}
                onClick={splitAtPlayhead}
                title={withShortcut('แยกฉากตรงหัวเล่น', 'split')}
              >
                แยกที่หัวเล่น <ShortcutKey id="split" />
              </Button>
              <Button
                icon={<Plus size={14} />}
                onClick={addSceneAtPlayhead}
                title={withShortcut('เพิ่มฉากที่หัวเล่น', 'add-scene')}
              >
                เพิ่มฉาก <ShortcutKey id="add-scene" />
              </Button>
              {selectedCut ? (
                <Button
                  icon={<Trash2 size={14} />}
                  onClick={deleteSelectedCut}
                  title={withShortcut('ลบฉากที่เลือก แล้วฉากถัดไปเลื่อนมาชิด', 'delete')}
                >
                  ลบแล้วดึงชิด
                </Button>
              ) : (
                <Button
                  icon={<Trash2 size={14} />}
                  disabled
                  reasonAs="tooltip"
                  disabledReason="เลือกฉากก่อน"
                >
                  ลบแล้วดึงชิด
                </Button>
              )}
              <span className="flex-1" />
              {/* Stays on screen with no music, disabled with its reason — the
                  design's own caption promises it "เปิดใช้ได้เมื่อมีเพลง", which
                  only means something if you can see the control. */}
              {(music?.beats?.length ?? 0) > 0 ? (
                <button
                  type="button"
                  onClick={() => setSnapToBeatEnabled((v) => !v)}
                  title="ลากขอบฉากแล้วดูดเข้าจังหวะเพลงอัตโนมัติ"
                  className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[13px] font-medium transition-colors duration-state ${
                    snapToBeatEnabled
                      ? 'border-accent bg-accent-nav text-accent'
                      : 'border-border text-muted hover:text-ink'
                  }`}
                >
                  <Magnet size={13} />
                  ดูดเข้าจังหวะ
                </button>
              ) : (
                <Button
                  icon={<Magnet size={13} />}
                  disabled
                  reasonAs="tooltip"
                  disabledReason={
                    music ? 'เพลงนี้ยังไม่มีข้อมูลจังหวะ' : 'ใส่เพลงประกอบก่อนถึงจะดูดเข้าจังหวะได้'
                  }
                >
                  ดูดเข้าจังหวะ
                </Button>
              )}
              <Slider
                className="w-44"
                value={pxPerSec}
                min={MIN_PX_PER_SEC}
                max={MAX_PX_PER_SEC}
                step={2}
                onChange={setPxPerSec}
                formatValue={(v) => `${Math.round(v)} px/วิ`}
              />
              <Button icon={<Maximize2 size={14} />} onClick={fitToScreen}>
                พอดีจอ
              </Button>
            </div>

            <div
              ref={viewportRef}
              onWheel={onTimelineWheel}
              onScroll={onViewportScroll}
              className="scroll-ghost relative max-h-[248px] overflow-auto select-none"
            >
              <div className="relative" style={{ width: HEADER_COL_PX + contentW }}>
                {/* ruler */}
                <div className="flex" style={{ height: RULER_PX }}>
                  <div
                    // Same stacking rule as trackLabelCls — this is the
                    // ruler's corner and the ruler ticks must scroll under it.
                    className="sticky left-0 z-40 h-full shrink-0 bg-ground"
                    style={{ width: HEADER_COL_PX }}
                  />
                  <TimelineRuler
                    durationSec={axisDur}
                    pxPerSec={pxPerSec}
                    widthPx={contentW}
                    onPointerDown={onRulerPointerDown}
                  />
                </div>

                {viewMode === 'edited' ? (
                  <>
                    {/* ภาพ */}
                    <div
                      className="flex items-center"
                      style={{ height: IMG_LANE_PX, marginBottom: TRACK_GAP_PX }}
                    >
                      <div className={trackLabelCls} style={{ width: HEADER_COL_PX }}>
                        ภาพ
                        <span className="tabular-nums text-ink-3">{cuts.length}</span>
                      </div>
                      <div
                        className="relative h-full cursor-crosshair"
                        style={{ width: contentW }}
                        onPointerDown={onLaneBackgroundPointerDown}
                      >
                        <DndContext
                          sensors={sensors}
                          collisionDetection={closestCenter}
                          onDragEnd={handleSequenceDragEnd}
                        >
                          <SortableContext
                            items={cuts.map((c) => c.id)}
                            strategy={horizontalListSortingStrategy}
                          >
                            <ul className="flex h-full items-stretch">
                              {cuts.map((c) => (
                                <EditedCutBlock
                                  key={c.id}
                                  cut={c}
                                  selected={c.id === selectedId}
                                  playOrder={playOrderMap.get(c.id) ?? 0}
                                  filmstrip={filmstrips[c.source] ?? null}
                                  sourceDurationSec={
                                    timeline.sources.find((s) => s.id === c.source)?.durationSec ??
                                    0
                                  }
                                  pxPerSec={pxPerSec}
                                  onSelect={() => void selectCut(c)}
                                  onChange={(patch) => updateCut(c.id, patch)}
                                  onDragStart={beginCutBlockEdit}
                                  onDragEnd={commitCutBlockEdit}
                                  onNeedFilmstrip={queueFilmstripRange}
                                  startOffsetSec={
                                    computeEditedSegments(cuts).find((s) => s.cut.id === c.id)
                                      ?.editedIn ?? 0
                                  }
                                  beatsSec={effectiveMusic?.beats ?? null}
                                  snapEnabled={snapToBeatEnabled}
                                  musicOffsetSec={effectiveMusic?.offsetSec ?? 0}
                                  musicTrimInSec={effectiveMusic?.trimInSec ?? 0}
                                />
                              ))}
                            </ul>
                          </SortableContext>
                        </DndContext>
                      </div>
                    </div>

                    {/* เสียงพากย์ (dub) */}
                    {isDub && (
                      <div
                        className="flex items-center"
                        style={{ height: VO_LANE_PX, marginBottom: TRACK_GAP_PX }}
                      >
                        <div className={trackLabelCls} style={{ width: HEADER_COL_PX }}>
                          เสียงพากย์
                        </div>
                        <div
                          className="relative h-full rounded-md bg-surface"
                          style={{ width: contentW }}
                          onPointerDown={onLaneBackgroundPointerDown}
                        >
                          {voBlocks.map((b) => {
                            const isActive =
                              selectedCut !== null && cutLineId(selectedCut) === b.lineId
                            const isSpeaking = b.lineId === playingLineId
                            return (
                              <button
                                key={b.lineId}
                                type="button"
                                data-cut-block
                                onPointerDown={(e) => e.stopPropagation()}
                                onClick={() => {
                                  const first = cuts.find((c) => c.id === b.firstCutId)
                                  if (first) void selectCut(first)
                                  setInspectorTab('script')
                                }}
                                title={b.script || `ประโยค ${b.lineId}`}
                                className={`absolute inset-y-0.5 overflow-hidden rounded border px-2 text-left text-[13px] transition-colors duration-state ${
                                  isActive
                                    ? 'border-accent bg-accent-nav text-accent'
                                    : isSpeaking
                                      ? 'border-[rgb(217_164_65_/_0.45)] bg-[rgb(217_164_65_/_0.08)] text-ink'
                                      : 'border-border bg-ground text-muted hover:text-ink'
                                }`}
                                style={{
                                  left: b.outStart * pxPerSec,
                                  width: Math.max(b.durationSec * pxPerSec - 2, 20)
                                }}
                              >
                                <span className="truncate">
                                  {b.lineId}
                                  {b.script ? ` · ${b.script}` : ''}
                                </span>
                              </button>
                            )
                          })}
                          {voBlocks.length === 0 && (
                            <p className="flex h-full items-center px-3 text-[13px] text-muted">
                              ยังไม่มีเสียงพากย์ช่วงนี้
                            </p>
                          )}
                        </div>
                      </div>
                    )}

                    {/* เพลง — both modes. The R3 ตัดช่วงเงียบ variant carries
                        this lane too; music is attached to the project, not to
                        whether AI wrote the script. */}
                    {
                      <div
                        className="flex items-center"
                        style={{ height: MUSIC_LANE_PX, marginBottom: TRACK_GAP_PX }}
                      >
                        <div className={trackLabelCls} style={{ width: HEADER_COL_PX }}>
                          เพลง
                          {music && (
                            <span className="flex items-center gap-0.5">
                              <button
                                type="button"
                                onClick={() => void commitMusic({ muted: !music.muted })}
                                title={music.muted ? 'เปิดเสียงเพลง' : 'ปิดเสียงเพลง'}
                                className="rounded p-0.5 text-muted transition-colors duration-state hover:text-ink"
                              >
                                {music.muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
                              </button>
                              <button
                                type="button"
                                onClick={() => void handlePickMusic()}
                                disabled={musicBusy}
                                title="เปลี่ยนเพลง"
                                className="rounded p-0.5 text-muted transition-colors duration-state hover:text-ink disabled:opacity-40"
                              >
                                <RefreshCw size={12} />
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleRemoveMusic()}
                                disabled={musicBusy}
                                title="ลบเพลงประกอบ"
                                className="rounded p-0.5 text-muted transition-colors duration-state hover:text-error disabled:opacity-40"
                              >
                                <Trash2 size={12} />
                              </button>
                            </span>
                          )}
                        </div>
                        <div
                          className="relative h-full"
                          style={{ width: contentW }}
                          onPointerDown={onLaneBackgroundPointerDown}
                        >
                          {music ? (
                            <MusicBlock
                              music={music}
                              peaks={musicPeaks}
                              fullDurationSec={musicDurationSec}
                              pxPerSec={pxPerSec}
                              cutBoundaries={outputCutBoundaries}
                              snapEnabled={snapToBeatEnabled}
                              onChange={(patch) => void commitMusic(patch)}
                              onDraftChange={setMusicDraft}
                            />
                          ) : (
                            <button
                              type="button"
                              data-cut-block
                              onPointerDown={(e) => e.stopPropagation()}
                              onClick={() => void handlePickMusic()}
                              disabled={musicBusy}
                              className="flex h-full items-center justify-center gap-2 rounded-md border border-dashed border-border text-[13px] text-muted transition-colors duration-state hover:border-border-strong hover:text-ink disabled:opacity-50"
                              style={{ width: Math.max(editedDur * pxPerSec, MIN_LANE_PX) }}
                            >
                              {musicBusy ? (
                                <Loader2 size={13} className="animate-spin" />
                              ) : (
                                <Music2 size={13} />
                              )}
                              เพิ่มเพลงประกอบ — ไฟล์เพลง หรือวิดีโอที่มีเพลงก็ได้
                            </button>
                          )}
                        </div>
                      </div>
                    }
                    {/* คำบรรยาย */}
                    {captionLines && captionLines.length > 0 && (
                      <div
                        className="flex items-center"
                        style={{ height: CAPTION_LANE_PX, marginBottom: TRACK_GAP_PX }}
                      >
                        <div className={trackLabelCls} style={{ width: HEADER_COL_PX }}>
                          คำบรรยาย
                        </div>
                        <div
                          className="relative h-full"
                          style={{ width: contentW }}
                          onPointerDown={onLaneBackgroundPointerDown}
                        >
                          {capSpans.map((chip) => {
                            const idx = captionLines.findIndex((l) => l.id === chip.id)
                            const isActive = idx === captionCursorIdx
                            return (
                              <div
                                key={chip.id}
                                data-cut-block
                                onPointerDown={(e) => e.stopPropagation()}
                                className={`absolute inset-y-0 rounded border transition-colors duration-state ${
                                  isActive
                                    ? 'border-accent bg-accent-nav'
                                    : 'border-border-faint bg-surface hover:border-border'
                                }`}
                                style={{
                                  left: chip.outStart * pxPerSec,
                                  width: Math.max(chip.durationSec * pxPerSec - 2, 16)
                                }}
                              >
                                <button
                                  type="button"
                                  onClick={() => {
                                    setInspectorTab('caption')
                                    jumpToCaption(idx)
                                  }}
                                  title={chip.text}
                                  className={`h-full w-full overflow-hidden px-2 text-left text-[13px] ${
                                    isActive ? 'text-ink' : 'text-ink-2'
                                  }`}
                                >
                                  <span className="truncate">{chip.text}</span>
                                </button>
                                {/* Edge drags retime the line itself (R7). The
                                    handles are hit areas, not visible bars —
                                    the lane is 24px tall and a 12px bar would
                                    swallow the text. */}
                                <CaptionEdge chip={chip} edge="left" onDrag={dragCaption} />
                                <CaptionEdge chip={chip} edge="right" onDrag={dragCaption} />
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  /* source view (จ) — one lane per file under the shared axis */
                  <>
                    {timeline.sources.map((src) => (
                      <div
                        key={src.id}
                        className="flex items-center"
                        style={{ height: IMG_LANE_PX, marginBottom: TRACK_GAP_PX }}
                      >
                        <div className={trackLabelCls} style={{ width: HEADER_COL_PX }}>
                          <span
                            className={`truncate ${previewSource === src.id ? 'text-ink' : ''}`}
                            title={src.id}
                          >
                            {src.id}
                          </span>
                        </div>
                        <div
                          className="relative h-full"
                          style={{ width: contentW }}
                          onPointerDown={(e) => onSourceLanePointerDown(src.id, e)}
                        >
                          <SourceLaneRow
                            laneDurationSec={getSourceDurationSec(src.id)}
                            strip={filmstrips[src.id] ?? null}
                            cuts={cuts.filter((c) => c.source === src.id)}
                            playOrderMap={playOrderMap}
                            selectedId={selectedId}
                            pxPerSec={pxPerSec}
                            isActive={previewSource === src.id}
                            onSelect={(c) => void selectCut(c)}
                            onChange={updateCut}
                            onDragStart={beginCutBlockEdit}
                            onDragEnd={commitCutBlockEdit}
                          />
                        </div>
                      </div>
                    ))}
                  </>
                )}

                {/* Beat ticks sit BEHIND the lanes (z-0): they are a guide for
                    the eye, and painting them over a block's own artwork or
                    label makes both harder to read (HANDOFF §3). */}
                {viewMode === 'edited' &&
                  snapToBeatEnabled &&
                  effectiveMusic?.beats &&
                  effectiveMusic.beats.length > 0 && (
                    <div
                      className="pointer-events-none absolute inset-x-0 bottom-0 -z-10"
                      style={{ top: RULER_PX }}
                    >
                      {effectiveMusic.beats.map((b, i) => {
                        const outputSec = b - effectiveMusic.trimInSec + effectiveMusic.offsetSec
                        if (outputSec < 0 || outputSec > editedDur) return null
                        return (
                          <div
                            key={i}
                            className="absolute top-0 bottom-0 w-px bg-[rgb(217_164_65_/_0.4)]"
                            style={{ left: HEADER_COL_PX + outputSec * pxPerSec }}
                          />
                        )
                      })}
                    </div>
                  )}

                {/* playhead — a positioned element over a static timeline */}
                <div
                  ref={playheadRef}
                  className="pointer-events-none absolute top-0 bottom-0 left-0 z-20 will-change-transform"
                >
                  {/* The whole line is the handle, not just its head: an 8px
                      grab strip runs the full height over a 2px visible rule,
                      so you can catch the playhead wherever your eye is. */}
                  <div
                    onPointerDown={onRulerPointerDown}
                    title="ลากเพื่อเลื่อนหัวเล่น"
                    className="pointer-events-auto absolute top-0 bottom-0 w-2 -translate-x-1/2 cursor-ew-resize touch-none"
                  >
                    <span className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-ink" />
                  </div>
                  <div
                    onPointerDown={onRulerPointerDown}
                    title="ลากเพื่อเลื่อนหัวเล่น"
                    className="pointer-events-auto absolute top-0 h-3 w-[18px] -translate-x-1/2 cursor-ew-resize rounded-[2px_2px_4px_4px] bg-ink"
                  />
                </div>
              </div>
            </div>

            <p className="truncate px-4 py-1.5 text-[13px] text-muted">
              {viewMode === 'edited'
                ? `ลากไม้บรรทัดเพื่อเลื่อนหัวเล่น · ลากขอบทองเพื่อยืด–หดฉาก · ลากตัวบล็อกเพื่อสลับลำดับ · ลากขอบท่อนคำบรรยายเพื่อยืด–หดเวลา${
                    isDub && music ? ' · ลากปลายบล็อกเพลงเพื่อตัดต้น–ท้ายเพลง' : ''
                  } · Alt+ล้อ เพื่อซูม · Space เล่น/หยุด`
                : 'ตัวเลขในบล็อกคือลำดับที่จะเล่นจริง · ช่วงที่ไม่มีบล็อกคือส่วนที่ไม่ถูกใช้ · ลากขอบเพื่อเปลี่ยนช่วงที่ตัดมาใช้'}
            </p>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Seconds shown as a timecode, edited as text.
 *
 * Keeps its own draft string while focused so typing "0:2" does not get
 * reformatted mid-keystroke; commits on blur/Enter and reverts on Escape or
 * an unparseable value.
 */
function TimecodeInput({
  value,
  onCommit,
  onFocus
}: {
  value: number
  onCommit: (sec: number) => void
  onFocus: () => void
}) {
  const [draft, setDraft] = useState<string | null>(null)

  const commit = (): void => {
    if (draft === null) return
    const parsed = parseTimecode(draft)
    if (parsed !== null) onCommit(parsed)
    setDraft(null)
  }

  return (
    <input
      type="text"
      inputMode="decimal"
      value={draft ?? fmtTimeTenths(value)}
      onFocus={() => {
        onFocus()
        setDraft(fmtTimeTenths(value))
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          setDraft(null)
          e.currentTarget.blur()
        }
      }}
      className="w-24 rounded-md border border-border bg-transparent px-2 py-1.5 text-sm tabular-nums text-ink"
    />
  )
}

/** Invisible 8px grab strip on a caption chip's edge. */
function CaptionEdge({
  chip,
  edge,
  onDrag
}: {
  chip: CaptionChipSpan
  edge: TrimEdge
  onDrag: (chip: CaptionChipSpan, edge: TrimEdge, e: React.PointerEvent) => void
}) {
  return (
    <button
      type="button"
      data-trim-handle
      title={edge === 'left' ? 'ลากเพื่อเลื่อนเวลาเริ่ม' : 'ลากเพื่อเลื่อนเวลาจบ'}
      aria-label={edge === 'left' ? 'ปรับเวลาเริ่มของท่อนนี้' : 'ปรับเวลาจบของท่อนนี้'}
      onPointerDown={(e) => onDrag(chip, edge, e)}
      className={`absolute inset-y-0 z-10 w-2 cursor-ew-resize touch-none ${
        edge === 'left' ? 'left-0' : 'right-0'
      }`}
    />
  )
}

/** Shared time ruler — labels + minor ticks; dragging it moves the playhead. */
function TimelineRuler({
  durationSec,
  pxPerSec,
  widthPx,
  onPointerDown
}: {
  durationSec: number
  pxPerSec: number
  widthPx: number
  onPointerDown: (e: React.PointerEvent) => void
}) {
  const step = rulerStepSec(pxPerSec)
  const count = Math.max(1, Math.ceil(durationSec / step) + 1)
  const ticks = Array.from({ length: count }, (_, i) => i * step)
  return (
    <div
      // Crosshair, matching the zoom editor's band — one gesture (put the
      // playhead here) should not look like two different tools.
      className="relative h-full shrink-0 cursor-crosshair border-b border-divider"
      style={{ width: widthPx }}
      onPointerDown={onPointerDown}
      title="ลากไม้บรรทัดเพื่อเลื่อนหัวเล่น"
    >
      {/* A label reads as belonging to the tick it ENDS at, so it sits just
          before its tick; t=0 has no tick and hugs the left edge (R3). */}
      {ticks.map((t) => (
        <span
          key={t}
          className="absolute top-0.5 text-[13px] leading-none tabular-nums text-ink-3"
          style={
            t === 0
              ? { left: 0 }
              : { left: t * pxPerSec, transform: 'translateX(calc(-100% - 4px))' }
          }
        >
          {fmtTime(t)}
        </span>
      ))}
      {ticks.map((t) =>
        t === 0 ? null : (
          <span
            key={`m${t}`}
            className="absolute bottom-0 h-1.5 w-px bg-border"
            style={{ left: t * pxPerSec }}
          />
        )
      )}
    </div>
  )
}

/** R3's ที่จับยืด–หด: a gold bar the full height of the block, 12px wide. */
function TrimBar({
  edge,
  onTrimDown
}: {
  edge: TrimEdge
  onTrimDown: (e: React.PointerEvent, edge: TrimEdge) => void
}) {
  return (
    <button
      type="button"
      data-trim-handle
      title={edge === 'left' ? 'ลากเพื่อปรับจุดเริ่ม' : 'ลากเพื่อปรับจุดจบ'}
      onPointerDown={(e) => onTrimDown(e, edge)}
      className={`absolute inset-y-0 z-30 flex w-[12px] cursor-ew-resize touch-none items-center justify-center bg-accent ${
        edge === 'left' ? 'left-0 rounded-l-[5px]' : 'right-0 rounded-r-[5px]'
      }`}
    >
      <span className="block h-3 w-[2px] rounded bg-black/50" />
    </button>
  )
}

function SourceLaneRow({
  laneDurationSec,
  strip,
  cuts,
  playOrderMap,
  selectedId,
  pxPerSec,
  isActive,
  onSelect,
  onChange,
  onDragStart,
  onDragEnd
}: {
  laneDurationSec: number
  strip: Filmstrip | null
  cuts: WorkingCut[]
  playOrderMap: Map<string, number>
  selectedId: string | null
  pxPerSec: number
  isActive: boolean
  onSelect: (c: WorkingCut) => void
  onChange: (id: string, patch: Partial<WorkingCut>) => void
  onDragStart: () => void
  onDragEnd: () => void
}) {
  const width = Math.max(laneDurationSec * pxPerSec, MIN_LANE_PX)
  const thumbWidthPx = strip && strip.thumbs.length > 0 ? width / strip.thumbs.length : 0

  return (
    <div
      className={`relative h-full overflow-hidden rounded-md border bg-surface ${
        isActive ? 'border-border-strong' : 'border-border-faint'
      }`}
      style={{ width }}
    >
      {strip ? (
        <div className="pointer-events-none absolute inset-0 flex opacity-40">
          {strip.thumbs.map((t, i) =>
            t ? (
              <img
                key={i}
                src={t}
                alt=""
                draggable={false}
                className="h-full shrink-0 object-cover"
                style={{ width: thumbWidthPx }}
              />
            ) : (
              <div key={i} className="h-full shrink-0 bg-surface" style={{ width: thumbWidthPx }} />
            )
          )}
        </div>
      ) : (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[13px] text-muted">
          กำลังโหลดภาพตัวอย่าง…
        </div>
      )}
      {cuts.map((c) => (
        <SourceCutBlock
          key={c.id}
          cut={c}
          sourceCuts={cuts}
          laneDurationSec={laneDurationSec}
          selected={c.id === selectedId}
          playOrder={playOrderMap.get(c.id) ?? 0}
          pxPerSec={pxPerSec}
          onSelect={() => onSelect(c)}
          onChange={(patch) => onChange(c.id, patch)}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        />
      ))}
    </div>
  )
}

type DragMode = 'move' | 'resize-left' | 'resize-right'

function SourceCutBlock({
  cut,
  sourceCuts,
  laneDurationSec,
  selected,
  playOrder,
  pxPerSec,
  onSelect,
  onChange,
  onDragStart,
  onDragEnd
}: {
  cut: WorkingCut
  sourceCuts: EditCut[]
  laneDurationSec: number
  selected: boolean
  playOrder: number
  pxPerSec: number
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

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return
    e.stopPropagation()
    onDragStart()
    dragState.current = {
      mode: 'move',
      startX: e.clientX,
      startIn: cut.in,
      startOut: cut.out,
      moved: false
    }
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture(e.pointerId)
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = dragState.current
    if (!d) return
    if (Math.abs(e.clientX - d.startX) > 3) d.moved = true
    const deltaSec = (e.clientX - d.startX) / pxPerSec
    if (d.mode === 'move') {
      const dur = d.startOut - d.startIn
      const newIn = clamp(d.startIn + deltaSec, bounds.minIn, bounds.maxOut - dur)
      onChange({ in: newIn, out: newIn + dur })
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

  function onTrimDown(e: React.PointerEvent, edge: TrimEdge) {
    bindTrimDrag({
      e,
      edge,
      pxPerSec,
      startIn: cut.in,
      startOut: cut.out,
      minIn: bounds.minIn,
      maxOut: bounds.maxOut,
      onChange,
      onDragStart,
      onDragEnd
    })
  }

  const left = cut.in * pxPerSec
  const width = Math.max((cut.out - cut.in) * pxPerSec, 8)

  return (
    <div
      data-cut-block
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      className={`absolute inset-y-0 cursor-grab rounded-[5px] border bg-black/35 active:cursor-grabbing ${
        selected ? 'border-accent' : 'border-accent/45 hover:border-accent/70'
      }`}
      style={{ left, width }}
    >
      <span className="absolute bottom-0.5 left-1.5 z-10 text-[13px] font-semibold tabular-nums text-ink">
        {playOrder || ''}
      </span>
      {selected && (
        <>
          <TrimBar edge="left" onTrimDown={onTrimDown} />
          <TrimBar edge="right" onTrimDown={onTrimDown} />
        </>
      )}
    </div>
  )
}

/**
 * Concatenated "edited" view of a scene: a cropped window of its source's full
 * filmstrip so scenes read as trimmed clips laid back-to-back, no gaps. The
 * whole block is draggable to reorder (R3: ลากตัวบล็อกเพื่อสลับลำดับ).
 */
function EditedCutBlock({
  cut,
  selected,
  playOrder,
  filmstrip,
  sourceDurationSec,
  pxPerSec,
  onSelect,
  onChange,
  onDragStart,
  onDragEnd,
  onNeedFilmstrip,
  startOffsetSec = 0,
  beatsSec = null,
  snapEnabled = false,
  musicOffsetSec = 0,
  musicTrimInSec = 0
}: {
  cut: WorkingCut
  selected: boolean
  playOrder: number
  filmstrip: Filmstrip | null
  sourceDurationSec: number
  pxPerSec: number
  onSelect: () => void
  onChange: (patch: Partial<WorkingCut>) => void
  onDragStart: () => void
  onDragEnd: () => void
  onNeedFilmstrip: (sourceId: string, durationSec: number, startSec: number, endSec: number) => void
  /** This cut's start position on the output/edited timeline — trimming this
   * cut's edge only ever moves the boundary at startOffsetSec + durationSec. */
  startOffsetSec?: number
  beatsSec?: number[] | null
  snapEnabled?: boolean
  musicOffsetSec?: number
  musicTrimInSec?: number
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: cut.id
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 30 : undefined
  }
  const durationSec = Math.max(cut.out - cut.in, 0)
  const widthPx = Math.max(durationSec * pxPerSec, 24)
  const fullSourcePx = Math.max(sourceDurationSec * pxPerSec, MIN_LANE_PX)

  // Only this cut's own small window needs thumbnails — not the whole source clip.
  useEffect(() => {
    onNeedFilmstrip(cut.source, sourceDurationSec, cut.in, cut.out)
  }, [cut.source, cut.in, cut.out])
  const thumbWidthPx =
    filmstrip && filmstrip.thumbs.length > 0 ? fullSourcePx / filmstrip.thumbs.length : 0

  const maxOut = Math.max(sourceDurationSec, cut.out)

  function onTrimDown(e: React.PointerEvent, edge: TrimEdge) {
    onSelect()
    // Only this cut's END lands on a new output-timeline position when trimmed
    // (its start is fixed by prior cuts' cumulative duration) — snap whichever
    // edge is being dragged so the resulting duration puts that end on-beat.
    const snappingOnChange = (patch: Partial<WorkingCut>): void => {
      if (!snapEnabled || !beatsSec || beatsSec.length === 0) {
        onChange(patch)
        return
      }
      if (patch.out !== undefined) {
        const candidateEnd = startOffsetSec + (patch.out - cut.in)
        const snappedEnd = snapCandidateToBeat(
          candidateEnd,
          beatsSec,
          true,
          musicOffsetSec,
          musicTrimInSec
        )
        onChange({ out: cut.in + (snappedEnd - startOffsetSec) })
        return
      }
      if (patch.in !== undefined) {
        const candidateEnd = startOffsetSec + (cut.out - patch.in)
        const snappedEnd = snapCandidateToBeat(
          candidateEnd,
          beatsSec,
          true,
          musicOffsetSec,
          musicTrimInSec
        )
        onChange({ in: cut.out - (snappedEnd - startOffsetSec) })
        return
      }
      onChange(patch)
    }
    bindTrimDrag({
      e,
      edge,
      pxPerSec,
      startIn: cut.in,
      startOut: cut.out,
      minIn: 0,
      maxOut,
      onChange: snappingOnChange,
      onDragStart,
      onDragEnd
    })
  }

  return (
    <li
      ref={setNodeRef}
      data-cut-block
      data-cut-id={cut.id}
      style={{ ...style, width: widthPx }}
      className="relative h-full shrink-0 list-none"
      {...attributes}
      {...listeners}
      onClick={onSelect}
    >
      <div
        className={`relative h-full w-full cursor-grab overflow-hidden rounded-[5px] border bg-black active:cursor-grabbing ${
          selected ? 'border-accent' : 'border-border'
        }`}
      >
        <div
          className="pointer-events-none absolute inset-y-0"
          style={{ width: fullSourcePx, left: -cut.in * pxPerSec }}
        >
          {filmstrip ? (
            <div className="absolute inset-0 flex opacity-60">
              {filmstrip.thumbs.map((t, i) =>
                t ? (
                  <img
                    key={i}
                    src={t}
                    alt=""
                    draggable={false}
                    className="h-full shrink-0 object-cover"
                    style={{ width: thumbWidthPx }}
                  />
                ) : (
                  <div
                    key={i}
                    className="h-full shrink-0 bg-surface"
                    style={{ width: thumbWidthPx }}
                  />
                )
              )}
            </div>
          ) : (
            <div className="absolute inset-0 bg-surface" />
          )}
        </div>
        <span className="absolute bottom-0.5 left-1.5 z-10 text-[13px] font-semibold tabular-nums text-ink [text-shadow:0_1px_2px_rgba(0,0,0,0.8)]">
          {playOrder}
        </span>
        {selected && (
          <>
            <TrimBar edge="left" onTrimDown={onTrimDown} />
            <TrimBar edge="right" onTrimDown={onTrimDown} />
          </>
        )}
      </div>
    </li>
  )
}

const MUSIC_MIN_SEC = 0.3

/** Background-music block on the เพลง track — waveform behind, name + volume
 * on top; drag the block to change offsetSec, drag either edge to trim. */
function MusicBlock({
  music,
  peaks,
  fullDurationSec,
  pxPerSec,
  cutBoundaries = [],
  snapEnabled = false,
  onChange,
  onDraftChange
}: {
  music: EditorMusic
  peaks: number[] | null
  fullDurationSec: number
  pxPerSec: number
  /** Scene boundaries on the output clock — a dragged track snaps so that one
   * of its beats lands on one of these. */
  cutBoundaries?: number[]
  snapEnabled?: boolean
  onChange: (patch: MusicPatch) => void
  /** Fired on every drag move (and null on release) purely for the parent's
   * live audio preview — not persisted, unlike onChange. */
  onDraftChange?: (patch: MusicPatch | null) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [draft, setDraft] = useState<MusicPatch | null>(null)
  const offsetSec = draft?.offsetSec ?? music.offsetSec
  const trimInSec = draft?.trimInSec ?? music.trimInSec
  const trimOut = draft?.trimOutSec ?? music.trimOutSec ?? fullDurationSec
  const blockDurationSec = Math.max(trimOut - trimInSec, MUSIC_MIN_SEC)
  const left = offsetSec * pxPerSec
  const width = Math.max(blockDurationSec * pxPerSec, 24)
  const name = music.path ? (music.path.split(/[\\/]/).pop() ?? 'เพลงประกอบ') : 'เพลงประกอบ'

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !peaks || peaks.length === 0 || fullDurationSec <= 0) return
    const dpr = window.devicePixelRatio || 1
    const h = MUSIC_LANE_PX
    canvas.width = width * dpr
    canvas.height = h * dpr
    const g = canvas.getContext('2d')
    if (!g) return
    g.scale(dpr, dpr)
    g.clearRect(0, 0, width, h)
    const startFrac = trimInSec / fullDurationSec
    const endFrac = trimOut / fullDurationSec
    const i0 = Math.floor(startFrac * peaks.length)
    const i1 = Math.max(i0 + 1, Math.ceil(endFrac * peaks.length))
    const slice = peaks.slice(i0, i1)
    const barW = Math.max(width / Math.max(slice.length, 1), 1)
    g.fillStyle = 'rgba(217, 164, 65, 0.4)'
    slice.forEach((p, i) => {
      const bh = Math.max(p * (h - 6), 1.5)
      g.fillRect(i * barW, (h - bh) / 2, Math.max(barW - 0.5, 0.5), bh)
    })
  }, [peaks, width, fullDurationSec, trimInSec, trimOut])

  const onMoveDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const startX = e.clientX
    const startOffset = music.offsetSec
    let last: MusicPatch = {}
    const onMove = (ev: PointerEvent): void => {
      const deltaSec = (ev.clientX - startX) / pxPerSec
      const raw = Math.max(startOffset + deltaSec, 0)
      // Land a beat on a cut rather than the file's start on a cut — see
      // snapMusicOffsetToCut. Threshold scales with zoom so it stays a ~10px
      // pull at any timeline scale.
      const offsetSec = snapEnabled
        ? snapMusicOffsetToCut(
            raw,
            music.beats ?? null,
            cutBoundaries,
            music.trimInSec,
            Math.max(BEAT_SNAP_THRESHOLD_SEC, 10 / Math.max(pxPerSec, 1))
          )
        : raw
      last = { offsetSec }
      setDraft(last)
      onDraftChange?.(last)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      setDraft(null)
      onDraftChange?.(null)
      if (last.offsetSec !== undefined) onChange(last)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  const onTrimDown = (e: React.PointerEvent, edge: TrimEdge): void => {
    e.stopPropagation()
    e.preventDefault()
    // The track's length comes from decoding the file, which can still be in
    // flight (or have failed). With 0 the right-edge clamp inverts —
    // clamp(x, trimIn + 0.3, 0) returns 0.3 — so one drag committed a track
    // trimmed to 0.3s and re-mixed the whole clip against it.
    if (fullDurationSec <= 0) return
    const startX = e.clientX
    const startTrimIn = music.trimInSec
    const startTrimOut = music.trimOutSec ?? fullDurationSec
    const startOffset = music.offsetSec
    let last: MusicPatch = {}
    const onMove = (ev: PointerEvent): void => {
      const deltaSec = (ev.clientX - startX) / pxPerSec
      if (edge === 'left') {
        const nextIn = clamp(startTrimIn + deltaSec, 0, startTrimOut - MUSIC_MIN_SEC)
        const applied = nextIn - startTrimIn
        last = { trimInSec: nextIn, offsetSec: Math.max(startOffset + applied, 0) }
      } else {
        const nextOut = clamp(startTrimOut + deltaSec, startTrimIn + MUSIC_MIN_SEC, fullDurationSec)
        last = { trimOutSec: nextOut }
      }
      setDraft(last)
      onDraftChange?.(last)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      setDraft(null)
      onDraftChange?.(null)
      if (Object.keys(last).length > 0) onChange(last)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  return (
    <div
      data-cut-block
      className="absolute inset-y-0 flex cursor-grab items-center overflow-hidden rounded-[5px] border border-border bg-surface active:cursor-grabbing"
      style={{ left, width }}
      onPointerDown={onMoveDown}
      title="ลากเพื่อเลื่อนตำแหน่งเพลง"
    >
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-0 h-full w-full"
        style={{ width, height: MUSIC_LANE_PX }}
      />
      <div className="pointer-events-none relative z-10 flex min-w-0 items-center gap-2 pr-3 pl-3 text-[13px] text-ink">
        <span className="truncate">{name}</span>
        <span className="shrink-0 tabular-nums text-muted">
          {Math.round((music.muted ? 0 : music.volume) * 100)}%
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={music.volume}
        data-trim-handle
        onPointerDown={(e) => e.stopPropagation()}
        onChange={(e) => onChange({ volume: Number(e.target.value) })}
        className="relative z-10 h-[3px] w-16 shrink-0 accent-[var(--color-accent)]"
        title="ระดับเสียงเพลง"
      />
      {/* Not offered until the track's length is known — a trim against an
          unknown duration cannot produce a correct range (see onTrimDown). */}
      {fullDurationSec > 0 ? (
        <>
          <button
            type="button"
            data-trim-handle
            onPointerDown={(e) => onTrimDown(e, 'left')}
            title="ลากเพื่อตัดต้นเพลง"
            className="absolute top-0 left-0 z-20 h-full w-[10px] cursor-ew-resize touch-none rounded-l-[5px] bg-accent/60 hover:bg-accent"
          />
          <button
            type="button"
            data-trim-handle
            onPointerDown={(e) => onTrimDown(e, 'right')}
            title="ลากเพื่อตัดท้ายเพลง"
            className="absolute top-0 right-0 z-20 h-full w-[10px] cursor-ew-resize touch-none rounded-r-[5px] bg-accent/60 hover:bg-accent"
          />
        </>
      ) : null}
    </div>
  )
}
