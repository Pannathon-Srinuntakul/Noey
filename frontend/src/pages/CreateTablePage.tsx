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
import { ArrowLeft, Check, GripVertical, Plus, Trash2, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, formatUserError } from '../api'
import { AddColumnModal } from '../hud/AddColumnModal'
import { COLUMN_TYPE_LABELS } from '../lib/columnTypes'
import { OPTION_COLORS } from '../lib/optionColors'
import { TABLE_PRESETS } from '../lib/tablePresets'
import type { ColumnMeta, ColumnMetaIn, ColumnUiType, OptionDef } from '../types'

/** Each item in the local column list — has a stable local id for DnD */
interface LocalCol extends ColumnMetaIn {
  _lid: string  // local-only id for DnD key
}

function newLid() {
  return Math.random().toString(36).slice(2, 10)
}

/** Convert local col list → ColumnMeta[] so AddColumnModal knows existing columns + keys */
function toColumnMeta(cols: LocalCol[]): ColumnMeta[] {
  return cols.map((c, i) => ({
    key: `col_${i + 1}`,
    label: c.label,
    ui_type: c.ui_type as ColumnMeta['ui_type'],
    options: c.options,
    formula: c.formula ?? null,
    seq: i + 1,
    width: c.width ?? 160,
  }))
}

