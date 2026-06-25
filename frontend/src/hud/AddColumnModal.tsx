import { Plus, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ColumnMeta, ColumnMetaIn, ColumnUiType, FormulaDef, OptionDef } from '../types'
import { COLUMN_TYPE_LABELS, FORMULA_KINDS, FORMULA_OPS, SELECTABLE_TYPES } from '../lib/columnTypes'
import { OPTION_COLORS } from '../lib/optionColors'

interface Props {
  existing: ColumnMeta[]
  onCancel: () => void
  onSubmit: (body: ColumnMetaIn) => void
}

export function AddColumnModal({ existing, onCancel, onSubmit }: Props) {
  const [label, setLabel] = useState('')
  const [type, setType] = useState<ColumnUiType>('text')
  const [options, setOptions] = useState<OptionDef[]>([])
  const [optDraft, setOptDraft] = useState('')

  // Formula state — expanded
  const [formulaKind, setFormulaKind] = useState<string>('math')
  const [formulaOp, setFormulaOp] = useState<string>('+')
  const [operands, setOperands] = useState<string[]>(['', ''])

  const needsOptions = type === 'select' || type === 'multi_select'
  const isFormula = type === 'formula'

  const currentOps = FORMULA_OPS[formulaKind] ?? []
  const currentOpDef = currentOps.find((o) => o.id === formulaOp) ?? currentOps[0]
  const maxOps = currentOpDef?.maxOps ?? 2

  // column sources for operand dropdowns
  const dateCols = useMemo(() => existing.filter((c) => c.ui_type === 'date'), [existing])
  const numCols = useMemo(() => existing.filter((c) => c.ui_type === 'number'), [existing])
  const allCols = existing

  function colsForKind(kind: string, opId: string) {
    if (kind === 'date') {
      if (opId === 'date_diff') return dateCols
      // date_add_*: first operand = date, second = number
      return dateCols  // index 0; caller checks index
    }
    if (kind === 'aggregate' || kind === 'math' || kind === 'percentage') return numCols
    return allCols
  }

  function getColSource(kind: string, opId: string, opIndex: number): ColumnMeta[] {
    if (kind === 'date' && opId !== 'date_diff' && opIndex === 1) return numCols
    return colsForKind(kind, opId)
  }

  function addOption() {
    const v = optDraft.trim()
    if (!v || options.some((o) => o.label === v)) return
    const color = OPTION_COLORS[options.length % OPTION_COLORS.length].hex
    setOptions([...options, { uid: Math.random().toString(36).slice(2, 10), label: v, color, order: options.length }])
    setOptDraft('')
  }

  function removeOption(id: string) {
    setOptions(options.filter((o) => o.uid !== id))
  }

  function setOptionColor(id: string, color: string) {
    setOptions(options.map((o) => (o.uid === id ? { ...o, color } : o)))
  }

  function setOperand(i: number, val: string) {
    setOperands((prev) => {
      const next = [...prev]
      next[i] = val
      return next
    })
  }

  function addOperand() {
    if (operands.length < maxOps) setOperands([...operands, ''])
  }

  function removeOperand(i: number) {
    if (operands.length <= 2) return
    setOperands(operands.filter((_, idx) => idx !== i))
  }

  function canSubmit(): boolean {
    if (!label.trim()) return false
    if (needsOptions && options.length === 0) return false
    if (isFormula && operands.some((o) => !o)) return false
    return true
  }

  function submit() {
    const body: ColumnMetaIn = { label: label.trim(), ui_type: type }
    if (needsOptions) body.options = options
    if (isFormula) {
      const formula: FormulaDef = {
        kind: formulaKind as NonNullable<FormulaDef['kind']>,
        op: formulaOp,
        operands,
      }
      body.formula = formula
    }
    onSubmit(body)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3">
          <h2 className="font-bold text-zinc-800">เพิ่มคอลัมน์ใหม่</h2>
          <button onClick={onCancel} className="text-zinc-400 hover:text-zinc-700"><X size={16} /></button>
        </div>

        <div className="flex-1 space-y-5 overflow-auto p-5">
          {/* label */}
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-zinc-600">ชื่อคอลัมน์</span>
            <input
              autoFocus
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="เช่น ชื่อสินค้า"
              className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-zinc-800 outline-none placeholder:text-zinc-500 focus:border-amber-500"
            />
          </label>

          {/* type picker */}
          <div>
            <span className="mb-2 block text-sm font-medium text-zinc-600">ชนิดข้อมูล</span>
            <div className="grid grid-cols-2 gap-2">
              {SELECTABLE_TYPES.map((t) => {
                const info = COLUMN_TYPE_LABELS[t]
                const sel = type === t
                return (
                  <button
                    key={t}
                    onClick={() => setType(t)}
                    className={`flex items-start gap-2 rounded-lg border p-2.5 text-left transition ${
                      sel ? 'border-amber-500 bg-amber-50 ring-1 ring-amber-400' : 'border-zinc-200 hover:border-zinc-300'
                    }`}
                  >
                    <info.Icon size={20} className="shrink-0" />
                    <span>
                      <span className="block text-sm font-medium text-zinc-800">{info.label}</span>
                      <span className="block text-[11px] leading-tight text-zinc-500">{info.description}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* option editor with colors */}
          {needsOptions && (
            <div>
              <span className="mb-1 block text-sm font-medium text-zinc-600">ตัวเลือก</span>
              <div className="mb-2 space-y-1.5">
                {options.map((o) => (
                  <div key={o.uid} className="flex items-center gap-2">
                    {/* color picker */}
                    <div className="relative flex shrink-0 flex-wrap gap-1">
                      <button
                        className="h-5 w-5 rounded-full border border-white/20 shadow-sm ring-1 ring-zinc-200"
                        style={{ background: o.color }}
                        onClick={() => {
                          const el = document.getElementById(`cp-${o.uid}`)
                          el?.classList.toggle('hidden')
                        }}
                      />
                      <div id={`cp-${o.uid}`} className="absolute left-0 top-7 z-10 hidden flex-wrap gap-1 rounded-lg border border-zinc-200 bg-white p-2 shadow-xl">
                        {OPTION_COLORS.map((c) => (
                          <button
                            key={c.hex}
                            title={c.name}
                            className="h-5 w-5 rounded-full border-2 border-white/30 hover:scale-110"
                            style={{ background: c.hex }}
                            onClick={() => {
                              setOptionColor(o.uid, c.hex)
                              document.getElementById(`cp-${o.uid}`)?.classList.add('hidden')
                            }}
                          />
                        ))}
                      </div>
                    </div>
                    <span
                      className="rounded-full px-2.5 py-0.5 text-xs font-medium text-white"
                      style={{ background: o.color }}
                    >
                      {o.label}
                    </span>
                    <button onClick={() => removeOption(o.uid)} className="ml-auto text-zinc-300 hover:text-red-500">
                      <X size={13} />
                    </button>
                  </div>
                ))}
                {options.length === 0 && <span className="text-xs text-zinc-400">ยังไม่มีตัวเลือก</span>}
              </div>
              <div className="flex gap-2">
                <input
                  value={optDraft}
                  onChange={(e) => setOptDraft(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addOption())}
                  placeholder="พิมพ์ตัวเลือกแล้วกด Enter"
                  className="flex-1 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-800 outline-none placeholder:text-zinc-500 focus:border-amber-500"
                />
                <button onClick={addOption} className="rounded-lg bg-zinc-100 px-3 text-sm font-medium text-zinc-700 hover:bg-zinc-200">
                  เพิ่ม
                </button>
              </div>
            </div>
          )}

          {/* formula builder */}
          {isFormula && (
            <div className="space-y-3 rounded-lg bg-zinc-50 p-3">
              {/* kind selector */}
              <div>
                <span className="mb-1 block text-sm font-medium text-zinc-600">หมวดสูตร</span>
                <div className="flex flex-wrap gap-2">
                  {FORMULA_KINDS.map((k) => (
                    <button
                      key={k.id}
                      onClick={() => {
                        setFormulaKind(k.id)
                        const firstOp = FORMULA_OPS[k.id]?.[0]
                        if (firstOp) { setFormulaOp(firstOp.id); setOperands(['', '']) }
                      }}
                      className={`rounded-lg border px-3 py-1.5 text-sm ${
                        formulaKind === k.id
                          ? 'border-amber-500 bg-amber-50 font-medium text-amber-700'
                          : 'border-zinc-200 text-zinc-600 hover:border-zinc-300'
                      }`}
                    >
                      {k.icon} {k.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* op selector */}
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-zinc-600">ประเภทสูตร</span>
                <select
                  value={formulaOp}
                  onChange={(e) => { setFormulaOp(e.target.value); setOperands(['', '']) }}
                  className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-800 outline-none focus:border-amber-500"
                >
                  {(FORMULA_OPS[formulaKind] ?? []).map((o) => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                  ))}
                </select>
              </label>

              {/* operands */}
              <div>
                <span className="mb-1 block text-sm font-medium text-zinc-600">คอลัมน์ที่ใช้คำนวณ</span>
                <div className="space-y-2">
                  {operands.map((op, i) => {
                    const src = getColSource(formulaKind, formulaOp, i)
                    const opDef = currentOps.find((o) => o.id === formulaOp)
                    const lbl = opDef?.operandsLabel[Math.min(i, (opDef?.operandsLabel.length ?? 1) - 1)] ?? `คอลัมน์ ${i + 1}`
                    return (
                      <div key={i} className="flex items-center gap-2">
                        <span className="w-28 shrink-0 text-xs text-zinc-500">{lbl}</span>
                        <select
                          value={op}
                          onChange={(e) => setOperand(i, e.target.value)}
                          className="flex-1 rounded-lg border border-zinc-300 px-2 py-1.5 text-sm text-zinc-800 outline-none focus:border-amber-500"
                        >
                          <option value="">— เลือก —</option>
                          {src.map((c) => (
                            <option key={c.key} value={c.key}>{c.label}</option>
                          ))}
                        </select>
                        {operands.length > 2 && (
                          <button onClick={() => removeOperand(i)} className="text-zinc-300 hover:text-red-400">
                            <X size={13} />
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
                {maxOps > 2 && operands.length < maxOps && (
                  <button
                    onClick={addOperand}
                    className="mt-2 flex items-center gap-1 text-xs text-amber-700 hover:underline"
                  >
                    <Plus size={12} /> เพิ่มคอลัมน์
                  </button>
                )}
              </div>

              {dateCols.length === 0 && formulaKind === 'date' && (
                <p className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-700">
                  ต้องมีคอลัมน์วันที่ก่อนถึงจะสร้างสูตรได้
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-zinc-200 px-5 py-3">
          <button onClick={onCancel} className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100">
            ยกเลิก
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit()}
            className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white shadow disabled:opacity-40"
          >
            เพิ่มคอลัมน์
          </button>
        </div>
      </div>
    </div>
  )
}
