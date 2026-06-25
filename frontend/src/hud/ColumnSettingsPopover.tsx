import { Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { ColumnMeta } from '../types'
import { COLUMN_TYPE_LABELS } from '../lib/columnTypes'

interface Props {
  column: ColumnMeta
  onClose: () => void
  onSave: (patch: { label?: string; options?: string[] }) => void
  onDelete: () => void
}

/** Inline popover shown when a column header is clicked. Rename, edit select options,
 * or delete the column. The data type cannot be changed after creation. */
export function ColumnSettingsPopover({ column, onClose, onSave, onDelete }: Props) {
  const [label, setLabel] = useState(column.label)
  const [options, setOptions] = useState<string[]>(
    (column.options ?? []).map((o) => (typeof o === 'string' ? o : o.label)),
  )
  const [optDraft, setOptDraft] = useState('')
  const hasOptions = column.ui_type === 'select' || column.ui_type === 'multi_select'
  const info = COLUMN_TYPE_LABELS[column.ui_type]

  function addOption() {
    const v = optDraft.trim()
    if (v && !options.includes(v)) setOptions([...options, v])
    setOptDraft('')
  }

  function save() {
    onSave({ label: label.trim() || column.label, options: hasOptions ? options : undefined })
  }

  return (
    <>
      {/* click-away backdrop */}
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div className="absolute left-0 top-full z-40 mt-1 w-64 rounded-lg border border-zinc-200 bg-white p-3 shadow-xl">
        <div className="mb-2 flex items-center gap-1.5 text-[11px] text-zinc-400">
          <info.Icon size={12} /> {info.label}
        </div>

        <input
          autoFocus
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="mb-3 w-full rounded border border-zinc-300 px-2 py-1.5 text-sm text-zinc-800 outline-none focus:border-amber-500"
        />

        {hasOptions && (
          <div className="mb-3">
            <div className="mb-1.5 flex flex-wrap gap-1">
              {options.map((o) => (
                <span
                  key={o}
                  className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] text-amber-800"
                >
                  {o}
                  <button
                    onClick={() => setOptions(options.filter((x) => x !== o))}
                    className="text-amber-500 hover:text-amber-800"
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-1">
              <input
                value={optDraft}
                onChange={(e) => setOptDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addOption())}
                placeholder="เพิ่มตัวเลือก"
                className="min-w-0 flex-1 rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-800 outline-none placeholder:text-zinc-500 focus:border-amber-500"
              />
              <button
                onClick={addOption}
                className="rounded bg-zinc-100 px-2 text-xs text-zinc-700 hover:bg-zinc-200"
              >
                +
              </button>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-2">
          <button
            onClick={onDelete}
            className="rounded px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
          >
            <Trash2 size={13} /> ลบคอลัมน์
          </button>
          <button
            onClick={save}
            className="rounded bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-700"
          >
            บันทึก
          </button>
        </div>
      </div>
    </>
  )
}