export default function CreateTablePage() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [columns, setColumns] = useState<LocalCol[]>([])
  const [adding, setAdding] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  function applyPreset(id: string) {
    const preset = TABLE_PRESETS.find((p) => p.id === id)
    if (!preset) return
    setColumns(preset.columns.map((c) => ({ ...c, _lid: newLid() })))
  }

  function addColumnFromModal(body: ColumnMetaIn) {
    setColumns((prev) => [...prev, { ...body, _lid: newLid() }])
    setAdding(false)
  }

  function removeColumn(lid: string) {
    setColumns((prev) => prev.filter((c) => c._lid !== lid))
  }

  function updateColumn(lid: string, patch: Partial<ColumnMetaIn>) {
    setColumns((prev) => prev.map((c) => (c._lid === lid ? { ...c, ...patch } : c)))
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIdx = columns.findIndex((c) => c._lid === active.id)
    const newIdx = columns.findIndex((c) => c._lid === over.id)
    if (oldIdx < 0 || newIdx < 0) return
    const reordered = [...columns]
    const [moved] = reordered.splice(oldIdx, 1)
    reordered.splice(newIdx, 0, moved)
    setColumns(reordered)
  }

  async function create() {
    setCreating(true)
    setError(null)
    try {
      const table = await api.tables.create(name.trim() || 'ตารางใหม่')
      for (const col of columns.filter((c) => c.label.trim())) {
        await api.tables.addColumn(table.uid, col)
      }
      navigate(`/tables/${table.uid}`)
    } catch (e) {
      setError(formatUserError(e))
      setCreating(false)
    }
  }

  return (
    <div className="scroll-light flex h-full flex-col bg-zinc-50">
      {/* header */}
      <div className="flex items-center gap-2 border-b border-zinc-200 bg-white px-4 py-3 shadow-sm sm:gap-3 sm:px-5">
        <button
          onClick={() => navigate('/tables')}
          className="flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-zinc-500 hover:bg-zinc-100"
        >
          <ArrowLeft size={15} /> กลับ
        </button>
        <div className="flex-1">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="ชื่อตาราง…"
            className="w-full bg-transparent text-lg font-bold text-zinc-800 outline-none placeholder:font-normal placeholder:text-zinc-400"
          />
        </div>
        <button
          onClick={create}
          disabled={creating}
          className="flex shrink-0 items-center gap-1.5 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white shadow disabled:opacity-40 hover:bg-amber-700"
        >
          <Check size={14} /> {creating ? 'กำลังสร้าง…' : 'สร้างตาราง'}
        </button>
      </div>

      {error && (
        <div className="flex items-center justify-between bg-red-50 px-5 py-2 text-sm text-red-700">
          <span>{error}</span>
          <button onClick={() => setError(null)}><X size={14} /></button>
        </div>
      )}

      <div className="flex-1 overflow-auto p-4 sm:p-5">
        {/* template picker */}
        <div className="mb-5">
          <p className="mb-2 text-xs font-medium text-zinc-500">เริ่มจากแม่แบบ</p>
          <div className="flex flex-wrap gap-2">
            {TABLE_PRESETS.map((p) => (
              <button
                key={p.id}
                onClick={() => applyPreset(p.id)}
                className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-600 shadow-sm hover:border-amber-400 hover:text-amber-700"
              >
                <p.Icon size={14} />
                {p.name}
              </button>
            ))}
          </div>
        </div>

        {/* column list — same UI as ManageFieldsPage */}
        <p className="mb-2 text-xs font-medium text-zinc-500">
          Columns · {columns.length} รายการ · ลากเพื่อจัดลำดับ
        </p>

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={columns.map((c) => c._lid)} strategy={verticalListSortingStrategy}>
            <div className={`mb-3 ${columns.length > 0 ? 'overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm' : ''}`}>
              {columns.map((col, idx) => (
                <LocalField
                  key={col._lid}
                  col={col}
                  isLast={idx === columns.length - 1}
                  onChange={(patch) => updateColumn(col._lid, patch)}
                  onDelete={() => removeColumn(col._lid)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>

        {columns.length === 0 && (
          <div className="mb-3 rounded-xl border border-dashed border-zinc-300 py-8 text-center text-sm text-zinc-400">
            ยังไม่มี Column — เลือกแม่แบบด้านบน หรือกด "+ เพิ่ม Column"
          </div>
        )}

        <button
          onClick={() => setAdding(true)}
          className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-zinc-300 py-2.5 text-sm text-zinc-500 hover:border-amber-400 hover:text-amber-700"
        >
          <Plus size={14} /> เพิ่ม Column
        </button>
      </div>

      {adding && (
        <AddColumnModal
          existing={toColumnMeta(columns)}
          onCancel={() => setAdding(false)}
          onSubmit={addColumnFromModal}
        />
      )}
    </div>
  )
}

// ── Local field row (same look as SortableField in ManageFieldsPage) ──────────

function LocalField({
  col,
  isLast,
  onChange,
  onDelete,
}: {
  col: LocalCol
  isLast: boolean
  onChange: (patch: Partial<ColumnMetaIn>) => void
  onDelete: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: col._lid })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }
  const [open, setOpen] = useState(false)
  const info = COLUMN_TYPE_LABELS[col.ui_type as ColumnUiType] ?? COLUMN_TYPE_LABELS.text

  return (
    <div ref={setNodeRef} style={style} className={`group ${!isLast ? 'border-b border-zinc-100' : ''}`}>
      <div
        className={`flex cursor-pointer items-center gap-2 px-3 py-2.5 transition ${open ? 'bg-amber-50' : 'hover:bg-zinc-50'}`}
        onClick={() => col.ui_type !== 'formula' && setOpen((o) => !o)}
      >
        <button
          {...attributes}
          {...listeners}
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 cursor-grab text-zinc-400 opacity-0 transition-opacity group-hover:opacity-100 hover:text-zinc-600 active:cursor-grabbing"
        >
          <GripVertical size={16} />
        </button>
        <info.Icon size={14} className="shrink-0 text-zinc-500" />
        <span className="flex-1 truncate text-sm font-medium text-zinc-700">
          {col.label || <span className="text-zinc-400">ไม่มีชื่อ</span>}
        </span>
        <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-500">{info.label}</span>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete() }}
          className="shrink-0 rounded p-1 text-zinc-400 opacity-0 transition hover:text-red-500 group-hover:opacity-100"
        >
          <Trash2 size={14} />
        </button>
      </div>

      {open && col.ui_type !== 'formula' && (
        <LocalFieldEdit col={col} onChange={onChange} onClose={() => setOpen(false)} />
      )}
    </div>
  )
}

function LocalFieldEdit({
  col,
  onChange,
  onClose,
}: {
  col: LocalCol
  onChange: (patch: Partial<ColumnMetaIn>) => void
  onClose: () => void
}) {
  const idRef = useRef(0)
  const newId = () => `o_${++idRef.current}`
  const [label, setLabel] = useState(col.label)
  const [options, setOptions] = useState<OptionDef[]>(() =>
    (col.options ?? []).map((o, i) =>
      typeof o === 'string'
        ? { uid: `opt_${i}`, label: o, color: OPTION_COLORS[i % 10].hex, order: i }
        : o,
    ),
  )
  const [optDraft, setOptDraft] = useState('')
  const hasOpts = col.ui_type === 'select' || col.ui_type === 'multi_select'

  function addOpt() {
    const v = optDraft.trim()
    if (!v) return
    setOptions([...options, { uid: newId(), label: v, color: OPTION_COLORS[options.length % 10].hex, order: options.length }])
    setOptDraft('')
  }

  function save() {
    onChange({ label: label.trim() || col.label, options: hasOpts ? options : col.options })
    onClose()
  }

  return (
    <div className="border-t border-zinc-100 bg-zinc-50 px-4 pb-3 pt-2 space-y-2.5">
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-zinc-500">ชื่อ Column</span>
        <input
          autoFocus
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-800 outline-none focus:border-amber-500"
        />
      </label>

      {hasOpts && (
        <div>
          <span className="mb-1.5 block text-xs font-medium text-zinc-500">ตัวเลือก</span>
          <div className="space-y-1.5">
            {options.map((o) => (
              <div key={o.uid} className="flex items-center gap-2">
                <ColorSwatch color={o.color} onChange={(c) => setOptions(options.map((x) => (x.uid === o.uid ? { ...x, color: c } : x)))} />
                <input
                  value={o.label}
                  onChange={(e) => setOptions(options.map((x) => (x.uid === o.uid ? { ...x, label: e.target.value } : x)))}
                  className="flex-1 rounded border border-zinc-200 bg-white px-2 py-1 text-sm text-zinc-800 outline-none focus:border-amber-500"
                />
                <button onClick={() => setOptions(options.filter((x) => x.uid !== o.uid))} className="text-zinc-400 hover:text-red-500">
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
          <div className="mt-1.5 flex gap-2">
            <input
              value={optDraft}
              onChange={(e) => setOptDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addOpt())}
              placeholder="เพิ่มตัวเลือก…"
              className="flex-1 rounded-lg border border-zinc-200 bg-white px-2 py-1 text-sm text-zinc-800 outline-none focus:border-amber-500 placeholder:text-zinc-400"
            />
            <button onClick={addOpt} className="rounded-lg bg-zinc-100 px-2 text-xs text-zinc-700 hover:bg-zinc-200">+ เพิ่ม</button>
          </div>
        </div>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs text-zinc-500 hover:bg-zinc-200">ยกเลิก</button>
        <button onClick={save} className="flex items-center gap-1 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white">
          <Check size={12} /> บันทึก
        </button>
      </div>
    </div>
  )
}

function ColorSwatch({ color, onChange }: { color: string; onChange: (c: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative shrink-0">
      <button
        className="h-5 w-5 rounded-full border-2 border-white shadow ring-1 ring-zinc-200 hover:scale-110"
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
                className="h-5 w-5 rounded-full hover:scale-110"
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
