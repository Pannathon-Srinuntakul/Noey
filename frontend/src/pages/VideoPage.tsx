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
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  ClipboardCopy,
  Download,
  Film,
  FileText,
  GripVertical,
  Loader2,
  Mic,
  Pencil,
  Square,
  Trash2,
  Upload,
  X,
  XCircle,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, BASE, storedPathBasename, type DubEditScript, type VideoProjectOut } from '../api'
import { useAuth } from '../auth/AuthContext'
import { formatUserError } from '../errors'
import { ConfirmModal } from '../hud/ConfirmModal'
import { VideoTimelineEditor } from '../hud/VideoTimelineEditor'
import { useNavigateWithDoor } from '../navigation/NavigationContext'

// ── helpers ───────────────────────────────────────────────────────────────────

type VideoStep = 'queued' | 'ingest' | 'transcribe' | 'plan' | 'render' | 'analyze' | 'waiting_vo' | 'plan_dub' | 'done' | 'error'

interface JobStatus {
  progress: number
  step: VideoStep
  message: string
  jobStatus: string
  thinking?: string
}

const STEPS_TALKING_HEAD: { key: VideoStep; label: string }[] = [
  { key: 'ingest', label: 'เตรียมวิดีโอ' },
  { key: 'transcribe', label: 'ถอดเสียง' },
  { key: 'plan', label: 'AI วางแผน' },
  { key: 'render', label: 'สร้างคลิป' },
]

const STEPS_DUB_FIRST: { key: VideoStep; label: string }[] = [
  { key: 'ingest', label: 'เตรียมวิดีโอ' },
  { key: 'analyze', label: 'วาง script' },
  { key: 'render', label: 'ตัดคลิป' },
]

function getSteps(mode: string) {
  return mode === 'dub_first' ? STEPS_DUB_FIRST : STEPS_TALKING_HEAD
}

type DubSegmentWithOutput = DubEditScript['segments'][number] & {
  outputIn: number
  outputOut: number
}

type DubVoiceoverLine = {
  lineId: number
  lineOrder: number
  voiceoverScript: string
  outputIn: number
  outputOut: number
  cuts: DubSegmentWithOutput[]
}

function buildDubSegmentsWithOutput(script: DubEditScript): DubSegmentWithOutput[] {
  let cursor = 0
  return script.segments.map((seg) => {
    const dur = seg.durationSec > 0
      ? seg.durationSec
      : Math.max(0, seg.sourceOut - seg.sourceIn)
    const outputIn = seg.outputIn ?? cursor
    const outputOut = seg.outputOut ?? cursor + dur
    cursor = outputOut
    return { ...seg, outputIn, outputOut }
  })
}

function buildDubVoiceoverLines(segments: DubSegmentWithOutput[]): DubVoiceoverLine[] {
  const byLine = new Map<number, DubSegmentWithOutput[]>()
  for (const seg of segments) {
    const lineId = seg.voiceoverLineId ?? seg.order
    if (!byLine.has(lineId)) {
      byLine.set(lineId, [])
    }
    byLine.get(lineId)!.push(seg)
  }
  const lineIds = [...byLine.keys()].sort((a, b) => a - b)
  return lineIds.map((lineId) => {
    const cuts = byLine.get(lineId)!
    const script = cuts.find((c) => c.voiceoverScript)?.voiceoverScript ?? ''
    return {
      lineId,
      lineOrder: lineId,
      voiceoverScript: script,
      outputIn: cuts[0].outputIn,
      outputOut: cuts[cuts.length - 1].outputOut,
      cuts,
    }
  })
}

function findActiveDubVoiceoverLine(
  lines: DubVoiceoverLine[],
  active: DubSegmentWithOutput | null,
): DubVoiceoverLine | null {
  if (!active) return null
  const lineId = active.voiceoverLineId ?? active.order
  return lines.find((l) => l.lineId === lineId) ?? null
}

function findActiveCutIndex(line: DubVoiceoverLine, active: DubSegmentWithOutput): number {
  const idx = line.cuts.findIndex(
    (c) => c.order === active.order
      || (c.outputIn === active.outputIn && c.outputOut === active.outputOut),
  )
  return idx >= 0 ? idx + 1 : 1
}

function findActiveDubSegment(
  segments: DubSegmentWithOutput[],
  currentTime: number,
): DubSegmentWithOutput | null {
  return segments.find((s) => currentTime >= s.outputIn && currentTime < s.outputOut) ?? null
}

/** Shared glass tone for script hint + full overlay */
const DUB_SCRIPT_GLASS = 'bg-black/70 backdrop-blur-md'
const DUB_SCRIPT_GRADIENT =
  'bg-linear-to-t from-black/95 via-black/75 to-transparent'

function DubScriptHintPanel({
  open,
  active,
  activeLine,
  onOpenFull,
  onClose,
}: {
  open: boolean
  active: DubSegmentWithOutput
  activeLine: DubVoiceoverLine | null
  onOpenFull: () => void
  onClose: () => void
}) {
  const [render, setRender] = useState(open)
  const [entered, setEntered] = useState(false)

  useEffect(() => {
    if (open) {
      setRender(true)
      const id = requestAnimationFrame(() => {
        requestAnimationFrame(() => setEntered(true))
      })
      return () => cancelAnimationFrame(id)
    }
    setEntered(false)
    const timer = window.setTimeout(() => setRender(false), 300)
    return () => clearTimeout(timer)
  }, [open])

  if (!render) return null

  const lineOrder = activeLine?.lineOrder ?? active.voiceoverLineId ?? active.order
  const lineIn = activeLine?.outputIn ?? active.outputIn
  const lineOut = activeLine?.outputOut ?? active.outputOut
  const cutIdx = activeLine ? findActiveCutIndex(activeLine, active) : 1
  const montage = (activeLine?.cuts.length ?? 1) > 1
  const meta = montage
    ? `บรรทัด ${lineOrder} · มุม ${cutIdx}/${activeLine!.cuts.length} · ${lineIn.toFixed(1)}s – ${lineOut.toFixed(1)}s`
    : `บรรทัด ${lineOrder} · ${lineIn.toFixed(1)}s – ${lineOut.toFixed(1)}s`

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[5]">
      <div
        className={`pointer-events-auto relative transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] ${
          entered ? 'translate-y-0 opacity-100' : 'translate-y-6 opacity-0'
        }`}
      >
        <button
          type="button"
          onClick={onOpenFull}
          className={`w-full ${DUB_SCRIPT_GRADIENT} px-3 pb-3 pt-10 text-left`}
        >
          <p className="mb-1 text-[10px] font-semibold text-amber-300">{meta}</p>
          <p className="line-clamp-3 text-sm leading-snug text-white">
            {activeLine?.voiceoverScript || active.voiceoverScript}
          </p>
          <p className="mt-1.5 text-[10px] font-medium text-amber-200/80">แตะเพื่อดู script ทั้งหมด</p>
        </button>
        <button
          type="button"
          onClick={onClose}
          className={`absolute right-2 top-2 rounded-full p-1 text-white/70 ${DUB_SCRIPT_GLASS} hover:text-white`}
          aria-label="ซ่อน script"
        >
          <ChevronDown size={14} />
        </button>
      </div>
    </div>
  )
}

function DubScriptVoiceoverLineList({
  lines,
  activeLineOrder = null,
  activeCutIndex = null,
  onLineClick,
  registerRef,
}: {
  lines: DubVoiceoverLine[]
  activeLineOrder?: number | null
  activeCutIndex?: number | null
  onLineClick?: (outputIn: number) => void
  registerRef?: (lineOrder: number, el: HTMLElement | null) => void
}) {
  return (
    <>
      {lines.map((line) => {
        const isActive = activeLineOrder === line.lineOrder
        const montage = line.cuts.length > 1
        const inner = (
          <>
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-amber-600 text-[10px] font-bold text-white">
                {line.lineOrder}
              </span>
              <span className="rounded bg-stone-900 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-white">
                {line.outputIn.toFixed(1)}s – {line.outputOut.toFixed(1)}s
              </span>
              {montage && (
                <span className="rounded bg-purple-100 px-1.5 py-0.5 text-[10px] font-medium text-purple-800">
                  {line.cuts.length} มุม
                </span>
              )}
              {isActive && montage && activeCutIndex != null && (
                <span className="text-[10px] font-medium text-amber-700">
                  กำลังเล่นมุม {activeCutIndex}
                </span>
              )}
            </div>
            <p className="text-[13px] leading-relaxed text-stone-900">{line.voiceoverScript}</p>
          </>
        )
        const className = `mb-2 w-full rounded-md border px-3 py-2.5 text-left shadow-sm last:mb-0 ${
          isActive
            ? 'border-amber-500 bg-amber-50 ring-1 ring-amber-400/40'
            : 'border-stone-200 bg-white'
        } ${onLineClick ? 'cursor-pointer hover:border-stone-300 hover:bg-stone-50' : ''}`

        if (onLineClick) {
          return (
            <button
              key={line.lineId}
              type="button"
              ref={(el) => registerRef?.(line.lineOrder, el)}
              onClick={() => onLineClick(line.outputIn)}
              className={className}
            >
              {inner}
            </button>
          )
        }
        return (
          <div
            key={line.lineId}
            ref={(el) => registerRef?.(line.lineOrder, el)}
            className={className}
          >
            {inner}
          </div>
        )
      })}
    </>
  )
}

