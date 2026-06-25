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
  ArrowLeft,
  Check,
  GripVertical,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { ConfirmModal } from '../hud/ConfirmModal'
import { AddColumnModal } from '../hud/AddColumnModal'
import { COLUMN_TYPE_LABELS } from '../lib/columnTypes'
import { OPTION_COLORS } from '../lib/optionColors'
import type { ColumnMeta, ColumnMetaIn, CustomTableOut, OptionDef } from '../types'

export default function ManageFieldsPage() {
  const { id } = useParams<{ id: string }>()
  const tableId = id ?? ""  // uid string (UUID)
  const navigate = useNavigate()

  const [table, setTable] = useState<CustomTableOut | null>(null)
  const [adding, setAdding] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const load = useCallback(() => {
    api.tables.get(tableId).then(setTable).catch((e) => setError((e as Error).message))
  }, [tableId])

  useEffect(() => { load() }, [load])

  async function addColumn(body: ColumnMetaIn) {
    try {
      await api.tables.addColumn(tableId, body)
      setAdding(false)
      load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function doDelete(key: string) {
    setConfirmDelete(null)
    try {
      await api.tables.deleteColumn(tableId, key)
      load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id || !table) return
    const cols = table.columns
    const oldIdx = cols.findIndex((c) => c.key === active.id)
    const newIdx = cols.findIndex((c) => c.key === over.id)
    if (oldIdx < 0 || newIdx < 0) return
    const reordered = [...cols]
    const [moved] = reordered.splice(oldIdx, 1)
    reordered.splice(newIdx, 0, moved)
    // optimistic
    setTable({ ...table, columns: reordered })
    try {
      await api.tables.reorderColumns(tableId, reordered.map((c) => c.key))
    } catch (e) {
      load()
      setError((e as Error).message)
    }
  }

  if (!table) {
    return (
      <div className="scroll-light flex h-full items-center justify-center bg-zinc-100 text-zinc-400">
        กำลังโหลด…
      </div>
    )
  }

  return (
    <div className="scroll-light flex h-full flex-col bg-zinc-50">
      {/* header */}
      <div className="flex items-center gap-3 border-b border-zinc-200 bg-white px-5 py-3 shadow-sm">
        <button
          onClick={() => navigate(`/tables/${tableId}`)}
          className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-zinc-500 hover:bg-zinc-100"
        >
          <ArrowLeft size={15} /> กลับ
        </button>
        <div className="min-w-0">
          <h1 className="truncate font-bold text-zinc-800">{table.display_name}</h1>
          <p className="text-xs text-zinc-400">จัดการ Columns · {table.columns.length} fields</p>
        </div>
        <button
          onClick={() => setAdding(true)}
          className="ml-auto flex shrink-0 items-center gap-1.5 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white shadow hover:bg-amber-700"
        >
          <Plus size={14} /> เพิ่ม Column
        </button>
      </div>

      {error && (
        <div className="flex items-center justify-between bg-red-50 px-5 py-2 text-sm text-red-700">
          <span>{error}</span>
          <button onClick={() => setError(null)}><X size={14} /></button>
        </div>
      )}

      <div className="flex-1 overflow-auto p-5">
        <p className="mb-3 text-xs text-zinc-400">ลากเพื่อจัดลำดับ · ลำดับนี้จะส่งผลต่อการแสดงคอลัมน์ในตาราง</p>

        {table.columns.length === 0 && (
          <p className="text-center text-sm text-zinc-400 py-8">ยังไม่มี Column — กด "เพิ่ม Column"</p>
        )}

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={table.columns.map((c) => c.key)} strategy={verticalListSortingStrategy}>
            <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
              {table.columns.map((col, idx) => (
                <SortableField
                  key={col.key}
                  col={col}
                  tableId={tableId}
                  isLast={idx === table.columns.length - 1}
                  onSaved={load}
                  onDelete={() => setConfirmDelete(col.key)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>

      {adding && (
        <AddColumnModal existing={table.columns} onCancel={() => setAdding(false)} onSubmit={addColumn} />
      )}

      {confirmDelete && (
        <ConfirmModal
          title="ลบ Column"
          message="Column นี้และข้อมูลทั้งหมดในทุกแถวจะถูกลบถาวร"
          confirmLabel="ลบ Column"
          onConfirm={() => doDelete(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  )
}

// ── Sortable field row ────────────────────────────────────────────────────────

function SortableField({
  col,
  tableId,
  isLast,
  onSaved,
  onDelete,
}: {
  col: ColumnMeta
  tableId: string
  isLast: boolean
  onSaved: () => void
  onDelete: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: col.key })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }
  const [open, setOpen] = useState(false)
  const info = COLUMN_TYPE_LABELS[col.ui_type]

  return (
    <div ref={setNodeRef} style={style} className={`group ${!isLast ? 'border-b border-zinc-100' : ''}`}>
      {/* compact row — click anywhere (except drag/delete) opens edit */}
      <div
        className={`flex cursor-pointer items-center gap-2 px-3 py-2.5 transition ${open ? 'bg-amber-50' : 'hover:bg-zinc-50'}`}
        onClick={() => col.ui_type !== 'formula' && setOpen((o) => !o)}
      >
        {/* drag handle — stopPropagation prevents row click when dragging */}
        <button
          {...attributes}
          {...listeners}
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 cursor-grab text-zinc-400 opacity-0 transition-opacity group-hover:opacity-100 hover:text-zinc-600 active:cursor-grabbing"
        >
          <GripVertical size={16} />
        </button>
        <info.Icon size={14} className="shrink-0 text-zinc-500" />
        <span className="flex-1 truncate text-sm font-medium text-zinc-700">{col.label}</span>
        <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-500">{info.label}</span>
        {col.ui_type === 'formula' && (
          <span className="shrink-0 text-xs text-zinc-400">สูตร (ไม่สามารถแก้ไขได้)</span>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); onDelete() }}
          className="shrink-0 rounded p-1 text-zinc-400 opacity-0 transition hover:text-red-500 group-hover:opacity-100"
        >
          <Trash2 size={14} />
        </button>
      </div>

      {/* expand: edit panel */}
      {open && col.ui_type !== 'formula' && (
        <FieldEditPanel col={col} tableId={tableId} onSaved={() => { setOpen(false); onSaved() }} onCancel={() => setOpen(false)} />
      )}
    </div>
  )
}

// ── Edit panel ────────────────────────────────────────────────────────────────

function FieldEditPanel({ col, tableId, onSaved, onCancel }: {
  col: ColumnMeta; tableId: string; onSaved: () => void; onCancel: () => void
}) {
  const idRef = useRef(0)
  const newId = () => `o_${++idRef.current}`

  const [label, setLabel] = useState(col.label)
  const [options, setOptions] = useState<OptionDef[]>(() =>
    (col.options ?? []).map((o, i) =>
      typeof o === 'string'
        ? { id: `opt_${i}`, label: o, color: OPTION_COLORS[i % 10].hex, order: i }
        : (o as OptionDef)
    )
  )
  const [optDraft, setOptDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const hasOpts = col.ui_type === 'select' || col.ui_type === 'multi_select'

  function addOpt() {
    const v = optDraft.trim()
    if (!v) return
    const color = OPTION_COLORS[options.length % OPTION_COLORS.length].hex
    setOptions([...options, { id: newId(), label: v, color, order: options.length }])
    setOptDraft('')
  }

  function renameOpt(id: string, newLabel: string) {
    setOptions(options.map((o) => (o.uid === id ? { ...o, label: newLabel } : o)))
  }

  function setOptColor(id: string, color: string) {
    setOptions(options.map((o) => (o.uid === id ? { ...o, color } : o)))
  }

  function removeOpt(id: string) {
    setOptions(options.filter((o) => o.uid !== id))
  }

  async function save() {
    setSaving(true)
    setErr(null)
    try {
      await api.tables.updateColumn(tableId, col.key, {
        label: label.trim() || col.label,
        options: hasOpts ? options : undefined,
      })
      onSaved()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="border-t border-zinc-100 bg-zinc-50 px-4 pb-4 pt-3 space-y-3">
      {/* label */}
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-zinc-500">ชื่อ Column</span>
        <input
          autoFocus
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-800 outline-none focus:border-amber-500"
        />
      </label>

      {/* options */}
      {hasOpts && (
        <div>
          <span className="mb-2 block text-xs font-medium text-zinc-500">ตัวเลือก</span>
          <div className="space-y-1.5">
            {options.map((o) => (
              <div key={o.uid} className="flex items-center gap-2">
                {/* color swatch */}
                <ColorPicker color={o.color} onChange={(c) => setOptColor(o.uid, c)} />
                {/* rename input */}
                <input
                  value={o.label}
                  onChange={(e) => renameOpt(o.uid, e.target.value)}
                  className="flex-1 rounded-lg border border-zinc-200 bg-white px-2 py-1 text-sm text-zinc-800 outline-none focus:border-amber-500"
                />
                <button onClick={() => removeOpt(o.uid)} className="text-zinc-300 hover:text-red-500">
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <input
              value={optDraft}
              onChange={(e) => setOptDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addOpt())}
              placeholder="เพิ่มตัวเลือกใหม่…"
              className="flex-1 rounded-lg border border-zinc-200 bg-white px-2 py-1 text-sm text-zinc-800 outline-none focus:border-amber-500 placeholder:text-zinc-400"
            />
            <button onClick={addOpt} className="rounded-lg bg-zinc-100 px-3 text-xs text-zinc-700 hover:bg-zinc-200">
              + เพิ่ม
            </button>
          </div>
        </div>
      )}

      {err && <p className="text-xs text-red-600">{err}</p>}

      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onCancel} className="rounded-lg px-3 py-1.5 text-xs text-zinc-500 hover:bg-zinc-200">
          ยกเลิก
        </button>
        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-1 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
        >
          <Check size={12} /> {saving ? 'กำลังบันทึก…' : 'บันทึก'}
        </button>
      </div>
    </div>
  )
}

// ── Color picker ──────────────────────────────────────────────────────────────

function ColorPicker({ color, onChange }: { color: string; onChange: (c: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative shrink-0">
      <button
        className="h-5 w-5 rounded-full border-2 border-white shadow ring-1 ring-zinc-200 transition hover:scale-110"
        style={{ background: color }}
        onClick={() => setOpen((o) => !o)}
      />
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-7 z-40 flex flex-wrap gap-1 rounded-lg border border-zinc-200 bg-white p-2 shadow-xl" style={{ width: 130 }}>
            {OPTION_COLORS.map((c) => (
              <button
                key={c.hex}
                title={c.name}
                className="h-5 w-5 rounded-full transition hover:scale-110"
                style={{ background: c.hex }}
                onClick={() => { onChange(c.hex); setOpen(false) }}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
