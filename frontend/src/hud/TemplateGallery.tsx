import { ArrowLeft, Plus, X } from 'lucide-react'
import { useState } from 'react'
import { TABLE_PRESETS } from '../lib/tablePresets'
import type { TablePreset } from '../lib/tablePresets'
import { COLUMN_TYPE_LABELS } from '../lib/columnTypes'
import type { ColumnMetaIn, ColumnUiType } from '../types'

interface Props {
  onCancel: () => void
  onCreate: (name: string, preset: TablePreset) => void
  creating: boolean
}

type Step = 'pick' | 'columns'

/**
 * Two-step flow:
 *  Step 1 — ตั้งชื่อ + เลือก template
 *  Step 2 — ตรวจ/แก้ไข column list ก่อนสร้าง (ทั้ง blank และ preset)
 */
export function TemplateGallery({ onCancel, onCreate, creating }: Props) {
  const [step, setStep] = useState<Step>('pick')
  const [name, setName] = useState('')
  const [selectedId, setSelectedId] = useState('blank')
  // editable column list built from selected preset (user may add/remove)
  const [columns, setColumns] = useState<ColumnMetaIn[]>([])

  function goToColumns() {
    const preset = TABLE_PRESETS.find((p) => p.id === selectedId)!
    setColumns(preset.columns.map((c) => ({ ...c })))  // deep clone
    setStep('columns')
  }

  function addColumn() {
    setColumns([...columns, { label: '', ui_type: 'text' as ColumnUiType }])
  }

  function updateColumn(i: number, patch: Partial<ColumnMetaIn>) {
    setColumns(columns.map((c, idx) => (idx === i ? { ...c, ...patch } : c)))
  }

  function removeColumn(i: number) {
    setColumns(columns.filter((_, idx) => idx !== i))
  }

  function handleCreate() {
    const preset = TABLE_PRESETS.find((p) => p.id === selectedId)!
    // override preset columns with user's edited list (filter empty labels)
    const final: TablePreset = { ...preset, columns: columns.filter((c) => c.label.trim()) }
    onCreate(name.trim() || 'ตารางใหม่', final)
  }

  // ── Step 1: pick ────────────────────────────────────────────────────────────
  if (step === 'pick') {
    return (
      <div className="flex h-full flex-col items-center justify-center p-8">
        <div className="w-full max-w-2xl">
          <h2 className="mb-1 text-xl font-bold text-zinc-800">สร้างตารางใหม่</h2>
          <p className="mb-5 text-sm text-zinc-500">ตั้งชื่อตาราง แล้วเลือกแม่แบบเริ่มต้น</p>

          <label className="mb-6 block">
            <span className="mb-1 block text-sm font-medium text-zinc-600">ชื่อตาราง</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && goToColumns()}
              placeholder="เช่น ตารางลงคลิป มิถุนายน"
              className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-zinc-800 outline-none placeholder:text-zinc-500 focus:border-amber-500"
            />
          </label>

          <span className="mb-2 block text-sm font-medium text-zinc-600">เลือกแม่แบบ</span>
          <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {TABLE_PRESETS.map((p) => {
              const sel = selectedId === p.id
              return (
                <button
                  key={p.id}
                  onClick={() => setSelectedId(p.id)}
                  onDoubleClick={goToColumns}
                  className={`rounded-xl border p-4 text-left transition ${
                    sel ? 'border-amber-500 bg-amber-50 ring-1 ring-amber-400' : 'border-zinc-200 bg-white hover:border-zinc-300'
                  }`}
                >
                  <p.Icon size={24} className="mb-1 text-zinc-600" />
                  <div className="mb-1 font-semibold text-zinc-800">{p.name}</div>
                  <div className="mb-2 text-xs leading-snug text-zinc-500">{p.description}</div>
                  {p.columns.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {p.columns.slice(0, 4).map((c) => (
                        <span key={c.label} className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-600">
                          {c.label}
                        </span>
                      ))}
                      {p.columns.length > 4 && (
                        <span className="px-1 text-[10px] text-zinc-400">+{p.columns.length - 4}</span>
                      )}
                    </div>
                  ) : (
                    <span className="text-[11px] text-zinc-400">เพิ่ม column เองได้ในขั้นต่อไป</span>
                  )}
                </button>
              )
            })}
          </div>

          <div className="flex justify-end gap-2">
            <button onClick={onCancel} className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100">
              ยกเลิก
            </button>
            <button
              onClick={goToColumns}
              className="rounded-lg bg-amber-600 px-5 py-2 text-sm font-medium text-white shadow hover:bg-amber-500"
            >
              ถัดไป →
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Step 2: columns ─────────────────────────────────────────────────────────
  return (
    <div className="flex h-full flex-col items-center justify-start overflow-auto p-8">
      <div className="w-full max-w-xl">
        <button
          onClick={() => setStep('pick')}
          className="mb-4 flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-700"
        >
          <ArrowLeft size={14} /> กลับ
        </button>

        <h2 className="mb-1 text-xl font-bold text-zinc-800">{name || 'ตารางใหม่'}</h2>
        <p className="mb-5 text-sm text-zinc-500">
          เพิ่ม / ลบ / ตั้งชื่อ column ที่ต้องการ แล้วกด "สร้างตาราง"
        </p>

        {/* column list */}
        <div className="mb-3 space-y-2">
          {columns.length === 0 && (
            <p className="rounded-lg border border-dashed border-zinc-300 py-6 text-center text-sm text-zinc-400">
              ยังไม่มี column — กด "+ เพิ่ม Column" ด้านล่าง
            </p>
          )}
          {columns.map((col, i) => (
            <div key={i} className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2">
              {/* label */}
              <input
                value={col.label}
                onChange={(e) => updateColumn(i, { label: e.target.value })}
                placeholder="ชื่อ column…"
                className="flex-1 bg-transparent text-sm text-zinc-800 outline-none placeholder:text-zinc-400"
              />
              {/* type selector */}
              <select
                value={col.ui_type}
                onChange={(e) => updateColumn(i, { ui_type: e.target.value as ColumnUiType })}
                className="rounded border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs text-zinc-600 outline-none"
              >
                {(Object.keys(COLUMN_TYPE_LABELS) as ColumnUiType[]).map((t) => (
                  <option key={t} value={t}>{COLUMN_TYPE_LABELS[t].label}</option>
                ))}
              </select>
              <button onClick={() => removeColumn(i)} className="shrink-0 text-zinc-400 hover:text-red-500">
                <X size={14} />
              </button>
            </div>
          ))}
        </div>

        <button
          onClick={addColumn}
          className="mb-6 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-zinc-300 py-2 text-sm text-zinc-500 hover:border-amber-400 hover:text-amber-700"
        >
          <Plus size={14} /> เพิ่ม Column
        </button>

        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100">
            ยกเลิก
          </button>
          <button
            onClick={handleCreate}
            disabled={creating}
            className="rounded-lg bg-amber-600 px-5 py-2 text-sm font-medium text-white shadow disabled:opacity-40 hover:bg-amber-500"
          >
            {creating ? 'กำลังสร้าง…' : 'สร้างตาราง'}
          </button>
        </div>
      </div>
    </div>
  )
}