function DubScriptVideoOverlay({
  open,
  lines,
  activeLineOrder,
  activeCutIndex,
  onClose,
  onLineClick,
  registerRef,
}: {
  open: boolean
  lines: DubVoiceoverLine[]
  activeLineOrder: number | null
  activeCutIndex: number | null
  onClose: () => void
  onLineClick: (outputIn: number) => void
  registerRef: (lineOrder: number, el: HTMLElement | null) => void
}) {
  const [render, setRender] = useState(open)
  const [entered, setEntered] = useState(false)
  const totalSec = lines.at(-1)?.outputOut ?? 0
  const cutCount = lines.reduce((n, l) => n + l.cuts.length, 0)

  useEffect(() => {
    if (open) {
      setRender(true)
      const id = requestAnimationFrame(() => {
        requestAnimationFrame(() => setEntered(true))
      })
      return () => cancelAnimationFrame(id)
    }
    setEntered(false)
    const timer = window.setTimeout(() => setRender(false), 320)
    return () => clearTimeout(timer)
  }, [open])

  if (!render) return null

  return (
    <div className="absolute inset-0 z-10 flex flex-col justify-end overflow-hidden">
      <button
        type="button"
        aria-label="ปิด script overlay"
        onClick={onClose}
        className={`absolute inset-0 ${DUB_SCRIPT_GLASS} transition-opacity duration-300 ease-out ${
          entered ? 'opacity-100' : 'opacity-0'
        }`}
      />
      <div
        className={`relative flex max-h-[92%] flex-col border-t border-white/10 ${DUB_SCRIPT_GLASS} shadow-[0_-12px_40px_rgba(0,0,0,0.45)] transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] ${
          entered ? 'translate-y-0' : 'translate-y-full'
        }`}
        role="dialog"
        aria-modal="true"
        aria-label="Script ทั้งหมด"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-white/15 px-3 py-2.5">
          <div>
            <p className="text-xs font-semibold text-white drop-shadow-sm">Script ทั้งหมด</p>
            <p className="text-[10px] text-white/70">
              {lines.length} บรรทัด · {cutCount} มุม · ~{Math.round(totalSec)} วิ · แตะเพื่อ jump
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-white/80 hover:bg-white/15 hover:text-white"
            aria-label="ปิด"
          >
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2 scroll-ghost">
          <DubScriptVoiceoverLineList
            lines={lines}
            activeLineOrder={activeLineOrder}
            activeCutIndex={activeCutIndex}
            onLineClick={onLineClick}
            registerRef={registerRef}
          />
        </div>
      </div>
    </div>
  )
}

/** Dub First sidebar typography — label (sm) > input (sm/xs) ≈ tab/placeholder (xs) */
const DUB_LABEL = 'text-sm font-semibold text-purple-100/90'
const DUB_TEXTAREA =
  'w-full resize-none rounded-lg border border-purple-400/35 bg-black/30 px-3 py-2.5 text-sm leading-relaxed text-zinc-100 outline-none focus:border-purple-300/70 focus:ring-1 focus:ring-purple-400/30 placeholder:text-xs placeholder:leading-relaxed placeholder:text-purple-200/55'
const DUB_INPUT =
  'w-full rounded-lg border border-purple-400/35 bg-black/30 px-3 py-2 text-xs text-zinc-100 outline-none focus:border-purple-300/70 focus:ring-1 focus:ring-purple-400/30 placeholder:text-xs placeholder:text-purple-200/50'
const DUB_SCRIPT_STYLES = [
  { value: 'review', label: 'รีวิวสินค้า', emoji: '📦' },
  { value: 'funny', label: 'ตลก / สนุก', emoji: '😄' },
  { value: 'informative', label: 'ให้ข้อมูล', emoji: '📊' },
  { value: 'story', label: 'เล่าเรื่อง', emoji: '🎭' },
] as const

const DUB_SCRIPT_STYLE_LABELS: Record<string, string> = Object.fromEntries(
  DUB_SCRIPT_STYLES.map(({ value, label }) => [value, label]),
)

const DUB_HINT = 'text-xs leading-relaxed text-amber-200/65'
const DUB_CHIP_ACTIVE = 'bg-purple-500 text-white'
const DUB_CHIP_INACTIVE =
  'border border-purple-400/35 text-purple-100/90 hover:border-purple-300/55 hover:text-white'
const DUB_NUMBER_INPUT = `${DUB_INPUT} [appearance:textfield] [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`

function stepIndex(step: VideoStep, mode: string): number {
  if (step === 'queued') return -1
  const steps = getSteps(mode)
  if (step === 'done' || step === 'error') return steps.length
  // waiting_vo is between analyze (idx 1) and plan_dub (idx 2)
  if (step === 'waiting_vo') return 2
  const idx = steps.findIndex((s) => s.key === step)
  return idx >= 0 ? idx : 0
}

function fallbackMessage(progress: number, mode = 'talking_head'): string {
  if (mode === 'dub_first') {
    if (progress < 55) return 'กำลังเตรียมวิดีโอ…'
    if (progress < 70) return 'AI กำลังวาง script…'
    if (progress < 82) return 'Claude กำลัง match ซีน…'
    if (progress < 100) return 'กำลังตัดคลิป silent…'
    return 'เสร็จแล้ว'
  }
  if (progress < 55) return 'กำลังเตรียมวิดีโอ…'
  if (progress < 42) return 'กำลังถอดเสียง…'
  if (progress < 60) return 'AI กำลังดูวิดีโอ…'
  if (progress < 82) return 'กำลังประกอบไทม์ไลน์…'
  if (progress < 100) return 'กำลังสร้างคลิปสำเร็จรูป…'
  return 'เสร็จแล้ว'
}

function parseJobStatus(job: {
  status: string
  progress: number
  result: Record<string, unknown> | null
  error?: string | null
}): JobStatus {
  const step = (job.result?.step as VideoStep | undefined) ?? (job.status === 'error' ? 'error' : 'queued')
  const rawMessage =
    (typeof job.result?.message === 'string' ? job.result.message : null) ??
    (typeof job.error === 'string' && job.error.trim() ? job.error : null) ??
    fallbackMessage(job.progress)
  const message = (step === 'error' || job.status === 'error') ? formatUserError(rawMessage) : rawMessage
  const thinking = typeof job.result?.thinking === 'string' ? job.result.thinking : undefined
  return { progress: job.progress, step, message, jobStatus: job.status, thinking }
}

function statusLabel(s: VideoProjectOut['status']) {
  return {
    pending: 'รอเริ่ม',
    processing: 'กำลังทำ',
    waiting_vo: 'รอ Voiceover',
    done: 'เสร็จแล้ว',
    error: 'ผิดพลาด',
    cancelled: 'ยกเลิกแล้ว',
  }[s] ?? s
}

function statusColor(s: VideoProjectOut['status']) {
  return {
    pending: 'text-amber-600',
    processing: 'text-blue-600',
    waiting_vo: 'text-purple-600',
    done: 'text-green-700',
    error: 'text-red-600',
    cancelled: 'text-zinc-500',
  }[s] ?? ''
}

function isActiveProject(s: VideoProjectOut['status']) {
  return s === 'processing' || s === 'pending'
}

function durationModeLabel(project: VideoProjectOut): string {
  if (project.mode === 'dub_first') return 'Dub First · วิเคราะห์ซีน + รอ voiceover'
  const clipPrefix = project.clip_count > 1 ? `${project.clip_count} คลิป · รวมเป็นคลิปเดียว · ` : ''
  switch (project.duration_mode ?? 'full') {
    case 'custom':
      return project.target_duration_sec != null
        ? `${clipPrefix}Haiku เลือก highlight · ~${project.target_duration_sec} วิ`
        : `${clipPrefix}Haiku เลือก highlight`
    default:
      return `${clipPrefix}เก็บทั้งหมด · ตัดช่วงเงียบ`
  }
}

interface UploadFileItem {
  id: string
  file: File
}

