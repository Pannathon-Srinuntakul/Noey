import { useEffect, useState } from 'react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ChevronDown, ChevronUp, Film, GripVertical, Loader2, Upload } from 'lucide-react'
import type { LocalProject } from '../../../preload'
import { pickVideoFiles, toPickedVideoFiles, type PickedVideoFile } from '../lib/pickVideoFiles'
import {
  DUB_DURATION_CHIPS,
  DUB_SCRIPT_STYLES,
  buildDubBrief,
  dubTargetDurationSec
} from '../lib/dubBrief'
import {
  CAPTION_BORDER_COLORS,
  CAPTION_COLORS,
  CAPTION_FONTS,
  CAPTION_MODES,
  CAPTION_SIZE_MAX,
  CAPTION_SIZE_MIN,
  CAPTION_STYLE_DEFAULT,
  type CaptionStyle
} from '../lib/captionStyle'

interface UploadItem extends PickedVideoFile {
  id: string
}

function toUploadItem(f: PickedVideoFile): UploadItem {
  return { ...f, id: crypto.randomUUID() }
}

function clipOrderLabel(index: number, total: number): string {
  if (total <= 1) return 'คลิปเดียว'
  if (index === 0) return `คลิป ${index + 1} · เปิด`
  if (index === total - 1) return `คลิป ${index + 1} · ปิด`
  return `คลิป ${index + 1}`
}

/** Grabs one frame ~10% into the clip as a JPEG data URL — used for the
 * caption style preview so it shows the real footage instead of a placeholder. */
function captureVideoThumbnail(file: File, maxH: number): Promise<string | null> {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file)
    const video = document.createElement('video')
    video.preload = 'auto'
    video.muted = true
    video.playsInline = true
    video.src = objectUrl
    let settled = false

    const finish = (result: string | null): void => {
      if (settled) return
      settled = true
      URL.revokeObjectURL(objectUrl)
      resolve(result)
    }

    const capture = (): void => {
      const w = video.videoWidth
      const h = video.videoHeight
      if (!w || !h) return finish(null)
      const canvas = document.createElement('canvas')
      const scale = maxH / h
      canvas.width = Math.max(1, Math.round(w * scale))
      canvas.height = maxH
      const ctx = canvas.getContext('2d')
      if (!ctx) return finish(null)
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      finish(canvas.toDataURL('image/jpeg', 0.82))
    }

    const seekToPreview = (): void => {
      const t =
        Number.isFinite(video.duration) && video.duration > 0
          ? Math.min(0.5, video.duration * 0.1)
          : 0
      if (t === 0) return capture()
      video.currentTime = t
    }

    video.addEventListener('loadeddata', seekToPreview, { once: true })
    video.addEventListener('seeked', capture, { once: true })
    video.addEventListener('error', () => finish(null), { once: true })
  })
}

function moveUploadItem(items: UploadItem[], from: number, to: number): UploadItem[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) {
    return items
  }
  const next = [...items]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

