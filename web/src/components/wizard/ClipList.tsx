import { useEffect, useRef, useState } from 'react'
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
import { GripVertical, X } from 'lucide-react'
import { cn } from '../../lib/cn'
import {
  ROLE_LABEL,
  fmtBytes,
  fmtClock,
  moveToIndex,
  roleFor,
  type WizardFile
} from '../../lib/wizardState'
import { Menu } from '../ui/Menu'
import { ClipThumbnail } from './ClipThumbnail'

function metaLine(clip: WizardFile): string {
  const parts: string[] = []
  if (clip.durationSec !== null) parts.push(fmtClock(clip.durationSec))
  if (clip.width && clip.height) parts.push(`${clip.width}×${clip.height}`)
  if (clip.sizeBytes !== null) parts.push(fmtBytes(clip.sizeBytes))
  return parts.length > 0 ? parts.join(' · ') : 'กำลังอ่านข้อมูลคลิป…'
}

/** The role tag doubles as the control that sets it — the roles are positions,
 * so "ตั้งเป็นคลิปเปิด" is literally a move to index 0. Nothing is stored. */
function RoleTag({
  index,
  total,
  onMove
}: {
  index: number
  total: number
  onMove: (to: number) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const role = roleFor(index, total)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const isEdge = role === 'open' || role === 'close'

  if (total <= 1) {
    return (
      <span className="inline-flex h-7 shrink-0 items-center rounded-md border border-border-faint px-2.5 text-[13px] text-muted">
        {ROLE_LABEL.only}
      </span>
    )
  }

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          'inline-flex h-7 items-center rounded-md px-2.5 text-[13px] transition-colors duration-state ease-out',
          isEdge
            ? 'border border-accent bg-accent-tint text-accent'
            : 'border border-border text-muted hover:border-border-strong hover:text-ink'
        )}
      >
        {ROLE_LABEL[role]}
      </button>
      {open ? (
        <Menu
          className="absolute right-0 top-8"
          items={[
            { key: 'open', label: 'ตั้งเป็นคลิปเปิด', disabled: index === 0 },
            { key: 'close', label: 'ตั้งเป็นคลิปปิด', disabled: index === total - 1 }
          ]}
          onSelect={(key) => {
            setOpen(false)
            onMove(key === 'open' ? 0 : total - 1)
          }}
        />
      ) : null}
    </div>
  )
}

function ClipRow({
  clip,
  index,
  total,
  onMove,
  onRemove
}: {
  clip: WizardFile
  index: number
  total: number
  onMove: (to: number) => void
  onRemove: () => void
}): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: clip.id
  })

  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.55 : 1
      }}
      className="flex flex-wrap items-center gap-2.5 border-b border-divider px-3 py-3 sm:flex-nowrap sm:px-5"
    >
      <button
        type="button"
        aria-label={`ลากเพื่อเรียงลำดับ ${clip.name}`}
        className="w-5 shrink-0 cursor-grab touch-none text-muted transition-colors duration-state ease-out hover:text-ink active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <GripVertical size={15} />
      </button>

      <ClipThumbnail
        file={clip.file}
        path={clip.path}
        className="h-16 w-9 rounded-[3px] bg-media"
      />

      {/* `basis-40`: four shrink-0 neighbours crushed the filename to ~100px
          on a phone. With a basis the row wraps instead. */}
      <span className="min-w-0 flex-1 basis-40">
        <span className="block truncate text-[15px] text-ink">{clip.name}</span>
        <span className="block text-[13px] tabular-nums text-muted">{metaLine(clip)}</span>
      </span>

      <button
        type="button"
        onClick={onRemove}
        aria-label={`เอา ${clip.name} ออก`}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors duration-state ease-out hover:bg-[rgb(243_242_242_/_0.06)] hover:text-ink"
      >
        <X size={16} />
      </button>

      <RoleTag index={index} total={total} onMove={onMove} />
    </li>
  )
}

export function ClipList({
  files,
  onChange
}: {
  files: WizardFile[]
  onChange: (next: WizardFile[]) => void
}): React.JSX.Element {
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const from = files.findIndex((f) => f.id === active.id)
    const to = files.findIndex((f) => f.id === over.id)
    if (from === -1 || to === -1) return
    onChange(arrayMove(files, from, to))
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={files.map((f) => f.id)} strategy={verticalListSortingStrategy}>
        <ul>
          {files.map((clip, i) => (
            <ClipRow
              key={clip.id}
              clip={clip}
              index={i}
              total={files.length}
              onMove={(to) => onChange(moveToIndex(files, i, to))}
              onRemove={() => onChange(files.filter((f) => f.id !== clip.id))}
            />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  )
}