function createUploadItem(file: File): UploadFileItem {
  return { id: crypto.randomUUID(), file }
}

function clipOrderLabel(index: number, total: number): string {
  if (total <= 1) return 'คลิปเดียว'
  if (index === 0) return `คลิป ${index + 1} · เปิด`
  if (index === total - 1) return `คลิป ${index + 1} · ปิด`
  return `คลิป ${index + 1}`
}

function moveUploadItem(items: UploadFileItem[], from: number, to: number): UploadFileItem[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) {
    return items
  }
  const next = [...items]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

function UploadFileThumbnail({ file }: { file: File }) {
  const [thumb, setThumb] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    const objectUrl = URL.createObjectURL(file)
    const video = document.createElement('video')
    video.preload = 'auto'
    video.muted = true
    video.playsInline = true
    video.src = objectUrl

    const captureFrame = () => {
      if (cancelled) return
      const w = video.videoWidth
      const h = video.videoHeight
      if (!w || !h) {
        setFailed(true)
        return
      }
      const canvas = document.createElement('canvas')
      const maxH = 112
      const scale = maxH / h
      canvas.width = Math.max(1, Math.round(w * scale))
      canvas.height = maxH
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        setFailed(true)
        return
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      setThumb(canvas.toDataURL('image/jpeg', 0.72))
    }

    const seekToPreview = () => {
      if (cancelled) return
      const t = Number.isFinite(video.duration) && video.duration > 0
        ? Math.min(0.25, video.duration * 0.05)
        : 0
      if (t === 0) {
        captureFrame()
        return
      }
      video.currentTime = t
    }

    video.addEventListener('loadeddata', seekToPreview, { once: true })
    video.addEventListener('seeked', captureFrame, { once: true })
    video.addEventListener('error', () => {
      if (!cancelled) setFailed(true)
    }, { once: true })

    return () => {
      cancelled = true
      video.src = ''
      video.load()
      URL.revokeObjectURL(objectUrl)
    }
  }, [file])

  return (
    <div className="relative h-14 w-10 shrink-0 overflow-hidden rounded-md border border-white/10 bg-black/60">
      {!thumb && !failed && (
        <div className="flex h-full items-center justify-center">
          <Loader2 size={12} className="animate-spin text-amber-400/45" />
        </div>
      )}
      {failed && (
        <div className="flex h-full items-center justify-center">
          <Film size={12} className="text-amber-400/35" />
        </div>
      )}
      {thumb && (
        <img src={thumb} alt="" className="h-full w-full object-cover" />
      )}
    </div>
  )
}

// ── components ────────────────────────────────────────────────────────────────

function StepBar({ job, mode }: { job: JobStatus; mode: string }) {
  const active = stepIndex(job.step, mode)
  const steps = getSteps(mode)
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {steps.map((s, i) => (
        <div key={s.key} className="flex items-center gap-2">
          <div
            className={`flex h-6 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-all ${
              i < active
                ? 'bg-green-100 text-green-700'
                : i === active
                  ? 'bg-amber-100 text-amber-800 ring-1 ring-amber-400'
                  : 'bg-zinc-100 text-zinc-400'
            }`}
          >
            {i < active ? (
              <CheckCircle2 size={12} />
            ) : i === active ? (
              <Loader2 size={12} className="animate-spin" />
            ) : null}
            {s.label}
          </div>
          {i < steps.length - 1 && (
            <div className={`h-px w-4 ${i < active ? 'bg-green-400' : 'bg-zinc-200'}`} />
          )}
        </div>
      ))}
    </div>
  )
}

function SortableUploadFileRow({
  item,
  index,
  total,
  sortable,
  onMoveUp,
  onMoveDown,
  onRemove,
}: {
  item: UploadFileItem
  index: number
  total: number
  sortable: boolean
  onMoveUp: () => void
  onMoveDown: () => void
  onRemove: () => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id, disabled: !sortable })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.55 : 1,
  }

  return (
    <li
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-2.5 py-2.5 text-sm"
    >
      {sortable ? (
        <button
          type="button"
          className="cursor-grab touch-none text-white/30 hover:text-amber-300 active:cursor-grabbing"
          title="ลากเพื่อเรียงลำดับ"
          {...attributes}
          {...listeners}
        >
          <GripVertical size={14} />
        </button>
      ) : (
        <span className="w-3.5" />
      )}

      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-500/20 text-xs font-bold text-amber-200">
        {index + 1}
      </span>

      <UploadFileThumbnail file={item.file} />

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-amber-100/90">{item.file.name}</p>
        {total > 1 && (
          <p className="mt-0.5 text-[11px] text-amber-300/45">{clipOrderLabel(index, total)}</p>
        )}
      </div>

      {sortable && (
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={onMoveUp}
            disabled={index === 0}
            title="เลื่อนขึ้น"
            className="rounded p-1 text-white/30 hover:text-amber-200 disabled:opacity-25"
          >
            <ChevronUp size={14} />
          </button>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={index === total - 1}
            title="เลื่อนลง"
            className="rounded p-1 text-white/30 hover:text-amber-200 disabled:opacity-25"
          >
            <ChevronDown size={14} />
          </button>
        </div>
      )}

      <button
        type="button"
        onClick={onRemove}
        title="ลบออกจากรายการ"
        className="shrink-0 rounded p-1 text-white/30 hover:text-red-400"
      >
        ×
      </button>
    </li>
  )
}

