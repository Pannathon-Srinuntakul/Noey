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
import { pickVideoFiles, type PickedVideoFile } from '../lib/pickVideoFiles'
import {
  DUB_DURATION_CHIPS,
  DUB_SCRIPT_STYLES,
  buildDubBrief,
  dubTargetDurationSec
} from '../lib/dubBrief'

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
  const [scriptMode, setScriptMode] = useState<'generate' | 'own'>('generate')
  const [userScript, setUserScript] = useState('')
  const [scriptStyles, setScriptStyles] = useState<string[]>([])
  const [scriptDuration, setScriptDuration] = useState('')
  const [scriptCustomSec, setScriptCustomSec] = useState('')
  const [scriptNote, setScriptNote] = useState('')
  const [durationMode, setDurationMode] = useState<'full' | 'custom'>('full')
  const [targetSec, setTargetSec] = useState(60)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const pickFiles = async (): Promise<void> => {
    const picked = await pickVideoFiles()
    if (picked.length > 0) setFiles((prev) => [...prev, ...picked.map(toUploadItem)])
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
    setUserScript('')
    setScriptStyles([])
    setScriptDuration('')
    setScriptCustomSec('')
    setScriptNote('')
    setDurationMode('full')
    setTargetSec(60)
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
          : ''
      const userScriptFinal = mode === 'dub_first' && scriptMode === 'own' ? userScript.trim() : ''

      const name = files[0].name.replace(/\.[^.]+$/, '')
      const project = await window.noey.projects.create({ name, mode })
      const projectDir = await window.noey.projects.dir(project.uid)
      const ingested = await window.noey.sidecar.ingest.run({
        projectDir,
        sources: files.map((f) => f.path)
      })
      const updated = await window.noey.projects.update(project.uid, {
        clips: ingested.clips as LocalProject['clips'],
        step: 'imported',
        brief,
        userScript: userScriptFinal,
        scriptStyles,
        targetDurationSec: targetDurationSec ?? (durationMode === 'custom' ? targetSec : undefined)
      })
      onCreated(updated)
      reset()
    } catch (err) {
      setError(String((err as Error).message ?? err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex w-full shrink-0 flex-col gap-4 lg:min-h-0 lg:w-96 lg:overflow-y-auto">
      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-amber-200/70">
          อัปโหลดวิดีโอ
        </h2>
        <p className="-mt-2 text-[11px] text-amber-200/45">คลิปต้นฉบับสูงสุด 10 นาทีต่อไฟล์</p>

        {files.length === 0 ? (
          <button
            type="button"
            onClick={pickFiles}
            className="flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-amber-500/30 bg-amber-500/5 p-6 text-center transition hover:border-amber-400/50 hover:bg-amber-500/10"
          >
            <Upload size={28} className="text-amber-400/60" />
            <span className="text-sm font-medium text-amber-100/80">เลือกวิดีโอ</span>
          </button>
        ) : (
          <div className="space-y-2">
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
            className={`flex-1 rounded-lg px-3 py-2.5 text-sm font-semibold transition-all ${
              mode === 'talking_head'
                ? 'bg-amber-500 text-black shadow'
                : 'border border-white/15 text-amber-300/70 hover:border-amber-400/40 hover:text-amber-200'
            }`}
          >
            🎙 Talking Head
          </button>
          <button
            type="button"
            onClick={() => setMode('dub_first')}
            className={`flex-1 rounded-lg px-3 py-2.5 text-sm font-semibold transition-all ${
              mode === 'dub_first'
                ? 'bg-purple-500 text-white shadow'
                : 'border border-white/15 text-amber-300/70 hover:border-purple-400/40 hover:text-purple-200'
            }`}
          >
            🎬 Dub First
          </button>
        </div>

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
          <div className="space-y-2 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-amber-200/55">
              ความยาวคลิป
            </p>
            {(
              [
                {
                  value: 'full',
                  label: 'เก็บทั้งหมด',
                  desc: 'ตัดช่วงเงียบ + ลบคำพูดซ้ำ ไม่ใช้ AI'
                },
                {
                  value: 'custom',
                  label: 'กำหนดเอง',
                  desc: 'AI วิเคราะห์ script เลือกช่วงที่ดีที่สุดให้พอดีเวลาที่กำหนด'
                }
              ] as const
            ).map(({ value, label, desc }) => (
              <label
                key={value}
                className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-white/5"
              >
                <input
                  type="radio"
                  name="thDuration"
                  checked={durationMode === value}
                  onChange={() => setDurationMode(value)}
                  className="mt-0.5 accent-amber-500"
                />
                <div>
                  <p className="text-sm font-medium text-amber-100/90">{label}</p>
                  <p className="text-xs leading-relaxed text-amber-300/50">{desc}</p>
                </div>
              </label>
            ))}
            {durationMode === 'custom' && (
              <div className="flex items-center gap-2 pl-6 pt-1">
                <input
                  type="number"
                  min={15}
                  max={600}
                  value={targetSec}
                  onChange={(e) => setTargetSec(Number(e.target.value))}
                  className="w-20 rounded-lg border border-amber-500/30 bg-black/20 px-2 py-1.5 text-sm font-medium text-amber-100 outline-none focus:border-amber-400"
                />
                <span className="text-xs text-amber-300/55">วินาที (15–600)</span>
              </div>
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
          {busy ? 'กำลังเริ่ม…' : mode === 'dub_first' ? 'เริ่ม Dub First' : 'เริ่มตัดต่อ AI'}
        </button>

        {mode === 'dub_first' ? (
          <div className="space-y-1 rounded-xl border border-purple-500/15 bg-purple-500/5 p-4">
            <p className="text-xs font-semibold text-purple-100/90">โหมด: Dub First</p>
            <p className="text-xs leading-relaxed text-purple-200/60">
              เตรียม → AI วาง script → ตัดคลิป silent → รออัดเสียงพากย์
            </p>
          </div>
        ) : (
          <div className="space-y-1 rounded-xl border border-white/10 bg-white/5 p-4">
            <p className="text-xs font-semibold text-amber-100/80">โหมด: Talking Head</p>
            <p className="text-xs leading-relaxed text-amber-300/50">
              เตรียมวิดีโอ → ถอดเสียง → วางแผนตัด → สร้างคลิป
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