function UploadFileThumbnail({ file }: { file: File }): React.JSX.Element {
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

    const captureFrame = (): void => {
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

    const seekToPreview = (): void => {
      if (cancelled) return
      const t =
        Number.isFinite(video.duration) && video.duration > 0
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
    video.addEventListener(
      'error',
      () => {
        if (!cancelled) setFailed(true)
      },
      { once: true }
    )

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
      {thumb && <img src={thumb} alt="" className="h-full w-full object-cover" />}
    </div>
  )
}

function SortableUploadFileRow({
  item,
  index,
  total,
  onMoveUp,
  onMoveDown,
  onRemove
}: {
  item: UploadItem
  index: number
  total: number
  onMoveUp: () => void
  onMoveDown: () => void
  onRemove: () => void
}): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.55 : 1
  }

  return (
    <li
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-2.5 py-2.5 text-sm"
    >
      <button
        type="button"
        className="cursor-grab touch-none text-white/30 hover:text-amber-300 active:cursor-grabbing"
        title="ลากเพื่อเรียงลำดับ"
        {...attributes}
        {...listeners}
      >
        <GripVertical size={14} />
      </button>

      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-500/20 text-xs font-bold text-amber-200">
        {index + 1}
      </span>

      <UploadFileThumbnail file={item.file} />

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-amber-100/90">{item.name}</p>
        {total > 1 && (
          <p className="mt-0.5 text-[11px] text-amber-300/45">{clipOrderLabel(index, total)}</p>
        )}
      </div>

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

const DUB_LABEL = 'text-sm font-semibold text-purple-100/90'
const DUB_TEXTAREA =
  'w-full resize-none rounded-lg border border-purple-400/35 bg-black/30 px-3 py-2.5 text-sm leading-relaxed text-zinc-100 outline-none focus:border-purple-300/70 focus:ring-1 focus:ring-purple-400/30'
const DUB_INPUT =
  'w-full rounded-lg border border-purple-400/35 bg-black/30 px-3 py-2 text-xs text-zinc-100 outline-none focus:border-purple-300/70 focus:ring-1 focus:ring-purple-400/30'
const DUB_HINT = 'text-xs leading-relaxed text-amber-200/65'
const DUB_CHIP_ACTIVE = 'bg-purple-500 text-white'
const DUB_CHIP_INACTIVE =
  'border border-purple-400/35 text-purple-100/90 hover:border-purple-300/55 hover:text-white bg-black/20 hover:bg-purple-500/10'

interface Props {
  onCreated: (project: LocalProject) => void
}

export default function NewProjectSidebar({ onCreated }: Props): React.JSX.Element {
  const [files, setFiles] = useState<UploadItem[]>([])
  const [mode, setMode] = useState<'talking_head' | 'dub_first'>('talking_head')
  // Independent from `mode` (edit style) — this is "how many clips → how many
  // projects", same axis the web uploader exposes. Keep it a separate state so
  // switching edit mode never resets or overrides this choice, and vice versa.
  const [uploadMode, setUploadMode] = useState<'merge' | 'separate'>('merge')
  const [scriptMode, setScriptMode] = useState<'generate' | 'own'>('generate')
  const [userScript, setUserScript] = useState('')
  const [scriptStyles, setScriptStyles] = useState<string[]>([])
  const [scriptDuration, setScriptDuration] = useState('')
  const [scriptCustomSec, setScriptCustomSec] = useState('')
  const [scriptNote, setScriptNote] = useState('')
  const [talkingBrief, setTalkingBrief] = useState('')
  const [captionEnabled, setCaptionEnabled] = useState(true)
  const [captionStyle, setCaptionStyle] = useState<CaptionStyle>(CAPTION_STYLE_DEFAULT)
  const [previewThumb, setPreviewThumb] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  // Real footage thumbnail for the caption style preview — first picked clip.
  const firstFile = files[0]
  useEffect(() => {
    let cancelled = false
    Promise.resolve(firstFile ? captureVideoThumbnail(firstFile.file, 320) : null).then((url) => {
      if (!cancelled) setPreviewThumb(url)
    })
    return () => {
      cancelled = true
    }
  }, [firstFile])

  const pickFiles = async (): Promise<void> => {
    const picked = await pickVideoFiles()
    if (picked.length > 0) setFiles((prev) => [...prev, ...picked.map(toUploadItem)])
  }

  const handleFilesDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    const dropped = toPickedVideoFiles(Array.from(e.dataTransfer.files))
    if (dropped.length > 0) setFiles((prev) => [...prev, ...dropped.map(toUploadItem)])
  }

  const handleFileDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    setFiles((prev) => {
      const oldIndex = prev.findIndex((f) => f.id === active.id)
      const newIndex = prev.findIndex((f) => f.id === over.id)
      return arrayMove(prev, oldIndex, newIndex)
    })
  }

  const reset = (): void => {
    setFiles([])
    setUploadMode('merge')
    setUserScript('')
    setScriptStyles([])
    setScriptDuration('')
    setScriptCustomSec('')
    setScriptNote('')
    setTalkingBrief('')
    setCaptionEnabled(true)
    setCaptionStyle(CAPTION_STYLE_DEFAULT)
  }

  const submit = async (): Promise<void> => {
    if (files.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const targetDurationSec =
        mode === 'dub_first' ? dubTargetDurationSec(scriptDuration, scriptCustomSec) : null
      const brief =
        mode === 'dub_first'
          ? (buildDubBrief(scriptDuration, scriptCustomSec, scriptNote, scriptStyles) ?? '')
          : talkingBrief.trim()
      const userScriptFinal = mode === 'dub_first' && scriptMode === 'own' ? userScript.trim() : ''
      const finalTargetDurationSec = targetDurationSec ?? undefined

      // "merge": one project, all clips concatenated (existing behavior).
      // "separate": one project per clip — only offered/meaningful once there's
      // more than one file, same split the web uploader does.
      const groups: UploadItem[][] =
        uploadMode === 'separate' && files.length > 1 ? files.map((f) => [f]) : [files]

      for (const group of groups) {
        const name = group[0].name.replace(/\.[^.]+$/, '')
        const project = await window.noey.projects.create({ name, mode })
        const projectDir = await window.noey.projects.dir(project.uid)
        const ingested = await window.noey.sidecar.ingest.run({
          projectDir,
          sources: group.map((f) => f.path),
          mode
        })
        const updated = await window.noey.projects.update(project.uid, {
          clips: ingested.clips as LocalProject['clips'],
          step: 'imported',
          brief,
          userScript: userScriptFinal,
          scriptStyles,
          targetDurationSec: finalTargetDurationSec,
          captionStyle: mode === 'talking_head' && captionEnabled ? captionStyle : undefined
        })
        onCreated(updated)
      }
      reset()
    } catch (err) {
      setError(String((err as Error).message ?? err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex w-full shrink-0 flex-col gap-4 md:min-h-0 md:w-96 md:overflow-y-auto">
      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-amber-200/70">
          อัปโหลดวิดีโอ
        </h2>
        <p className="-mt-2 text-[11px] text-amber-200/45">
          {mode === 'dub_first'
            ? 'คลิปต้นฉบับสูงสุด 20 นาทีต่อไฟล์ · รวมทุกไฟล์ไม่เกิน 20 นาที'
            : 'รวมทุกไฟล์ในโปรเจกต์ไม่เกิน 2 ชั่วโมง'}
        </p>

        {files.length === 0 ? (
          <button
            type="button"
            onClick={pickFiles}
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleFilesDrop}
            className="flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-amber-500/30 bg-amber-500/5 p-6 text-center transition hover:border-amber-400/50 hover:bg-amber-500/10"
          >
            <Upload size={28} className="text-amber-400/60" />
            <span className="text-sm font-medium text-amber-100/80">
              เลือกวิดีโอ หรือลากไฟล์มาวาง
            </span>
          </button>
        ) : (
          <div
            className="space-y-2"
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleFilesDrop}
          >
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleFileDragEnd}
            >
              <SortableContext
                items={files.map((f) => f.id)}
                strategy={verticalListSortingStrategy}
              >
                <ul className="space-y-1.5">
                  {files.map((item, i) => (
                    <SortableUploadFileRow
                      key={item.id}
                      item={item}
                      index={i}
                      total={files.length}
                      onMoveUp={() => setFiles((prev) => moveUploadItem(prev, i, i - 1))}
                      onMoveDown={() => setFiles((prev) => moveUploadItem(prev, i, i + 1))}
                      onRemove={() => setFiles((prev) => prev.filter((f) => f.id !== item.id))}
                    />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
            <button
              type="button"
              onClick={pickFiles}
              className="w-full rounded-lg border border-amber-500/40 py-1.5 text-xs text-amber-300 hover:border-amber-400 hover:text-amber-200"
            >
              เพิ่มไฟล์
            </button>
          </div>
        )}

        <div className="flex gap-2 rounded-lg border border-white/10 bg-black/15 p-1">
          <button
            type="button"
            onClick={() => setMode('talking_head')}
            className={`flex-1 rounded-lg px-3 py-2.5 text-center transition-all ${
              mode === 'talking_head'
                ? 'bg-amber-500 text-black shadow'
                : 'border border-white/15 text-amber-300/70 hover:border-amber-400/40 hover:text-amber-200'
            }`}
          >
            <span className="block text-sm font-semibold">🎙 ตัดช่วงเงียบ</span>
            <span
              className={`block text-[10px] ${mode === 'talking_head' ? 'text-black/60' : 'opacity-60'}`}
            >
              พูดหน้ากล้อง · Talking Head
            </span>
          </button>
          <button
            type="button"
            onClick={() => setMode('dub_first')}
            className={`flex-1 rounded-lg px-3 py-2.5 text-center transition-all ${
              mode === 'dub_first'
                ? 'bg-purple-500 text-white shadow'
                : 'border border-white/15 text-amber-300/70 hover:border-purple-400/40 hover:text-purple-200'
            }`}
          >
            <span className="block text-sm font-semibold">🎬 ตัดฉากเด่น พากย์เอง</span>
            <span
              className={`block text-[10px] ${mode === 'dub_first' ? 'text-white/70' : 'opacity-60'}`}
            >
              Dub First
            </span>
          </button>
        </div>

        {files.length > 1 && (
          <div
            className={`space-y-2 rounded-xl border p-4 ${
              mode === 'dub_first'
                ? 'border-purple-500/25 bg-purple-500/5'
                : 'border-white/10 bg-white/5'
            }`}
          >
            <p
              className={`text-[11px] font-semibold uppercase tracking-widest ${
                mode === 'dub_first' ? 'text-purple-200/55' : 'text-amber-200/55'
              }`}
            >
              อัปโหลดหลายคลิป
            </p>
            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="radio"
                name="uploadMode"
                checked={uploadMode === 'merge'}
                onChange={() => setUploadMode('merge')}
                className={`mt-0.5 ${mode === 'dub_first' ? 'accent-purple-400' : 'accent-amber-500'}`}
              />
              <div>
                <p
                  className={`text-sm font-medium ${mode === 'dub_first' ? 'text-purple-100/90' : 'text-amber-100/90'}`}
                >
                  รวมเป็นคลิปเดียว
                </p>
                <p
                  className={`mt-0.5 text-xs leading-relaxed ${mode === 'dub_first' ? 'text-purple-300/50' : 'text-amber-300/50'}`}
                >
                  {mode === 'dub_first'
                    ? 'ต่อคลิปตามลำดับ → AI วาง script + ตัด silent 1 ไฟล์'
                    : 'ต่อคลิปตามลำดับด้านบน แล้วตัดเป็นวิดีโอไฟล์เดียว'}
                </p>
              </div>
            </label>
            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="radio"
                name="uploadMode"
                checked={uploadMode === 'separate'}
                onChange={() => setUploadMode('separate')}
                className={`mt-0.5 ${mode === 'dub_first' ? 'accent-purple-400' : 'accent-amber-500'}`}
              />
              <div>
                <p
                  className={`text-sm font-medium ${mode === 'dub_first' ? 'text-purple-100/90' : 'text-amber-100/90'}`}
                >
                  แยกเป็นคนละโปรเจกต์
                </p>
                <p
                  className={`mt-0.5 text-xs leading-relaxed ${mode === 'dub_first' ? 'text-purple-300/50' : 'text-amber-300/50'}`}
                >
                  {mode === 'dub_first'
                    ? `สร้าง ${files.length} โปรเจกต์ — คลิปละ 1 script + วิดีโอ`
                    : `สร้าง ${files.length} โปรเจกต์ — คลิปละ 1 งานตัดต่อ`}
                </p>
              </div>
            </label>
          </div>
        )}

        {mode === 'dub_first' && (
          <div className="flex flex-col gap-3 rounded-xl border border-purple-500/20 bg-purple-500/5 p-3">
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
                ✨ ให้ AI สร้าง script
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

            <div className="space-y-1.5">
              <span className={DUB_LABEL}>ความยาววิดีโอที่ต้องการ</span>
              <div className="flex flex-wrap gap-1.5">
                {DUB_DURATION_CHIPS.map(({ value, label }) => (
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
                    min={15}
                    max={600}
                    value={scriptCustomSec}
                    onChange={(e) => setScriptCustomSec(e.target.value)}
                    placeholder="วินาที"
                    className={`${DUB_INPUT} w-20`}
                  />
                  <span className="text-xs text-purple-200/55">วินาที (15–600)</span>
                </div>
              )}
            </div>

            {scriptMode === 'generate' && (
              <div className="space-y-2.5">
                <div className="space-y-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className={DUB_LABEL}>สไตล์ที่ต้องการ</span>
                    <span className="text-[10px] text-purple-200/45">เลือกได้หลายข้อ</span>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {DUB_SCRIPT_STYLES.map(({ value, label, emoji }) => {
                      const selected = scriptStyles.includes(value)
                      return (
                        <button
                          key={value}
                          type="button"
                          aria-pressed={selected}
                          onClick={() =>
                            setScriptStyles((prev) =>
                              prev.includes(value)
                                ? prev.filter((s) => s !== value)
                                : [...prev, value]
                            )
                          }
                          className={`flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-medium transition-all ${
                            selected ? DUB_CHIP_ACTIVE : DUB_CHIP_INACTIVE
                          }`}
                        >
                          <span>{emoji}</span> {label}
                        </button>
                      )
                    })}
                  </div>
                </div>
                <div className="space-y-1.5">
                  <span className={DUB_LABEL}>รายละเอียดสินค้า / คำสั่งเพิ่มเติม</span>
                  <textarea
                    value={scriptNote}
                    onChange={(e) => setScriptNote(e.target.value)}
                    rows={4}
                    placeholder={
                      'เช่น เน้นจุดเด่นเรื่องกลิ่น · เริ่ม hook แรง · ปิด CTA ลิงก์ในไบโอ\nหรือบอกสิ่งที่อยากได้เพิ่มจาก AI'
                    }
                    className={DUB_TEXTAREA}
                  />
                </div>
                {scriptStyles.length === 0 && (
                  <p className={DUB_HINT}>⚠ เลือกสไตล์เพื่อให้ AI สร้าง script ได้ตรงมากขึ้น</p>
                )}
              </div>
            )}

            {scriptMode === 'own' && (
              <div className="space-y-2.5">
                <div className="space-y-1.5">
                  <span className={DUB_LABEL}>Script ที่จะพูด</span>
                  <textarea
                    value={userScript}
                    onChange={(e) => setUserScript(e.target.value)}
                    rows={4}
                    placeholder="AI จะเลือกซีนวิดีโอให้ตรงกับแต่ละบรรทัด"
                    className={DUB_TEXTAREA}
                  />
                </div>
                <div className="space-y-1.5">
                  <span className="text-xs font-medium text-purple-100/85">
                    Note สำหรับ AI (ไม่บังคับ)
                  </span>
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

        {mode === 'talking_head' && (
          <div className="space-y-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
            <div>
              <p className="text-sm font-medium text-amber-100/90">ตัดช่วงเงียบ + ลบคำพูดซ้ำ</p>
              <p className="text-xs leading-relaxed text-amber-300/50">
                AI ดูวิดีโอทุกคลิปให้ — แก้คำที่ถอดเสียงผิด ตัดพูดติด/พูดซ้ำ
                และเก็บช่วงเงียบที่ยังมีภาพสำคัญไว้
              </p>
            </div>
            <div className="space-y-1.5">
              <span className="text-xs font-medium text-amber-100/85">
                บริบท/ชื่อสินค้า (ไม่บังคับ)
              </span>
              <input
                type="text"
                value={talkingBrief}
                onChange={(e) => setTalkingBrief(e.target.value)}
                placeholder="เช่น รีวิวรองเท้ายี่ห้อ X — ช่วย AI สะกดชื่อแบรนด์ให้ถูก"
                className="w-full rounded-lg border border-amber-500/30 bg-black/20 px-3 py-2 text-xs text-zinc-100 outline-none focus:border-amber-400"
              />
            </div>

            <div className="space-y-1.5 border-t border-amber-500/15 pt-3">
              <label className="flex cursor-pointer items-center gap-2.5">
                <input
                  type="checkbox"
                  checked={captionEnabled}
                  onChange={(e) => setCaptionEnabled(e.target.checked)}
                  className="accent-amber-500"
                />
                <span className="text-sm font-medium text-amber-100/90">ใส่ Caption</span>
              </label>
              <p className="text-xs leading-relaxed text-amber-300/50">
                เบิร์นซับลงคลิปอัตโนมัติ — แก้ข้อความ/timing ได้ทีหลังใน editor
              </p>
            </div>

            {captionEnabled && (
              <>
                <div className="space-y-1.5">
                  <span className="text-xs font-medium text-amber-100/85">Font</span>
                  <div className="grid grid-cols-2 gap-1.5">
                    {CAPTION_FONTS.map(({ value, label, cssFamily }) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={captionStyle.font === value}
                        onClick={() => setCaptionStyle((prev) => ({ ...prev, font: value }))}
                        className={`flex flex-col items-start gap-0.5 rounded-lg px-2.5 py-2 text-left transition-all ${
                          captionStyle.font === value
                            ? 'bg-amber-500 text-black'
                            : 'border border-amber-500/30 text-amber-100/80 hover:border-amber-400/50 hover:text-amber-100'
                        }`}
                      >
                        <span
                          style={{ fontFamily: cssFamily }}
                          className="truncate text-base font-bold leading-none"
                        >
                          สวัสดี Aa
                        </span>
                        <span className="text-[10px] font-medium opacity-70">{label}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <span className="text-xs font-medium text-amber-100/85">Animation</span>
                  <div className="flex flex-wrap gap-1.5">
                    {CAPTION_MODES.map(({ value, label }) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={captionStyle.mode === value}
                        onClick={() => setCaptionStyle((prev) => ({ ...prev, mode: value }))}
                        className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all ${
                          captionStyle.mode === value
                            ? 'bg-amber-500 text-black'
                            : 'border border-amber-500/30 text-amber-100/80 hover:border-amber-400/50 hover:text-amber-100'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <span className="text-xs font-medium text-amber-100/85">สีตัวอักษร</span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {CAPTION_COLORS.map((hex) => (
                      <button
                        key={hex}
                        type="button"
                        aria-pressed={captionStyle.color === hex}
                        title={hex}
                        onClick={() => setCaptionStyle((prev) => ({ ...prev, color: hex }))}
                        style={{ backgroundColor: hex }}
                        className={`h-7 w-7 rounded-full border-2 transition-all ${
                          captionStyle.color === hex
                            ? 'border-amber-300 ring-2 ring-amber-300/50'
                            : 'border-white/20 hover:border-white/50'
                        }`}
                      />
                    ))}
                    <input
                      type="color"
                      value={captionStyle.color}
                      onChange={(e) =>
                        setCaptionStyle((prev) => ({ ...prev, color: e.target.value }))
                      }
                      title="เลือกสีเอง"
                      className="h-7 w-7 cursor-pointer rounded-full border-2 border-white/20 bg-transparent p-0"
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <span className="text-xs font-medium text-amber-100/85">สีขอบตัวอักษร</span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {CAPTION_BORDER_COLORS.map((hex) => (
                      <button
                        key={hex}
                        type="button"
                        aria-pressed={captionStyle.border_color === hex}
                        title={hex}
                        onClick={() => setCaptionStyle((prev) => ({ ...prev, border_color: hex }))}
                        style={{ backgroundColor: hex }}
                        className={`h-7 w-7 rounded-full border-2 transition-all ${
                          captionStyle.border_color === hex
                            ? 'border-amber-300 ring-2 ring-amber-300/50'
                            : 'border-white/20 hover:border-white/50'
                        }`}
                      />
                    ))}
                    <input
                      type="color"
                      value={captionStyle.border_color}
                      onChange={(e) =>
                        setCaptionStyle((prev) => ({ ...prev, border_color: e.target.value }))
                      }
                      title="เลือกสีเอง"
                      className="h-7 w-7 cursor-pointer rounded-full border-2 border-white/20 bg-transparent p-0"
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-baseline justify-between">
                    <span className="text-xs font-medium text-amber-100/85">ขนาดตัวอักษร</span>
                    <span className="text-[10px] text-amber-300/50">{captionStyle.size}px</span>
                  </div>
                  <input
                    type="range"
                    min={CAPTION_SIZE_MIN}
                    max={CAPTION_SIZE_MAX}
                    value={captionStyle.size}
                    onChange={(e) =>
                      setCaptionStyle((prev) => ({ ...prev, size: Number(e.target.value) }))
                    }
                    className="w-full accent-amber-500"
                  />
                  <div className="flex justify-center rounded-xl border border-white/10 bg-black/30 py-3">
                    <div
                      className="relative flex aspect-[9/16] w-36 items-end justify-center overflow-hidden rounded-md bg-linear-to-b from-zinc-600 to-zinc-800 bg-cover bg-center p-2"
                      style={previewThumb ? { backgroundImage: `url(${previewThumb})` } : undefined}
                      title="ตัวอย่างขนาดเทียบกับเฟรมวิดีโอ 9:16"
                    >
                      {!previewThumb && (
                        <Film
                          size={28}
                          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-white/15"
                        />
                      )}
                      <span
                        style={{
                          fontFamily: CAPTION_FONTS.find((f) => f.value === captionStyle.font)
                            ?.cssFamily,
                          color: captionStyle.color,
                          fontSize: `${Math.round((captionStyle.size / 1920) * 256)}px`,
                          WebkitTextStroke: `${Math.max(1, Math.round((4 / 1920) * 256))}px ${captionStyle.border_color}`,
                          paintOrder: 'stroke fill'
                        }}
                        className="relative text-center font-bold leading-tight"
                      >
                        สวัสดีค่ะ
                      </span>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {error && (
          <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-300">
            {error}
          </p>
        )}

        <button
          onClick={() => void submit()}
          disabled={files.length === 0 || busy}
          className="flex items-center justify-center gap-2 rounded-xl bg-amber-500 py-3 text-sm font-bold text-black shadow hover:bg-amber-400 disabled:opacity-40"
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Film size={15} />}
          {busy
            ? 'กำลังเริ่ม…'
            : mode === 'dub_first'
              ? 'เริ่มตัดฉากเด่น พากย์เอง'
              : 'เริ่มตัดช่วงเงียบ'}
        </button>

        {mode === 'dub_first' ? (
          <div className="space-y-1 rounded-xl border border-purple-500/15 bg-purple-500/5 p-4">
            <p className="text-xs font-semibold text-purple-100/90">
              โหมด: ตัดฉากเด่น พากย์เอง (Dub First)
            </p>
            <p className="text-xs leading-relaxed text-purple-200/60">
              เตรียม → AI วาง script → ตัดคลิป silent → รออัดเสียงพากย์
            </p>
          </div>
        ) : (
          <div className="space-y-1 rounded-xl border border-white/10 bg-white/5 p-4">
            <p className="text-xs font-semibold text-amber-100/80">
              โหมด: ตัดช่วงเงียบ (Talking Head)
            </p>
            <p className="text-xs leading-relaxed text-amber-300/50">
              เตรียมวิดีโอ → ถอดเสียง → วางแผนตัด → สร้างคลิป
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
