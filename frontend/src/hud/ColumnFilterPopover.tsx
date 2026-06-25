import * as Popover from '@radix-ui/react-popover'
import { X } from 'lucide-react'
import { useState } from 'react'
import type { ColumnMeta } from '../types'

export interface FilterSpec {
  op: string
  val?: string
  from?: string
  to?: string
}

interface Props {
  column: ColumnMeta
  filter: FilterSpec | null
  onApply: (spec: FilterSpec | null) => void
}

const TEXT_OPS = [
  { id: 'contains', label: 'มี (contains)' },
  { id: 'equals',   label: 'ตรงกับ (equals)' },
  { id: 'empty',    label: 'ว่างเปล่า' },
]

const NUM_OPS = [
  { id: 'eq',      label: '= เท่ากับ' },
  { id: 'gt',      label: '> มากกว่า' },
  { id: 'lt',      label: '< น้อยกว่า' },
  { id: 'between', label: 'ระหว่าง' },
]

export function ColumnFilterPopover({ column, filter, onApply }: Props) {
  const [open, setOpen] = useState(false)
  const isDate = column.ui_type === 'date' || column.ui_type === 'datetime'
  const isNumber = column.ui_type === 'number'
  const isText = column.ui_type === 'text' || column.ui_type === 'select'
  const hasFilter = filter !== null

  // local state
  const [op, setOp] = useState(filter?.op ?? (isDate ? 'range' : isNumber ? 'eq' : 'contains'))
  const [val, setVal] = useState(filter?.val ?? '')
  const [from, setFrom] = useState(filter?.from ?? '')
  const [to, setTo] = useState(filter?.to ?? '')

  function apply() {
    if (isDate) {
      if (!from && !to) { onApply(null); setOpen(false); return }
      onApply({ op: 'range', from: from || to, to: to || from })
    } else if (isNumber && op === 'between') {
      if (!from && !to) { onApply(null); setOpen(false); return }
      onApply({ op: 'between', from, to })
    } else if (op === 'empty') {
      onApply({ op: 'empty' })
    } else {
      if (!val.trim()) { onApply(null); setOpen(false); return }
      onApply({ op, val: val.trim() })
    }
    setOpen(false)
  }

  function clear() {
    setOp(isDate ? 'range' : isNumber ? 'eq' : 'contains')
    setVal(''); setFrom(''); setTo('')
    onApply(null)
    setOpen(false)
  }

  // Quick presets for dates (sets from/to as ISO date strings)
  function preset(days: number) {
    const end = new Date()
    const start = new Date()
    start.setDate(start.getDate() - days)
    setFrom(start.toISOString().slice(0, 10))
    setTo(end.toISOString().slice(0, 10))
  }
  function presetMonth() {
    const now = new Date()
    const start = new Date(now.getFullYear(), now.getMonth(), 1)
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0)
    setFrom(start.toISOString().slice(0, 10))
    setTo(end.toISOString().slice(0, 10))
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            onClick={(e) => e.stopPropagation()}
            className={`flex shrink-0 items-center justify-center rounded p-1.5 transition ${
              hasFilter
                ? 'bg-amber-100 text-amber-600 hover:bg-amber-200'
                : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600'
            }`}
            title={hasFilter ? 'กำลังกรองข้อมูลอยู่ — คลิกเพื่อแก้ไข' : 'กรองข้อมูลคอลัมน์นี้'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
              <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
            </svg>
            {hasFilter && <span className="ml-0.5 h-1.5 w-1.5 rounded-full bg-amber-500" />}
          </button>
        </Popover.Trigger>

        <Popover.Portal>
          <Popover.Content
            side="bottom" align="end" sideOffset={4}
            className="z-50 w-64 rounded-xl border border-zinc-200 bg-white p-3 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold text-zinc-600">กรอง: {column.label}</span>
              <Popover.Close className="rounded p-0.5 text-zinc-400 hover:text-zinc-600"><X size={13} /></Popover.Close>
            </div>

            {isDate ? (
              <div className="space-y-2">
                {/* Quick presets */}
                <div className="flex flex-wrap gap-1">
                  {[
                    { label: '7 วันที่ผ่านมา', fn: () => preset(7) },
                    { label: 'เดือนนี้', fn: presetMonth },
                    { label: '30 วัน', fn: () => preset(30) },
                  ].map((p) => (
                    <button key={p.label} onClick={p.fn}
                      className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-600 hover:bg-amber-100 hover:text-amber-700">
                      {p.label}
                    </button>
                  ))}
                </div>
                {/* Date range: two native date inputs */}
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="mb-1 block text-[11px] text-zinc-500">ตั้งแต่วันที่</span>
                    <input
                      type="date" value={from} onChange={(e) => setFrom(e.target.value)}
                      className="w-full rounded-lg border border-zinc-200 px-2 py-1.5 text-xs text-zinc-800 outline-none focus:border-amber-500"
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-[11px] text-zinc-500">ถึงวันที่</span>
                    <input
                      type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)}
                      className="w-full rounded-lg border border-zinc-200 px-2 py-1.5 text-xs text-zinc-800 outline-none focus:border-amber-500"
                    />
                  </label>
                </div>
              </div>
            ) : isNumber ? (
              <div className="space-y-2">
                <select value={op} onChange={(e) => setOp(e.target.value)}
                  className="w-full rounded-lg border border-zinc-200 px-2 py-1.5 text-xs text-zinc-700 outline-none">
                  {NUM_OPS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                </select>
                {op === 'between' ? (
                  <div className="flex gap-2">
                    <input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="จาก" type="number"
                      className="w-full rounded-lg border border-zinc-200 px-2 py-1.5 text-xs text-zinc-800 outline-none focus:border-amber-500" />
                    <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="ถึง" type="number"
                      className="w-full rounded-lg border border-zinc-200 px-2 py-1.5 text-xs text-zinc-800 outline-none focus:border-amber-500" />
                  </div>
                ) : op !== 'empty' ? (
                  <input value={val} onChange={(e) => setVal(e.target.value)} placeholder="ค่า" type="number"
                    className="w-full rounded-lg border border-zinc-200 px-2 py-1.5 text-xs text-zinc-800 outline-none focus:border-amber-500" />
                ) : null}
              </div>
            ) : isText ? (
              <div className="space-y-2">
                <select value={op} onChange={(e) => setOp(e.target.value)}
                  className="w-full rounded-lg border border-zinc-200 px-2 py-1.5 text-xs text-zinc-700 outline-none">
                  {TEXT_OPS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                </select>
                {op !== 'empty' && (
                  <input value={val} onChange={(e) => setVal(e.target.value)} placeholder="ค้นหา…"
                    className="w-full rounded-lg border border-zinc-200 px-2 py-1.5 text-xs text-zinc-800 outline-none placeholder:text-zinc-400 focus:border-amber-500" />
                )}
              </div>
            ) : (
              <p className="text-xs text-zinc-400">ไม่รองรับการกรองคอลัมน์ประเภทนี้</p>
            )}

            <div className="mt-3 flex gap-2">
              {hasFilter && (
                <button onClick={clear}
                  className="flex-1 rounded-lg border border-zinc-200 py-1.5 text-xs text-zinc-600 hover:bg-zinc-50">ล้าง</button>
              )}
              <button onClick={apply}
                className="flex-1 rounded-lg bg-amber-600 py-1.5 text-xs font-medium text-white hover:bg-amber-700">ใช้ Filter</button>
            </div>
          </Popover.Content>
        </Popover.Portal>
    </Popover.Root>
  )
}