function VideoPreview({ uid, mediaRevision }: { uid: string; mediaRevision: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [src, setSrc] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setVisible(true)
      },
      { rootMargin: '120px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    let cleanup = () => {}

    void (async () => {
      setLoading(true)
      setError(false)
      try {
        const resolved = await api.videos.resolvePreviewSrc(uid, mediaRevision)
        if (cancelled) {
          resolved.cleanup()
          return
        }
        cleanup = resolved.cleanup
        setSrc(resolved.src)
      } catch {
        if (!cancelled) setError(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
      cleanup()
    }
  }, [uid, visible, mediaRevision])

  return (
    <div ref={containerRef} className="mt-3 w-full">
      <div className="overflow-hidden rounded-xl border-2 border-[#5b3a1a]/25 bg-zinc-950 shadow-[0_8px_28px_rgba(91,58,26,0.18)] ring-1 ring-amber-500/15">
        <div className="aspect-[9/16] w-full">
          {!visible || loading ? (
            <div className="flex h-full min-h-48 flex-col items-center justify-center gap-2 bg-linear-to-b from-zinc-900 to-black text-amber-100/40">
              <Film size={22} className="opacity-40" />
              <Loader2 size={16} className="animate-spin text-amber-500/70" />
            </div>
          ) : error || !src ? (
            <div className="flex h-full min-h-48 items-center justify-center px-3 text-center text-[11px] text-amber-100/35">
              โหลด preview ไม่ได้
            </div>
          ) : (
            <video
              src={src}
              controls
              playsInline
              preload="metadata"
              className="h-full w-full bg-black object-contain"
            />
          )}
        </div>
      </div>
    </div>
  )
}

function DubMediaTabBar({
  tab,
  onChange,
}: {
  tab: 'video' | 'script'
  onChange: (tab: 'video' | 'script') => void
}) {
  return (
    <div className="absolute inset-x-0 top-0 z-30 p-2">
      <div className="flex gap-1 rounded-lg bg-black/40 p-1 backdrop-blur-md">
        <button
          type="button"
          onClick={() => onChange('video')}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium transition-all ${
            tab === 'video'
              ? 'bg-white/25 text-white shadow-sm'
              : 'text-white/65 hover:bg-white/10 hover:text-white'
          }`}
        >
          <Film size={11} /> คลิป
        </button>
        <button
          type="button"
          onClick={() => onChange('script')}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium transition-all ${
            tab === 'script'
              ? 'bg-white/25 text-white shadow-sm'
              : 'text-white/65 hover:bg-white/10 hover:text-white'
          }`}
        >
          <FileText size={11} /> Script
        </button>
      </div>
    </div>
  )
}

const DUB_MEDIA_FRAME =
  'overflow-hidden rounded-xl border-2 border-[#5b3a1a]/25 bg-zinc-950 shadow-[0_8px_28px_rgba(91,58,26,0.18)] ring-1 ring-amber-500/15'

function DubDoneMedia({
  uid,
  mediaRevision,
  tab,
  onTabChange,
}: {
  uid: string
  mediaRevision: string
  tab: 'video' | 'script'
  onTabChange: (tab: 'video' | 'script') => void
}) {
  return (
    <div className="mt-3 w-full">
      <div className={DUB_MEDIA_FRAME}>
        <div className="relative aspect-[9/16] w-full">
          <DubMediaTabBar tab={tab} onChange={onTabChange} />
          {tab === 'video' ? (
            <DubVideoPlayer uid={uid} mediaRevision={mediaRevision} />
          ) : (
            <div className="absolute inset-0 flex flex-col bg-[#fffdf7] pt-11">
              <ScriptTab uid={uid} fillHeight embedded mediaRevision={mediaRevision} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function DubVideoPlayer({ uid, mediaRevision }: { uid: string; mediaRevision: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const segmentRefs = useRef<Map<number, HTMLElement>>(new Map())
  const [visible, setVisible] = useState(false)
  const [src, setSrc] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [script, setScript] = useState<DubEditScript | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [scriptOverlayOpen, setScriptOverlayOpen] = useState(false)
  const [hintExpanded, setHintExpanded] = useState(false)
  const wasPlayingBeforeOverlayRef = useRef(false)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setVisible(true)
      },
      { rootMargin: '120px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    let cleanup = () => {}

    void (async () => {
      setLoading(true)
      setError(false)
      try {
        const [resolved, editScript] = await Promise.all([
          api.videos.resolvePreviewSrc(uid, mediaRevision),
          api.videos.getEditScript(uid),
        ])
        if (cancelled) {
          resolved.cleanup()
          return
        }
        cleanup = resolved.cleanup
        setSrc(resolved.src)
        setScript(editScript)
      } catch {
        if (!cancelled) setError(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
      cleanup()
    }
  }, [uid, visible, mediaRevision])

  const segments = script ? buildDubSegmentsWithOutput(script) : []
  const voiceoverLines = buildDubVoiceoverLines(segments)
  const active = findActiveDubSegment(segments, currentTime)
  const activeLine = findActiveDubVoiceoverLine(voiceoverLines, active)
  const activeCutIndex = active && activeLine ? findActiveCutIndex(activeLine, active) : null

  useEffect(() => {
    if (!scriptOverlayOpen || !activeLine) return
    const el = segmentRefs.current.get(activeLine.lineOrder)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [scriptOverlayOpen, activeLine?.lineOrder])

  function openScriptOverlay() {
    const video = videoRef.current
    wasPlayingBeforeOverlayRef.current = video ? !video.paused : false
    video?.pause()
    setHintExpanded(false)
    setScriptOverlayOpen(true)
  }

  function closeScriptOverlay() {
    setScriptOverlayOpen(false)
    const video = videoRef.current
    if (!video || !wasPlayingBeforeOverlayRef.current) return
    window.setTimeout(() => {
      void video.play()
    }, 280)
  }

  function toggleHint() {
    setHintExpanded((prev) => !prev)
  }

  function seekTo(outputIn: number) {
    const video = videoRef.current
    if (!video) return
    video.currentTime = outputIn + 0.02
    setScriptOverlayOpen(false)
    window.setTimeout(() => {
      void video.play()
    }, 280)
  }

  return (
    <div ref={containerRef} className="absolute inset-0">
      {!visible || loading ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 bg-linear-to-b from-zinc-900 to-black text-amber-100/40">
          <Film size={22} className="opacity-40" />
          <Loader2 size={16} className="animate-spin text-amber-500/70" />
        </div>
      ) : error || !src ? (
        <div className="flex h-full items-center justify-center px-3 text-center text-[11px] text-amber-100/35">
          โหลด preview ไม่ได้
        </div>
      ) : (
        <>
          <video
            ref={videoRef}
            src={src}
            controls
            playsInline
            preload="metadata"
            className="h-full w-full bg-black object-contain"
            onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
            onSeeked={(e) => setCurrentTime(e.currentTarget.currentTime)}
          />
          <DubScriptVideoOverlay
            open={scriptOverlayOpen}
            lines={voiceoverLines}
            activeLineOrder={activeLine?.lineOrder ?? null}
            activeCutIndex={activeCutIndex}
            onClose={closeScriptOverlay}
            onLineClick={seekTo}
            registerRef={(lineOrder, el) => {
              if (el) segmentRefs.current.set(lineOrder, el)
              else segmentRefs.current.delete(lineOrder)
            }}
          />
          {!scriptOverlayOpen && segments.length > 0 && !hintExpanded && (
            <button
              type="button"
              onClick={() => (active ? toggleHint() : openScriptOverlay())}
              className={`absolute bottom-12 right-2 z-[5] flex items-center gap-1.5 rounded-full border border-white/10 px-3 py-1.5 text-[11px] font-medium text-white shadow-lg ${DUB_SCRIPT_GLASS} hover:bg-black/80`}
            >
              <FileText size={12} />
              {activeLine ? `บรรทัด ${activeLine.lineOrder}` : `Script ${voiceoverLines.length}`}
            </button>
          )}
          {!scriptOverlayOpen && active && (
            <DubScriptHintPanel
              open={hintExpanded}
              active={active}
              activeLine={activeLine}
              onOpenFull={openScriptOverlay}
              onClose={() => setHintExpanded(false)}
            />
          )}
        </>
      )}
    </div>
  )
}

function ScriptTab({
  uid,
  fillHeight = false,
  embedded = false,
  mediaRevision,
  activeOrder = null,
  onSegmentClick,
}: {
  uid: string
  fillHeight?: boolean
  embedded?: boolean
  mediaRevision?: string
  activeOrder?: number | null
  onSegmentClick?: (outputIn: number) => void
}) {
  const [script, setScript] = useState<DubEditScript | null>(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setLoading(true)
    api.videos.getEditScript(uid)
      .then(setScript)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [uid, mediaRevision])

  function copyAll() {
    if (!script) return
    const lines = buildDubVoiceoverLines(buildDubSegmentsWithOutput(script))
    const text = lines.map((l) => l.voiceoverScript).join('\n\n')
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  if (loading) return (
    <div className="flex items-center gap-2 py-4 text-xs text-stone-600">
      <Loader2 size={12} className="animate-spin" /> กำลังโหลด script…
    </div>
  )
  if (!script || !script.segments.length) return (
    <p className="py-3 text-xs text-stone-500">ไม่พบ script</p>
  )

  const segmentsWithOutput = buildDubSegmentsWithOutput(script)
  const voiceoverLines = buildDubVoiceoverLines(segmentsWithOutput)
  const activeSeg = activeOrder != null
    ? segmentsWithOutput.find((s) => s.order === activeOrder) ?? null
    : null
  const activeLine = findActiveDubVoiceoverLine(voiceoverLines, activeSeg)
  const activeCutIndex = activeLine && activeSeg ? findActiveCutIndex(activeLine, activeSeg) : null
  const totalSec = script.totalEstimatedSec ?? segmentsWithOutput.at(-1)?.outputOut ?? 0
  const cutCount = segmentsWithOutput.length

  return (
    <div className={`${embedded ? 'flex h-full min-h-0 flex-col px-2 pb-2' : 'mt-2 space-y-2'} ${fillHeight ? 'flex min-h-0 flex-1 flex-col' : ''}`}>
      <div className="flex shrink-0 items-center justify-between">
        <p className="text-[11px] font-semibold text-stone-700">
          {voiceoverLines.length} บรรทัด · {cutCount} มุม · ~{Math.round(totalSec)} วิ
          <span className="ml-1.5 font-normal text-stone-500">(เวลาในคลิป silent)</span>
        </p>
        <button
          type="button"
          onClick={copyAll}
          className="flex items-center gap-1 rounded-lg border border-stone-300 bg-white px-2 py-1 text-[11px] font-medium text-stone-700 hover:bg-stone-50"
        >
          <ClipboardCopy size={11} />
          {copied ? 'copied!' : 'Copy ทั้งหมด'}
        </button>
      </div>
      <div className={`overflow-y-auto rounded-lg border border-stone-200 bg-stone-50 p-2 scroll-ghost ${
        fillHeight ? 'min-h-0 flex-1' : 'max-h-[70vh]'
      }`}
      >
        <DubScriptVoiceoverLineList
          lines={voiceoverLines}
          activeLineOrder={activeLine?.lineOrder ?? null}
          activeCutIndex={activeCutIndex}
          onLineClick={onSegmentClick}
        />
      </div>
    </div>
  )
}

function ProjectCard({
  project,
  job,
  onDownloadFinal,
  onDownloadCapcut,
  onCancel,
  onDelete,
  onVoUploaded,
  onEdit,
  downloading,
  actionUid,
}: {
  project: VideoProjectOut
  job: JobStatus | null
  onDownloadFinal: (project: VideoProjectOut) => void
  onDownloadCapcut: (project: VideoProjectOut) => void
  onCancel: (uid: string) => void
  onDelete: (uid: string) => void
  onVoUploaded: (updated: VideoProjectOut) => void
  onEdit: (uid: string) => void
  downloading: string | null
  actionUid: string | null
}) {
  const date = new Date(project.created_at).toLocaleString('th-TH', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  })
  const active = isActiveProject(project.status)
  const progress = job?.progress ?? 0
  const message = job?.message ?? (active ? 'กำลังเริ่มงาน…' : '')
  const busy = actionUid === project.uid

  const voInputRef = useRef<HTMLInputElement>(null)
  const [voUploading, setVoUploading] = useState(false)
  const [voError, setVoError] = useState<string | null>(null)
  const [doneTab, setDoneTab] = useState<'video' | 'script'>('video')
  const mediaRevision = project.updated_at ?? project.created_at

  const thinkingRef = useRef<HTMLDivElement>(null)
  const thinkingPinnedRef = useRef(true)

  useEffect(() => {
    const el = thinkingRef.current
    if (!el || !thinkingPinnedRef.current) return
    el.scrollTop = el.scrollHeight
  }, [job?.thinking])

  function handleThinkingScroll() {
    const el = thinkingRef.current
    if (!el) return
    thinkingPinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32
  }

  async function handleVoUpload(file: File) {
    setVoUploading(true)
    setVoError(null)
    try {
      const updated = await api.videos.uploadVoiceover(project.uid, file)
      onVoUploaded(updated)
    } catch (e) {
      setVoError(formatUserError(e))
    } finally {
      setVoUploading(false)
      if (voInputRef.current) voInputRef.current.value = ''
    }
  }

  return (
    <div className="rounded-xl border border-[#5b3a1a]/20 bg-[#fffdf7] p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs text-[#5b3a1a]/50">{date}</p>
          <p className="mt-0.5 font-medium text-[#5b3a1a]">
            {project.mode === 'talking_head' ? 'Talking Head Edit' : 'Dub First Edit'}
          </p>
          <p className="mt-0.5 text-[10px] text-[#5b3a1a]/45">
            {durationModeLabel(project)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {project.origin === 'local' && (
            <span
              title="โปรเจกต์นี้ตัดต่อผ่านแอพ desktop — ไฟล์วิดีโออยู่บนเครื่องที่ render"
              className="rounded-full bg-sky-100 px-2.5 py-0.5 text-xs font-semibold text-sky-700"
            >
              🖥️ ตัดต่อบนเครื่อง
            </span>
          )}
          <span className={`rounded-full bg-current/10 px-2.5 py-0.5 text-xs font-semibold ${statusColor(project.status)}`}>
            {statusLabel(project.status)}
          </span>
          <button
            type="button"
            onClick={() => onDelete(project.uid)}
            disabled={busy}
            title="ลบโปรเจกต์"
            className="rounded-lg p-1.5 text-[#5b3a1a]/40 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
          </button>
        </div>
      </div>

      {active && (
        <>
          <p className="mt-3 flex items-center gap-1.5 text-xs text-[#5b3a1a]/80">
            <Loader2 size={12} className="animate-spin shrink-0 text-amber-600" />
            {message}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-zinc-100">
              <div
                className="h-full rounded-full bg-linear-to-r from-amber-400 to-amber-600 transition-all duration-500"
                style={{ width: `${Math.max(progress, 2)}%` }}
              />
            </div>
            <span className="w-9 shrink-0 text-right text-xs font-medium tabular-nums text-[#5b3a1a]/70">
              {progress}%
            </span>
          </div>
          {job && <StepBar job={job} mode={project.mode} />}
          {job?.thinking && (
            <div className="mt-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2">
              <p className="mb-1 text-[10px] font-medium text-zinc-400">Claude กำลังคิด…</p>
              <div
                ref={thinkingRef}
                onScroll={handleThinkingScroll}
                className="scroll-light max-h-80 overflow-y-auto font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-zinc-500"
              >
                {job.thinking}
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={() => onCancel(project.uid)}
            disabled={busy}
            className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-red-300/60 bg-red-50 px-3 py-2 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Square size={12} />}
            หยุดการตัดต่อ
          </button>
        </>
      )}

      {project.status === 'waiting_vo' && project.origin === 'local' && (
        <p className="mt-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2.5 text-xs text-sky-700">
          รออัดเสียงพากย์ — อัปโหลดและ render ต่อผ่านแอพ desktop บนเครื่องที่ใช้ตัดต่อ
        </p>
      )}

      {project.status === 'waiting_vo' && project.origin !== 'local' && (
        <div className="mt-3 space-y-3">
          <div className="rounded-lg border border-purple-200 bg-purple-50 px-3 py-2.5">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-purple-700">
              <CheckCircle2 size={12} />
              AI วิเคราะห์ซีนเสร็จแล้ว
            </p>
            <p className="mt-1 text-[11px] text-purple-600/80">
              อัปโหลดไฟล์เสียงพากย์ (mp3/wav/m4a) เพื่อสร้างคลิปขั้นสุดท้าย
            </p>
            {project.brief && (
              <p className="mt-1.5 rounded border border-purple-200 bg-white/60 px-2 py-1 text-[11px] text-purple-700/70">
                Brief: {project.brief}
              </p>
            )}
          </div>

          <input
            ref={voInputRef}
            type="file"
            accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void handleVoUpload(f)
            }}
          />
          <button
            type="button"
            onClick={() => voInputRef.current?.click()}
            disabled={voUploading}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-purple-600 px-3 py-2.5 text-xs font-semibold text-white shadow hover:bg-purple-700 disabled:opacity-50"
          >
            {voUploading ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Mic size={13} />
            )}
            {voUploading ? 'กำลังอัปโหลด…' : 'อัปโหลด Voiceover'}
          </button>

          {voError && (
            <p className="rounded-lg border border-red-300/60 bg-red-50 px-3 py-2 text-xs text-red-700">
              {voError}
            </p>
          )}
        </div>
      )}

      {project.status === 'cancelled' && (
        <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-zinc-100 px-3 py-2 text-xs text-zinc-600">
          <Square size={13} className="mt-0.5 shrink-0" />
          {formatUserError(project.error_msg ?? 'ยกเลิกโดยผู้ใช้')}
        </p>
      )}

      {project.status === 'error' && project.error_msg && (
        <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
          <XCircle size={13} className="mt-0.5 shrink-0" />
          {formatUserError(project.error_msg)}
        </p>
      )}

      {project.status === 'done' && project.origin === 'local' && (
        <p className="mt-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2.5 text-xs text-sky-700">
          เสร็จแล้ว — ไฟล์วิดีโออยู่บนเครื่องที่ render ผ่านแอพ desktop (server ไม่เก็บไฟล์วิดีโอ)
        </p>
      )}

      {project.status === 'done' && project.origin !== 'local' && (
        <>
          {project.final_path && (
            project.mode === 'dub_first'
              ? (
                <DubDoneMedia
                  uid={project.uid}
                  mediaRevision={mediaRevision}
                  tab={doneTab}
                  onTabChange={setDoneTab}
                />
              )
              : <VideoPreview uid={project.uid} mediaRevision={mediaRevision} />
          )}
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => onDownloadFinal(project)}
              disabled={downloading === project.uid}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#5b3a1a] px-3 py-2 text-xs font-medium text-amber-50 shadow hover:bg-[#4a2e0c] disabled:opacity-50"
            >
              {downloading === project.uid ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Download size={12} />
              )}
              {project.mode === 'dub_first' ? 'ดาวน์โหลด Silent MP4' : 'ดาวน์โหลดคลิปเต็ม'}
            </button>
            <button
              onClick={() => onDownloadCapcut(project)}
              disabled={downloading === project.uid}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-[#5b3a1a]/40 bg-amber-50 px-3 py-2 text-xs font-medium text-[#5b3a1a] hover:bg-amber-100 disabled:opacity-50"
            >
              <Download size={12} />
              {project.mode === 'dub_first' ? 'Bundle + Script (ZIP)' : 'CapCut Bundle (ZIP)'}
            </button>
          </div>
          <button
            onClick={() => onEdit(project.uid)}
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-[#5b3a1a]/30 px-3 py-2 text-xs font-medium text-[#5b3a1a] hover:bg-amber-50"
          >
            <Pencil size={12} />
            แก้ไขวิดีโอ
          </button>
        </>
      )}
    </div>
  )
}

// ── main page ─────────────────────────────────────────────────────────────────

export default function VideoPage() {
  const { navigateWithDoor } = useNavigateWithDoor()
  const { accessToken } = useAuth()
  const inputRef = useRef<HTMLInputElement>(null)

  const [files, setFiles] = useState<UploadFileItem[]>([])
  const [uploadMode, setUploadMode] = useState<'merge' | 'separate'>('merge')

  useEffect(() => {
    if (files.length <= 1) {
      setUploadMode('merge')
    }
  }, [files.length])

  const [videoMode, setVideoMode] = useState<'talking_head' | 'dub_first'>('talking_head')
  const [scriptMode, setScriptMode] = useState<'generate' | 'own'>('generate')
  const [userScript, setUserScript] = useState('')
  const [scriptStyles, setScriptStyles] = useState<string[]>([])
  const [scriptDuration, setScriptDuration] = useState('')  // '15'|'30'|'60'|'90'|'auto'|'custom'|''
  const [scriptCustomSec, setScriptCustomSec] = useState('')
  const [scriptNote, setScriptNote] = useState('')
  const [talkingBrief, setTalkingBrief] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)

  const [projects, setProjects] = useState<VideoProjectOut[]>([])
  const [loadingList, setLoadingList] = useState(true)

  const [jobStatuses, setJobStatuses] = useState<Record<string, JobStatus>>({})
  const [downloading, setDownloading] = useState<string | null>(null)
  const [actionUid, setActionUid] = useState<string | null>(null)
  const [confirmDeleteUid, setConfirmDeleteUid] = useState<string | null>(null)
  const [editingUid, setEditingUid] = useState<string | null>(null)

  const uploadSensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const loadProjects = useCallback(async () => {
    try {
      const list = await api.videos.list()
      setProjects(list)
    } catch (_e) { /* no-op */ }
    finally { setLoadingList(false) }
  }, [])

  useEffect(() => {
    if (!accessToken) return
    void loadProjects()
  }, [accessToken, loadProjects])

  // poll active jobs every 2s
  useEffect(() => {
    const active = projects.filter((p) => isActiveProject(p.status))
    if (active.length === 0) return

    const ids = active.map((p) => p.job_id).filter(Boolean) as string[]

    async function poll() {
      const updates: Record<string, JobStatus> = {}
      let anyDone = false
      for (const jid of ids) {
        try {
          const job = await api.getJob(jid)
          updates[jid] = parseJobStatus(job)
          if (job.status === 'ok' || job.status === 'error') anyDone = true
        } catch (_e) { /* ignore */ }
      }
      setJobStatuses((prev) => ({ ...prev, ...updates }))
      if (anyDone) await loadProjects()
    }

    void poll()
    const timer = setInterval(() => void poll(), 2000)
    return () => clearInterval(timer)
  }, [projects, loadProjects])

  async function handleUpload() {
    if (files.length === 0) return
    const submittedIds = new Set(files.map((f) => f.id))
    setUploading(true)
    setUploadError(null)
    try {
      const buildBrief = (): string | undefined => {
        const parts: string[] = []
        if (scriptStyles.length > 0) {
          const labels = scriptStyles.map((s) => DUB_SCRIPT_STYLE_LABELS[s] ?? s)
          parts.push(`สไตล์: ${labels.join(', ')}`)
        }
        if (scriptDuration === 'auto') parts.push('ความยาว: ให้ Claude ประเมิน')
        else if (scriptDuration === 'custom' && scriptCustomSec) parts.push(`ความยาวเป้าหมาย: ~${scriptCustomSec} วิ`)
        else if (scriptDuration && scriptDuration !== 'custom') parts.push(`ความยาวเป้าหมาย: ~${scriptDuration} วิ`)
        if (scriptNote.trim()) parts.push(scriptNote.trim())
        return parts.join(' · ') || undefined
      }

      const res = await api.videos.upload(
        files.map((item) => item.file),
        {
          mode: videoMode,
          brief: videoMode === 'dub_first' ? buildBrief() : (talkingBrief.trim() || undefined),
          userScript: videoMode === 'dub_first' && scriptMode === 'own' ? (userScript.trim() || undefined) : undefined,
          // Only "full" exists now — talking_head's highlight/custom mode was
          // removed (Gemini reviews every clip regardless). dub_first's own
          // script-length target still travels via targetDurationSec below,
          // independent of this field.
          durationMode: 'full',
          targetDurationSec: videoMode === 'dub_first'
            ? (scriptDuration === 'custom' && scriptCustomSec ? parseInt(scriptCustomSec, 10)
              : scriptDuration && scriptDuration !== 'auto' && scriptDuration !== 'custom' ? parseInt(scriptDuration, 10)
              : null)
            : null,
          uploadMode: files.length > 1 ? uploadMode : 'merge',
        },
      )
      setJobStatuses((prev) => {
        const next = { ...prev }
        for (const item of res.projects) {
          next[item.job_id] = {
            progress: 2,
            step: 'queued',
            message: 'อัปโหลดเสร็จแล้ว รอ worker รับงาน…',
            jobStatus: 'queued',
          }
        }
        return next
      })
      setFiles((prev) => prev.filter((f) => !submittedIds.has(f.id)))
      setUploadMode('merge')
      setTalkingBrief('')
      setScriptMode('generate')
      setUserScript('')
      setScriptStyles([])
      setScriptDuration('')
      setScriptCustomSec('')
      setScriptNote('')
      if (inputRef.current) inputRef.current.value = ''
      // Small delay to ensure DB transaction is visible before fetching project list
      await new Promise((r) => setTimeout(r, 600))
      await loadProjects()
    } catch (e) {
      setUploadError(formatUserError(e))
    } finally {
      setUploading(false)
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    const dropped = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('video/'))
    setFiles((prev) => [...prev, ...dropped.map(createUploadItem)])
  }

  function handleUploadDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return

    setFiles((prev) => {
      const oldIndex = prev.findIndex((item) => item.id === active.id)
      const newIndex = prev.findIndex((item) => item.id === over.id)
      if (oldIndex < 0 || newIndex < 0) return prev
      return moveUploadItem(prev, oldIndex, newIndex)
    })
  }

  function handleVoUploaded(updated: VideoProjectOut) {
    setProjects((prev) => prev.map((p) => (p.uid === updated.uid ? updated : p)))
  }

  async function handleCancel(uid: string) {
    setActionUid(uid)
    try {
      await api.videos.cancel(uid)
      await loadProjects()
    } catch (e) {
      alert(formatUserError(e))
    } finally {
      setActionUid(null)
    }
  }

  async function doDelete(uid: string) {
    setConfirmDeleteUid(null)
    setActionUid(uid)
    try {
      await api.videos.delete(uid)
      setProjects((prev) => prev.filter((p) => p.uid !== uid))
    } catch (e) {
      alert(formatUserError(e))
    } finally {
      setActionUid(null)
    }
  }

  async function handleDownloadFinal(project: VideoProjectOut) {
    setDownloading(project.uid)
    const filename = storedPathBasename(project.final_path) ?? 'final.mp4'
    try { await api.videos.downloadFinal(project.uid, filename) } catch (e) { alert(formatUserError(e)) }
    finally { setDownloading(null) }
  }

  async function handleDownloadCapcut(project: VideoProjectOut) {
    setDownloading(project.uid)
    const filename = storedPathBasename(project.zip_path) ?? `capcut_bundle_${project.uid.slice(0, 8)}.zip`
    try { await api.videos.exportCapcut(project.uid, filename) } catch (e) { alert(formatUserError(e)) }
    finally { setDownloading(null) }
  }

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden"
      style={{ background: 'linear-gradient(160deg, #1a0e06 0%, #0d1a14 100%)' }}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-white/10 px-4 py-3 sm:px-6 sm:py-4">
        <button
          onClick={() => navigateWithDoor('/')}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-amber-200/80 hover:bg-white/10 hover:text-amber-200"
        >
          <ChevronLeft size={16} /> กลับ
        </button>
        <div className="h-5 w-px bg-white/20" />
        <Film size={18} className="text-amber-400" />
        <h1 className="font-bold tracking-wide text-amber-100">AI Video Editor</h1>
        <span className="ml-1 rounded-full border border-amber-500/40 px-2 py-0.5 text-[10px] font-semibold text-amber-400">
          MVP · talking_head + dub_first
        </span>
        <a
          href={`${BASE}/releases/desktop/windows`}
          className="ml-auto flex items-center gap-1.5 rounded-lg border border-amber-500/40 px-3 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-500/10"
        >
          <Download size={13} /> ดาวน์โหลดแอป (Windows)
        </a>
      </header>

      <div className="scroll-ghost flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 lg:flex-row lg:gap-6 lg:overflow-hidden lg:p-6">
        <div className="flex w-full shrink-0 flex-col lg:min-h-0 lg:w-96 lg:overflow-hidden">
          <h2 className="mb-1 shrink-0 text-sm font-semibold text-amber-200/70 uppercase tracking-widest">
            อัปโหลดวิดีโอ
          </h2>
          <p className="mb-3 shrink-0 text-[11px] text-amber-200/45">
            {videoMode === 'dub_first'
              ? 'คลิปต้นฉบับสูงสุด 20 นาทีต่อไฟล์ · รวมทุกไฟล์ไม่เกิน 20 นาที'
              : 'รวมทุกไฟล์ในโปรเจกต์ไม่เกิน 2 ชั่วโมง'}
          </p>

          <div className="scroll-ghost pr-1 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
            <div className="flex flex-col gap-4 pb-2">
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            className={`rounded-2xl border-2 border-dashed border-amber-500/30 bg-amber-500/5 transition hover:border-amber-400/50 hover:bg-amber-500/10 ${
              files.length > 0 ? 'p-3' : 'flex flex-col items-center justify-center gap-3 p-8 text-center'
            }`}
          >
            <input
              ref={inputRef}
              type="file"
              multiple
              accept="video/*"
              className="hidden"
              onChange={(e) => {
                console.log('[VideoPage] file input onChange fired', e.target.files?.length)
                if (e.target.files) {
                  const newFiles = Array.from(e.target.files!).map(createUploadItem)
                  console.log('[VideoPage] adding files to state', newFiles.length)
                  setFiles((prev) => {
                    console.log('[VideoPage] prev files', prev.length, '→ new total', prev.length + newFiles.length)
                    return [...prev, ...newFiles]
                  })
                  e.target.value = ''
                }
              }}
            />

            {files.length === 0 ? (
              <>
                <Upload size={32} className="text-amber-400/60" />
                <div>
                  <p className="text-sm font-medium text-amber-100/80">ลาก & วางวิดีโอที่นี่</p>
                  <p className="mt-1 text-xs text-amber-300/50">หรือคลิกเพื่อเลือกไฟล์</p>
                </div>
                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  className="rounded-lg border border-amber-500/40 px-4 py-1.5 text-xs text-amber-300 hover:border-amber-400 hover:text-amber-200"
                >
                  เลือกไฟล์
                </button>
              </>
            ) : (
              <div className="w-full space-y-2 text-left">
                <DndContext
                  sensors={uploadSensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleUploadDragEnd}
                >
                  <SortableContext
                    items={files.map((item) => item.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    <ul className="space-y-1.5">
                      {files.map((item, i) => (
                        <SortableUploadFileRow
                          key={item.id}
                          item={item}
                          index={i}
                          total={files.length}
                          sortable={files.length > 1}
                          onMoveUp={() => setFiles((prev) => moveUploadItem(prev, i, i - 1))}
                          onMoveDown={() => setFiles((prev) => moveUploadItem(prev, i, i + 1))}
                          onRemove={() => setFiles((prev) => prev.filter((entry) => entry.id !== item.id))}
                        />
                      ))}
                    </ul>
                  </SortableContext>
                </DndContext>
                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  className="w-full rounded-lg border border-amber-500/40 py-1.5 text-xs text-amber-300 hover:border-amber-400 hover:text-amber-200"
                >
                  เพิ่มไฟล์
                </button>
              </div>
            )}
          </div>

          {/* Mode selector */}
          <div className="rounded-xl border border-white/10 bg-white/5 p-3 space-y-2.5">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-amber-200/55">โหมดตัดต่อ</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setVideoMode('talking_head')}
                className={`flex-1 rounded-lg px-3 py-2.5 text-sm font-semibold transition-all ${
                  videoMode === 'talking_head'
                    ? 'bg-amber-500 text-black shadow'
                    : 'border border-white/15 text-amber-300/70 hover:border-amber-400/40 hover:text-amber-200'
                }`}
              >
                🎙 Talking Head
              </button>
              <button
                type="button"
                onClick={() => setVideoMode('dub_first')}
                className={`flex-1 rounded-lg px-3 py-2.5 text-sm font-semibold transition-all ${
                  videoMode === 'dub_first'
                    ? 'bg-purple-500 text-white shadow'
                    : 'border border-white/15 text-amber-300/70 hover:border-purple-400/40 hover:text-purple-200'
                }`}
              >
                🎬 Dub First
              </button>
            </div>
            {videoMode === 'talking_head' ? (
              <p className="text-xs leading-relaxed text-amber-300/50">ถอดเสียง → AI ตัดช่วงเงียบ → render</p>
            ) : (
              <p className="text-xs leading-relaxed text-purple-200/60">AI วิเคราะห์ซีน → คุณอัดเสียงพากย์ → render</p>
            )}
          </div>

          {files.length > 1 && (
            <div className={`rounded-xl border p-4 space-y-2.5 ${
              videoMode === 'dub_first'
                ? 'border-purple-500/25 bg-purple-500/5'
                : 'border-white/10 bg-white/5'
            }`}
            >
              <p className={`text-[11px] font-semibold uppercase tracking-widest ${
                videoMode === 'dub_first' ? 'text-purple-200/55' : 'text-amber-200/55'
              }`}
              >
                โหมดอัปโหลดหลายคลิป
              </p>
              <label className="flex cursor-pointer items-start gap-2.5">
                <input
                  type="radio"
                  name="uploadMode"
                  checked={uploadMode === 'merge'}
                  onChange={() => setUploadMode('merge')}
                  className={`mt-0.5 ${videoMode === 'dub_first' ? 'accent-purple-400' : 'accent-amber-500'}`}
                />
                <div>
                  <p className={`text-sm font-medium ${videoMode === 'dub_first' ? 'text-purple-100/90' : 'text-amber-100/90'}`}>
                    รวมเป็นคลิปเดียว
                  </p>
                  <p className={`mt-0.5 text-xs leading-relaxed ${videoMode === 'dub_first' ? 'text-purple-300/50' : 'text-amber-300/50'}`}>
                    {videoMode === 'dub_first'
                      ? 'ต่อคลิปตามลำดับ → AI วาง script + ตัด silent MP4 เดียว'
                      : 'ต่อคลิปตามลำดับด้านบน แล้วตัดเป็น final.mp4 เดียว'}
                  </p>
                </div>
              </label>
              <label className="flex cursor-pointer items-start gap-2.5">
                <input
                  type="radio"
                  name="uploadMode"
                  checked={uploadMode === 'separate'}
                  onChange={() => setUploadMode('separate')}
                  className={`mt-0.5 ${videoMode === 'dub_first' ? 'accent-purple-400' : 'accent-amber-500'}`}
                />
                <div>
                  <p className={`text-sm font-medium ${videoMode === 'dub_first' ? 'text-purple-100/90' : 'text-amber-100/90'}`}>
                    ตัดแยกแต่ละคลิป
                  </p>
                  <p className={`mt-0.5 text-xs leading-relaxed ${videoMode === 'dub_first' ? 'text-purple-300/50' : 'text-amber-300/50'}`}>
                    {videoMode === 'dub_first'
                      ? `สร้าง ${files.length} โปรเจกต์ Dub — คลิปละ silent MP4 + script`
                      : `สร้าง ${files.length} โปรเจกต์ — คลิปละ 1 งานตัดต่อ`}
                  </p>
                </div>
              </label>
            </div>
          )}

          {videoMode === 'dub_first' && (
            <div className="rounded-xl border border-purple-500/20 bg-purple-500/5 p-3 space-y-3">
              {/* Mode toggle */}
              <div className="flex gap-1.5 rounded-lg border border-purple-500/20 bg-black/15 p-1">
                <button
                  type="button"
                  onClick={() => setScriptMode('generate')}
                  className={`flex-1 rounded-md py-2 text-xs font-medium transition-all ${
                    scriptMode === 'generate'
                      ? DUB_CHIP_ACTIVE
                      : `${DUB_CHIP_INACTIVE} hover:bg-purple-500/15`
                  }`}
                >
                  ✨ ให้ Claude สร้าง script
                </button>
                <button
                  type="button"
                  onClick={() => setScriptMode('own')}
                  className={`flex-1 rounded-md py-2 text-xs font-medium transition-all ${
                    scriptMode === 'own'
                      ? DUB_CHIP_ACTIVE
                      : `${DUB_CHIP_INACTIVE} hover:bg-purple-500/15`
                  }`}
                >
                  ✏️ ใส่ script เอง
                </button>
              </div>

              {/* Duration target — applies to both modes */}
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-purple-100/90">ความยาววิดีโอที่ต้องการ</p>
                <div className="flex flex-wrap gap-1.5">
                  {([
                    { value: '15', label: '15 วิ' },
                    { value: '30', label: '30 วิ' },
                    { value: '60', label: '60 วิ' },
                    { value: '90', label: '90 วิ' },
                    { value: 'auto', label: 'Claude เลือก' },
                    { value: 'custom', label: 'กำหนดเอง' },
                  ] as const).map(({ value, label }) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setScriptDuration(scriptDuration === value ? '' : value)}
                      className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all ${
                        scriptDuration === value ? DUB_CHIP_ACTIVE : DUB_CHIP_INACTIVE
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {scriptDuration === 'custom' && (
                  <div className="flex items-center gap-2 pt-0.5">
                    <input
                      type="number"
                      min={5}
                      max={600}
                      placeholder="45"
                      value={scriptCustomSec}
                      onChange={(e) => setScriptCustomSec(e.target.value)}
                      className={`w-20 py-1.5 ${DUB_NUMBER_INPUT}`}
                    />
                    <span className="text-xs text-purple-200/85">วินาที (5–600)</span>
                  </div>
                )}
              </div>

              {/* Generate mode: style selector + note */}
              {scriptMode === 'generate' && (
                <div className="space-y-2.5">
                  <div className="space-y-1.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className={DUB_LABEL}>สไตล์ที่ต้องการ</p>
                      <p className="text-[10px] text-purple-200/45">เลือกได้หลายข้อ</p>
                    </div>
                    <div className="grid grid-cols-2 gap-1.5">
                      {DUB_SCRIPT_STYLES.map(({ value, label, emoji }) => {
                        const selected = scriptStyles.includes(value)
                        return (
                        <button
                          key={value}
                          type="button"
                          aria-pressed={selected}
                          onClick={() => {
                            setScriptStyles((prev) =>
                              prev.includes(value)
                                ? prev.filter((s) => s !== value)
                                : [...prev, value],
                            )
                          }}
                          className={`flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-medium transition-all ${
                            selected
                              ? DUB_CHIP_ACTIVE
                              : `${DUB_CHIP_INACTIVE} bg-black/20 hover:bg-purple-500/10`
                          }`}
                        >
                          <span>{emoji}</span> {label}
                        </button>
                        )
                      })}
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <p className={DUB_LABEL}>รายละเอียดสินค้า / คำสั่งเพิ่มเติม</p>
                    <textarea
                      value={scriptNote}
                      onChange={(e) => setScriptNote(e.target.value)}
                      rows={5}
                      placeholder={
                        'เช่น เน้นจุดเด่นเรื่องกลิ่น · เริ่ม hook แรง · ปิด CTA ลิงก์ในไบโอ\n' +
                        'หรือบอกสิ่งที่อยากได้เพิ่มจาก Claude'
                      }
                      className={DUB_TEXTAREA}
                    />
                  </div>
                  {scriptStyles.length === 0 && (
                    <p className={DUB_HINT}>
                      ⚠ เลือกสไตล์เพื่อให้ Claude สร้าง script ได้ตรงมากขึ้น
                    </p>
                  )}
                </div>
              )}

              {/* Own script mode: textarea + note */}
              {scriptMode === 'own' && (
                <div className="space-y-2.5">
                  <div className="space-y-1.5">
                    <p className={DUB_LABEL}>Script ที่จะพูด</p>
                    <textarea
                      value={userScript}
                      onChange={(e) => setUserScript(e.target.value)}
                      rows={5}
                      placeholder="Claude จะเลือกซีนวิดีโอให้ตรงกับแต่ละบรรทัด"
                      className={DUB_TEXTAREA}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-purple-100/85">Note สำหรับ Claude (ไม่บังคับ)</p>
                    <input
                      type="text"
                      value={scriptNote}
                      onChange={(e) => setScriptNote(e.target.value)}
                      placeholder="เช่น ซีนสุดท้ายต้องเป็น CTA"
                      className={DUB_INPUT}
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {videoMode !== 'dub_first' && <div className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-3">
            <div>
              <p className="text-sm font-medium text-amber-100/90">ตัดช่วงเงียบ + ลบคำพูดซ้ำ</p>
              <p className="text-xs leading-relaxed text-amber-300/50">
                AI ดูวิดีโอทุกคลิปให้ — แก้คำที่ถอดเสียงผิด ตัดพูดติด/พูดซ้ำ และเก็บช่วงเงียบที่ยังมีภาพสำคัญไว้
              </p>
            </div>
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-amber-100/85">บริบท/ชื่อสินค้า (ไม่บังคับ)</p>
              <input
                type="text"
                value={talkingBrief}
                onChange={(e) => setTalkingBrief(e.target.value)}
                placeholder="เช่น รีวิวรองเท้ายี่ห้อ X — ช่วย AI สะกดชื่อแบรนด์ให้ถูก"
                className="w-full rounded-lg border border-amber-500/30 bg-black/20 px-3 py-2 text-xs text-zinc-100 outline-none focus:border-amber-400"
              />
            </div>
          </div>}

          {uploadError && (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-300">
              {uploadError}
            </p>
          )}

          <button
            onClick={handleUpload}
            disabled={files.length === 0 || uploading}
            className="flex items-center justify-center gap-2 rounded-xl bg-amber-500 py-3 text-sm font-bold text-black shadow hover:bg-amber-400 disabled:opacity-40"
          >
            {uploading ? <Loader2 size={15} className="animate-spin" /> : <Film size={15} />}
            {uploading ? 'กำลังส่ง…' : files.length > 1 && uploadMode === 'separate'
              ? videoMode === 'dub_first'
                ? `เริ่ม Dub First ${files.length} โปรเจกต์`
                : `เริ่มตัดต่อ ${files.length} โปรเจกต์`
              : videoMode === 'dub_first'
                ? 'เริ่ม Dub First'
                : 'เริ่มตัดต่อ AI'}
          </button>

          {videoMode === 'dub_first' ? (
            <div className="rounded-xl border border-purple-500/15 bg-purple-500/5 p-4 space-y-1">
              <p className="text-xs font-semibold text-purple-100/90">โหมด: Dub First</p>
              <p className="text-xs leading-relaxed text-purple-200/60">เตรียม → AI วาง script → ตัดคลิป silent → ดาวน์โหลด → พากย์เสียงเอง</p>
              <p className="text-[11px] leading-relaxed text-purple-300/45">ได้ไฟล์ MP4 ไม่มีเสียง + script.txt สำหรับอัดเสียงใน CapCut</p>
            </div>
          ) : (
            <div className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-1">
              <p className="text-xs font-semibold text-amber-100/80">โหมด: Talking Head</p>
              <p className="text-xs leading-relaxed text-amber-300/50">เตรียมวิดีโอ → ถอดเสียง → วางแผนตัด → สร้างคลิป → ดาวน์โหลด</p>
              <p className="text-[11px] leading-relaxed text-amber-300/40">ไฮไลต์ = AI เลือกช่วงดี · เต็ม = เก็บคำพูดทั้งหมด</p>
            </div>
          )}
            </div>
          </div>
        </div>

        <div className="scroll-ghost flex min-w-0 flex-col gap-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
          <h2 className="text-sm font-semibold text-amber-200/70 uppercase tracking-widest">
            โปรเจกต์ของฉัน
          </h2>

          {loadingList ? (
            <div className="flex items-center gap-2 text-sm text-amber-300/50">
              <Loader2 size={14} className="animate-spin" /> กำลังโหลด…
            </div>
          ) : projects.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-white/10 bg-white/5 py-16 text-center">
              <Film size={40} className="text-amber-400/20" />
              <p className="mt-4 text-sm text-amber-300/50">ยังไม่มีโปรเจกต์</p>
              <p className="mt-1 text-xs text-amber-300/30">อัปโหลดวิดีโอเพื่อเริ่มต้น</p>
            </div>
          ) : (
            <div className="grid items-stretch gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {projects.map((p) => (
                <ProjectCard
                  key={p.uid}
                  project={p}
                  job={p.job_id ? (jobStatuses[p.job_id] ?? null) : null}
                  onDownloadFinal={handleDownloadFinal}
                  onDownloadCapcut={handleDownloadCapcut}
                  onCancel={handleCancel}
                  onDelete={setConfirmDeleteUid}
                  onVoUploaded={handleVoUploaded}
                  onEdit={setEditingUid}
                  downloading={downloading}
                  actionUid={actionUid}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {confirmDeleteUid && (
        <ConfirmModal
          title="ลบโปรเจกต์"
          message="ลบโปรเจกต์นี้และไฟล์ทั้งหมดบนเซิร์ฟเวอร์ การกระทำนี้ไม่สามารถย้อนกลับได้"
          confirmLabel="ลบถาวร"
          onConfirm={() => void doDelete(confirmDeleteUid)}
          onCancel={() => setConfirmDeleteUid(null)}
        />
      )}

      {editingUid && (
        <VideoTimelineEditor
          uid={editingUid}
          mode={projects.find((p) => p.uid === editingUid)?.mode ?? 'talking_head'}
          onClose={() => setEditingUid(null)}
          onSaved={() => void loadProjects()}
        />
      )}
    </div>
  )
}
