/* eslint-disable react-hooks/set-state-in-effect -- fetch-on-change data loads */
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BarChart2,
  ChevronLeft,
  ChevronRight,
  Download,
  LayoutList,
  Plus,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import type { ColumnMeta, ColumnMetaIn, CustomTableOut, OptionDef, RowsPage, SummaryOut } from '../types'
import { resolveOptionColor, resolveOptionLabel } from '../types'
import { AddColumnModal } from './AddColumnModal'
import { ColumnFilterPopover } from './ColumnFilterPopover'
import type { FilterSpec } from './ColumnFilterPopover'
import { ConfirmModal } from './ConfirmModal'
import { ImportModal } from './ImportModal'

interface Props {
  table: CustomTableOut
  onColumnsChanged: () => void
}

type Tab = 'data' | 'summary'
type SortDir = 'asc' | 'desc'
interface SortState { key: string; dir: SortDir }

const PAGE_SIZES = [20, 50, 100]

export function TableEditor({ table, onColumnsChanged }: Props) {
  const [page, setPage] = useState<RowsPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('data')

  // Reset to data tab whenever the active table changes
  useEffect(() => { setTab('data') }, [table.uid])
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [confirmRowDelete, setConfirmRowDelete] = useState<string | null>(null)
  const [confirmColDelete, setConfirmColDelete] = useState<string | null>(null)
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  const lastSelectedIdx = useRef<number>(-1)
  const [sort, setSort] = useState<SortState | null>(null)
  const [activeFilters, setActiveFilters] = useState<Record<string, FilterSpec>>({})
  const [ghostData, setGhostData] = useState<Record<string, unknown>>({})
  const [pageNum, setPageNum] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [q, setQ] = useState('')
  const [qInput, setQInput] = useState('')  // raw input; q is the debounced value
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const selectCols = useMemo(
    () => table.columns.filter((c) => c.ui_type === 'select'),
    [table.columns],
  )

  const loadRows = useCallback(() => {
    setLoading(true)
    setSelected(new Set())
    const hasFilters = Object.keys(activeFilters).length > 0
    api.tables
      .rows(table.uid, {
        page: pageNum,
        page_size: pageSize,
        sort_by: sort?.key,
        sort_dir: sort?.dir,
        q: q || undefined,
        filters: hasFilters ? JSON.stringify(activeFilters) : undefined,
      })
      .then(setPage)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false))
  }, [table.uid, pageNum, pageSize, sort, q, activeFilters])

  useEffect(() => {
    loadRows()
  }, [loadRows])

  // Reset to page 1 when search/sort/size changes
  useEffect(() => {
    setPageNum(1)
  }, [q, sort, pageSize, activeFilters])

  function handleSort(key: string) {
    setSort((prev) => {
      if (prev?.key !== key) return { key, dir: 'asc' }
      if (prev.dir === 'asc') return { key, dir: 'desc' }
      return null  // third click = clear sort
    })
  }

  function SortIcon({ colKey }: { colKey: string }) {
    if (sort?.key !== colKey) return <ArrowUpDown size={12} className="text-zinc-400 opacity-60 group-hover/header:opacity-100" />
    if (sort.dir === 'asc') return <ArrowUp size={12} className="text-amber-600" />
    return <ArrowDown size={12} className="text-amber-600" />
  }

  // ── row ops ──────────────────────────────────────────────────────────────
  async function addRow() {
    try {
      await api.tables.addRow(table.uid, {})
      loadRows()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function onGhostCommit(key: string, value: unknown) {
    if (value == null || value === '') return
    const newGhost = { ...ghostData, [key]: value }
    setGhostData(newGhost)
    // any non-empty value → create row immediately
    try {
      const row = await api.tables.addRow(table.uid, {})
      await api.tables.updateRow(table.uid, row.uid, newGhost)
      setGhostData({})
      loadRows()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function deleteRow(rid: string) {
    try {
      await api.tables.deleteRow(table.uid, rid)
      loadRows()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function bulkDelete() {
    if (selected.size === 0) return
    try {
      await api.tables.bulkDelete(table.uid, Array.from(selected))
      loadRows()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function persist(rid: string, key: string, value: unknown) {
    try {
      const updated = await api.tables.updateRow(table.uid, rid, { [key]: value })
      setPage((prev) =>
        prev ? { ...prev, rows: prev.rows.map((r) => (r.uid === rid ? updated : r)) } : prev,
      )
    } catch (e) {
      setError((e as Error).message)
    }
  }

  function setLocal(rid: string, key: string, value: unknown) {
    setPage((prev) =>
      prev
        ? {
            ...prev,
            rows: prev.rows.map((r) =>
              r.uid === rid ? { ...r, data: { ...r.data, [key]: value } } : r,
            ),
          }
        : prev,
    )
  }

  // ── column ops ───────────────────────────────────────────────────────────
  async function addColumn(body: ColumnMetaIn) {
    try {
      await api.tables.addColumn(table.uid, body)
      setAdding(false)
      onColumnsChanged()
      loadRows()
    } catch (e) {
      setError((e as Error).message)
      setAdding(false)
    }
  }

  async function deleteColumn(key: string) {
    try {
      await api.tables.deleteColumn(table.uid, key)
      onColumnsChanged()
      loadRows()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  // ── selection ─────────────────────────────────────────────────────────────
  const rows = page?.rows ?? []
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.uid))

  function toggleAll() {
    if (allSelected) {
      setSelected(new Set())
    } else {
      setSelected(new Set(rows.map((r) => r.uid)))
    }
  }

  function toggleRow(id: string, e: React.MouseEvent | React.ChangeEvent) {
    const rowIdx = rows.findIndex((r) => r.uid === id)
    const nativeEvent = 'nativeEvent' in e ? e.nativeEvent : e as unknown as MouseEvent

    if ('shiftKey' in nativeEvent && nativeEvent.shiftKey && lastSelectedIdx.current >= 0) {
      // Shift+click → select range between lastSelectedIdx and current
      const from = Math.min(lastSelectedIdx.current, rowIdx)
      const to = Math.max(lastSelectedIdx.current, rowIdx)
      setSelected((prev) => {
        const s = new Set(prev)
        for (let i = from; i <= to; i++) s.add(rows[i].uid)
        return s
      })
    } else {
      // Normal or Ctrl+click → toggle single
      setSelected((prev) => {
        const s = new Set(prev)
        if (s.has(id)) { s.delete(id) } else { s.add(id) }
        return s
      })
      lastSelectedIdx.current = rowIdx
    }
  }

  const totalPages = page ? Math.max(1, Math.ceil(page.total / pageSize)) : 1

  return (
    <div className="flex h-full flex-col">
      {/* tabs + search + page size */}
      <div className="flex flex-wrap items-center gap-1 border-b border-zinc-200 px-3 pt-2">
        <TabButton active={tab === 'data'} onClick={() => setTab('data')}>
          <LayoutList size={13} /> ข้อมูล
        </TabButton>
        <TabButton active={tab === 'summary'} onClick={() => setTab('summary')}>
          <BarChart2 size={13} /> สรุป
        </TabButton>
        {tab === 'data' && (
          <div className="ml-auto flex items-center gap-2 pb-1.5">
            {/* search — debounced on-type */}
            <div className="flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-1.5">
              <Search size={15} className="shrink-0 text-zinc-400" />
              <input
                value={qInput}
                onChange={(e) => {
                  const v = e.target.value
                  setQInput(v)
                  if (debounceRef.current) clearTimeout(debounceRef.current)
                  debounceRef.current = setTimeout(() => setQ(v), 300)
                }}
                placeholder="ค้นหา…"
                className="w-36 bg-transparent text-sm text-zinc-700 outline-none placeholder:text-zinc-400"
              />
              {qInput && (
                <button onClick={() => { setQInput(''); setQ('') }} className="shrink-0">
                  <X size={13} className="text-zinc-400 hover:text-zinc-600" />
                </button>
              )}
            </div>
            {/* page size */}
            <select
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
              className="rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-sm text-zinc-600 outline-none"
            >
              {PAGE_SIZES.map((s) => <option key={s} value={s}>{s} / หน้า</option>)}
            </select>
            <span className="text-sm text-zinc-500">{page?.total ?? 0} รายการ</span>
            {/* import */}
            <button
              onClick={() => setImportOpen(true)}
              className="flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100"
            >
              <Upload size={14} /> Import
            </button>
            {/* export */}
            <button
              onClick={() => api.tables.exportCsv(table.uid, selected.size > 0 ? Array.from(selected) : undefined).catch((e) => setError((e as Error).message))}
              className="flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100"
              title={selected.size > 0 ? `Export ${selected.size} รายการที่เลือก` : 'Export ทั้งหมด'}
            >
              <Download size={14} /> Export
            </button>
          </div>
        )}
      </div>

      {/* bulk action toolbar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 border-b border-red-200 bg-red-50 px-4 py-2">
          <span className="text-sm font-medium text-red-700">เลือก {selected.size} รายการ</span>
          <button
            onClick={() => setConfirmBulkDelete(true)}
            className="flex items-center gap-1 rounded-lg bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700"
          >
            <Trash2 size={12} /> ลบที่เลือก
          </button>
          <button
            onClick={() => setSelected(new Set())}
            className="text-xs text-red-500 hover:text-red-700"
          >
            ยกเลิก
          </button>
        </div>
      )}

      {error && (
        <div className="flex items-center justify-between bg-red-50 px-3 py-1.5 text-xs text-red-700">
          <span>{error}</span>
          <button onClick={() => setError(null)}><X size={13} /></button>
        </div>
      )}
      {success && (
        <div className="flex items-center justify-between bg-green-50 px-3 py-1.5 text-xs text-green-700">
          <span>{success}</span>
          <button onClick={() => setSuccess(null)}><X size={13} /></button>
        </div>
      )}

      {tab === 'data' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="relative scroll-light min-h-0 flex-1 overflow-auto">
            {loading && (
              <div className="absolute inset-0 z-30 flex items-center justify-center bg-white/70">
                <div className="flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-4 py-2 text-sm text-zinc-500 shadow-sm">
                  <svg className="h-4 w-4 animate-spin text-amber-600" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                  </svg>
                  กำลังโหลด…
                </div>
              </div>
            )}
            <table className="border-separate border-spacing-0 text-sm">
              <thead className="sticky top-0 z-10">
                <tr>
                  {/* select-all checkbox — fixed width prevents squish */}
                  <th className="sticky left-0 z-20 w-10 min-w-[40px] border-b border-r border-zinc-200 bg-zinc-50 text-center">
                    <input type="checkbox" checked={allSelected} onChange={toggleAll} className="accent-amber-600" />
                  </th>
                  {table.columns.map((c) => (
                    <th
                      key={c.key}
                      className="relative border-b border-r border-zinc-200 bg-zinc-50 px-3 py-2 text-left font-semibold text-zinc-700"
                      style={{ minWidth: c.width ?? 160 }}
                    >
                      <div className="flex items-center gap-1">
                        {/* sort button — shrink-only so it doesn't fill the entire <th> and cause pointer cursor everywhere */}
                        <button
                          onClick={() => handleSort(c.key)}
                          className="group/header flex min-w-0 shrink items-center gap-1 truncate hover:text-amber-700"
                          title="คลิกเพื่อจัดเรียง"
                        >
                          <span className="truncate">{c.label}</span>
                          <SortIcon colKey={c.key} />
                        </button>
                        {/* filter button — replaces ⋮ settings */}
                        <ColumnFilterPopover
                          column={c}
                          filter={activeFilters[c.key] ?? null}
                          onApply={(spec) => {
                            setActiveFilters((prev) => {
                              const next = { ...prev }
                              if (spec) next[c.key] = spec; else delete next[c.key]
                              return next
                            })
                          }}
                        />
                      </div>
                    </th>
                  ))}
                  <th className="border-b border-zinc-200 bg-zinc-50 px-2">
                    <button
                      onClick={() => setAdding(true)}
                      title="เพิ่มคอลัมน์"
                      className="rounded p-1 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700"
                    >
                      <Plus size={15} />
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.uid} className="group">
                    <td className="sticky left-0 z-10 w-10 min-w-[40px] border-b border-r border-zinc-100 bg-white text-center">
                      <input
                        type="checkbox"
                        checked={selected.has(row.uid)}
                        onChange={(e) => toggleRow(row.uid, e)}
                        onClick={(e) => e.stopPropagation()}
                        className="cursor-pointer accent-amber-600"
                      />
                    </td>
                    {table.columns.map((c) => (
                      <td key={c.key} className="border-b border-r border-zinc-100 bg-white p-0">
                        <Cell
                          column={c}
                          value={row.data[c.key]}
                          onLocalChange={(v) => setLocal(row.uid, c.key, v)}
                          onCommit={(v) => persist(row.uid, c.key, v)}
                        />
                      </td>
                    ))}
                    <td className="border-b border-zinc-100 bg-white">
                      <button
                        onClick={(e) => { e.stopPropagation(); setConfirmRowDelete(row.uid) }}
                        title="ลบแถว"
                        className="p-1 text-zinc-300 opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-500"
                      >
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
                {/* ghost row — always visible, auto-creates row on first data entry */}
                <tr className="group/ghost">
                  <td className="sticky left-0 z-10 border-b border-r border-zinc-100 bg-zinc-50/60 text-center">
                    <span className="text-zinc-300"><Plus size={12} /></span>
                  </td>
                  {table.columns.map((c) => (
                    <td key={c.key} className="border-b border-r border-zinc-100 bg-zinc-50/40 p-0">
                      {c.ui_type !== 'formula' && (
                        <Cell
                          column={c}
                          value={ghostData[c.key] ?? null}
                          onLocalChange={(v) => setGhostData((prev) => ({ ...prev, [c.key]: v }))}
                          onCommit={(v) => onGhostCommit(c.key, v)}
                        />
                      )}
                    </td>
                  ))}
                  <td className="border-b border-zinc-100 bg-zinc-50/40" />
                </tr>
              </tbody>
            </table>
          </div>

          {/* footer: add row + pagination */}
          <div className="flex items-center justify-between border-t border-zinc-200 bg-white px-3 py-2">
            <button
              onClick={addRow}
              className="flex items-center gap-1 rounded-lg border border-dashed border-zinc-300 px-3 py-1.5 text-xs text-zinc-500 hover:border-amber-400 hover:text-amber-700"
            >
              <Plus size={13} /> เพิ่มแถว
            </button>

            {totalPages > 1 && (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPageNum((p) => Math.max(1, p - 1))}
                  disabled={pageNum <= 1}
                  className="rounded p-1 text-zinc-400 disabled:opacity-30 hover:text-zinc-700"
                >
                  <ChevronLeft size={15} />
                </button>
                {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                  const p = totalPages <= 7
                    ? i + 1
                    : pageNum <= 4
                    ? i + 1
                    : pageNum >= totalPages - 3
                    ? totalPages - 6 + i
                    : pageNum - 3 + i
                  return (
                    <button
                      key={p}
                      onClick={() => setPageNum(p)}
                      className={`min-w-[28px] rounded px-1 py-0.5 text-xs ${
                        p === pageNum ? 'bg-amber-600 text-white' : 'text-zinc-600 hover:bg-zinc-100'
                      }`}
                    >
                      {p}
                    </button>
                  )
                })}
                <button
                  onClick={() => setPageNum((p) => Math.min(totalPages, p + 1))}
                  disabled={pageNum >= totalPages}
                  className="rounded p-1 text-zinc-400 disabled:opacity-30 hover:text-zinc-700"
                >
                  <ChevronRight size={15} />
                </button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <SummaryTab table={table} selectCols={selectCols} onTableChanged={onColumnsChanged} />
      )}

      <ImportModal
        tableId={table.uid}
        columns={table.columns}
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={loadRows}
      />

      {adding && (
        <AddColumnModal
          existing={table.columns}
          onCancel={() => setAdding(false)}
          onSubmit={addColumn}
        />
      )}

      {confirmBulkDelete && (
        <ConfirmModal
          title={`ลบ ${selected.size} แถว`}
          message={`แถวที่เลือกทั้งหมด ${selected.size} รายการจะถูกลบถาวร`}
          confirmLabel="ลบทั้งหมด"
          onConfirm={() => { setConfirmBulkDelete(false); bulkDelete() }}
          onCancel={() => setConfirmBulkDelete(false)}
        />
      )}

      {confirmRowDelete != null && (
        <ConfirmModal
          title="ลบแถว"
          message="แถวนี้จะถูกลบถาวร"
          confirmLabel="ลบ"
          onConfirm={() => { deleteRow(confirmRowDelete); setConfirmRowDelete(null) }}
          onCancel={() => setConfirmRowDelete(null)}
        />
      )}

      {confirmColDelete != null && (
        <ConfirmModal
          title="ลบคอลัมน์"
          message={`ลบคอลัมน์และข้อมูลทั้งหมดในคอลัมน์นี้จากทุกแถว`}
          confirmLabel="ลบคอลัมน์"
          onConfirm={() => { deleteColumn(confirmColDelete); setConfirmColDelete(null) }}
          onCancel={() => setConfirmColDelete(null)}
        />
      )}
    </div>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-t-lg px-3 py-1.5 text-sm font-medium transition ${
        active ? 'bg-white text-amber-700 shadow-sm' : 'text-zinc-500 hover:text-zinc-700'
      }`}
    >
      {children}
    </button>
  )
}

// ── cell editors ─────────────────────────────────────────────────────────────

function Cell({
  column,
  value,
  onLocalChange,
  onCommit,
}: {
  column: ColumnMeta
  value: unknown
  onLocalChange: (v: unknown) => void
  onCommit: (v: unknown) => void
}) {
  const cls = 'w-full border-0 bg-transparent px-3 py-1.5 text-zinc-800 outline-none focus:bg-amber-50/60'

  if (column.ui_type === 'formula') {
    const resType = column.formula?.type === 'date_add' ? 'date'
      : column.formula?.type === 'date_diff' ? 'number' : undefined
    return <div className="px-3 py-1.5 text-zinc-700">{fmtValue(value, resType)}</div>
  }

  if (column.ui_type === 'boolean') {
    return (
      <div className="flex justify-center py-1.5">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onCommit(e.target.checked)}
          className="h-4 w-4 accent-amber-600"
        />
      </div>
    )
  }

  if (column.ui_type === 'select') {
    return <SelectCell column={column} value={value} onCommit={onCommit} />
  }

  if (column.ui_type === 'multi_select') {
    return <MultiSelectCell column={column} value={value} onCommit={onCommit} />
  }

  if (column.ui_type === 'date' || column.ui_type === 'datetime') {
    return <DateCell column={column} value={value} cls={cls} onCommit={onCommit} />
  }

  return (
    <input
      type={column.ui_type === 'number' ? 'number' : 'text'}
      value={value == null ? '' : String(value)}
      onChange={(e) => onLocalChange(e.target.value)}
      onBlur={(e) => onCommit(e.target.value === '' ? null : e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      className={cls}
    />
  )
}

/** Thai-formatted display; switches to native date picker on click. */
function DateCell({ column, value, cls, onCommit }: {
  column: ColumnMeta; value: unknown; cls: string; onCommit: (v: unknown) => void
}) {
  const [editing, setEditing] = useState(false)
  const inputType = column.ui_type === 'datetime' ? 'datetime-local' : 'date'
  const iso = value == null ? '' : String(value).slice(0, column.ui_type === 'datetime' ? 16 : 10)
  const thaiDisplay = iso
    ? (column.ui_type === 'datetime' ? fmtDatetime(iso) : fmtDate(iso))
    : ''

  if (editing) {
    return (
      <input
        type={inputType}
        defaultValue={iso}
        autoFocus
        onBlur={(e) => { setEditing(false); onCommit(e.target.value === '' ? null : e.target.value) }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        className={cls}
      />
    )
  }
  return (
    <div onClick={() => setEditing(true)} className="cursor-pointer px-3 py-1.5 text-zinc-800 hover:bg-amber-50/60">
      {thaiDisplay || <span className="text-zinc-400">—</span>}
    </div>
  )
}

/** Dropdown select with colored chip display */
function SelectCell({ column, value, onCommit }: {
  column: ColumnMeta; value: unknown; onCommit: (v: unknown) => void
}) {
  const [open, setOpen] = useState(false)
  const options = column.options ?? []
  const label = resolveOptionLabel(value, options)
  const color = resolveOptionColor(value, options)

  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-amber-50/60">
        {value == null || value === '' ? (
          <span className="text-zinc-400">—</span>
        ) : color ? (
          <span className="rounded-full px-2 py-0.5 text-xs font-medium text-white" style={{ background: color }}>{label}</span>
        ) : (
          <span className="text-zinc-800">{label}</span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-40 mt-1 min-w-[120px] rounded-lg border border-zinc-200 bg-white p-1 shadow-xl">
            <button
              onClick={() => { onCommit(null); setOpen(false) }}
              className="w-full rounded px-2 py-1 text-left text-sm text-zinc-400 hover:bg-zinc-50"
            >—</button>
            {(options as (string | OptionDef)[]).map((o) => {
              const isObj = typeof o === 'object'
              const id = isObj ? (o as OptionDef).uid : (o as string)
              const lbl = isObj ? (o as OptionDef).label : (o as string)
              const clr = isObj ? (o as OptionDef).color : ''
              return (
                <button
                  key={id}
                  onClick={() => { onCommit(id); setOpen(false) }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-zinc-50"
                >
                  {clr ? (
                    <span className="rounded-full px-2 py-0.5 text-xs font-medium text-white" style={{ background: clr }}>{lbl}</span>
                  ) : lbl}
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

function MultiSelectCell({ column, value, onCommit }: {
  column: ColumnMeta; value: unknown; onCommit: (v: unknown) => void
}) {
  const [open, setOpen] = useState(false)
  const selected = Array.isArray(value) ? (value as string[]) : []
  function toggle(opt: string) {
    const next = selected.includes(opt) ? selected.filter((x) => x !== opt) : [...selected, opt]
    onCommit(next)
  }
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full flex-wrap gap-1 px-3 py-1.5 text-left hover:bg-amber-50/60">
        {selected.length === 0 ? <span className="text-zinc-400">—</span> : selected.map((s) => (
          <span key={s} className="rounded bg-amber-100 px-1.5 text-xs text-amber-800">{s}</span>
        ))}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-40 mt-1 w-44 rounded-lg border border-zinc-200 bg-white p-1 shadow-xl">
            {(column.options ?? []).map((o) => {
              const label = typeof o === 'string' ? o : o.label
              const key = typeof o === 'string' ? o : o.uid
              return (
              <label key={key} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-zinc-50">
                <input type="checkbox" checked={selected.includes(label)} onChange={() => toggle(label)} className="accent-amber-600" />
                {label}
              </label>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

// ── date formatting ───────────────────────────────────────────────────────────

const THAI_MONTHS = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.']

function fmtDate(iso: string): string {
  const d = iso.slice(0, 10).split('-').map(Number)
  if (d.length < 3 || isNaN(d[0])) return iso
  const [y, m, day] = d
  return `${day} ${THAI_MONTHS[m - 1]} ${y + 543}`
}

function fmtDatetime(iso: string): string {
  const [datePart, timePart] = iso.split('T')
  const time = timePart ? timePart.slice(0, 5) : ''
  return `${fmtDate(datePart)}${time ? ' ' + time : ''}`
}

function fmtValue(v: unknown, ui_type?: string): string {
  if (v == null) return ''
  if (Array.isArray(v)) return v.join(', ')
  const s = String(v)
  if (ui_type === 'date' && /^\d{4}-\d{2}-\d{2}/.test(s)) return fmtDate(s)
  if (ui_type === 'datetime' && /^\d{4}-\d{2}-\d{2}/.test(s)) return fmtDatetime(s)
  return s
}

// ── summary tab ──────────────────────────────────────────────────────────────

import type { SummaryColConfig } from '../types'
import { SUMMARY_AGG_LABELS } from '../types'

type SummaryAgg = SummaryColConfig['aggs'][number]

const ALL_AGGS: SummaryAgg[] = ['count', 'sum', 'avg', 'min', 'max', 'pct']

function SummaryTab({ table, selectCols, onTableChanged }: {
  table: CustomTableOut
  selectCols: ColumnMeta[]
  onTableChanged: () => void
}) {
  const [groupBy, setGroupBy] = useState(selectCols[0]?.key ?? '')
  const [data, setData] = useState<SummaryOut | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [configMode, setConfigMode] = useState(false)
  const [config, setConfig] = useState<SummaryColConfig[]>(table.summary_config ?? [])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!groupBy) return
    setErr(null)
    api.tables
      .summary(table.uid, groupBy)
      .then(setData)
      .catch((e) => setErr((e as Error).message))
  }, [table.uid, groupBy])

  function toggleAgg(colKey: string, agg: SummaryAgg) {
    setConfig((prev) => {
      const existing = prev.find((c) => c.col_key === colKey)
      if (!existing) return [...prev, { col_key: colKey, aggs: [agg] }]
      const has = existing.aggs.includes(agg)
      const newAggs = has ? existing.aggs.filter((a) => a !== agg) : [...existing.aggs, agg]
      if (newAggs.length === 0) return prev.filter((c) => c.col_key !== colKey)
      return prev.map((c) => c.col_key === colKey ? { ...c, aggs: newAggs } : c)
    })
  }

  async function saveConfig() {
    setSaving(true)
    try {
      await api.tables.setSummaryConfig(table.uid, config)
      onTableChanged()
      setConfigMode(false)
      // refresh data
      if (groupBy) {
        const d = await api.tables.summary(table.uid, groupBy)
        setData(d)
      }
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const numericCols = table.columns.filter((c) => c.ui_type === 'number')

  // Empty state: no select column to group by and no numeric for aggregation
  if (selectCols.length === 0 && numericCols.length === 0 && !configMode) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <BarChart2 size={32} className="text-zinc-300" />
        <p className="text-sm font-medium text-zinc-500">ยังไม่มีข้อมูลสำหรับสรุป</p>
        <p className="text-xs text-zinc-400">เพิ่มคอลัมน์ประเภท <b>ตัวเลือกเดียว</b> เพื่อจัดกลุ่ม<br/>หรือ <b>ตัวเลข</b> เพื่อคำนวณค่าเฉลี่ย/รวม</p>
      </div>
    )
  }

  if (configMode) {
    return (
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-semibold text-zinc-700">ตั้งค่าการสรุป</h3>
          <button onClick={() => setConfigMode(false)} className="text-sm text-zinc-500 hover:text-zinc-700">ยกเลิก</button>
        </div>
        <p className="mb-3 text-xs text-zinc-400">เลือกคอลัมน์และการคำนวณที่ต้องการแสดง (ปล่อยว่าง = ใช้ค่าอัตโนมัติ)</p>
        {numericCols.length === 0 && (
          <p className="text-sm text-zinc-400">ยังไม่มีคอลัมน์ตัวเลข</p>
        )}
        <div className="space-y-3">
          {numericCols.map((c) => {
            const entry = config.find((x) => x.col_key === c.key)
            return (
              <div key={c.key} className="rounded-lg border border-zinc-200 p-3">
                <div className="mb-2 text-sm font-medium text-zinc-700">{c.label}</div>
                <div className="flex flex-wrap gap-2">
                  {ALL_AGGS.map((agg) => {
                    const active = entry?.aggs.includes(agg)
                    return (
                      <button
                        key={agg}
                        onClick={() => toggleAgg(c.key, agg)}
                        className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
                          active ? 'bg-amber-600 text-white' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
                        }`}
                      >
                        {SUMMARY_AGG_LABELS[agg]}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
        <button
          onClick={saveConfig}
          disabled={saving}
          className="mt-4 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {saving ? 'กำลังบันทึก…' : 'บันทึก'}
        </button>
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        {selectCols.length > 0 && (
          <label className="flex items-center gap-2 text-sm">
            <span className="text-zinc-600">จัดกลุ่มตาม</span>
            <select
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value)}
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-zinc-800 outline-none focus:border-amber-500"
            >
              {selectCols.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </label>
        )}
        <button
          onClick={() => setConfigMode(true)}
          className="ml-auto flex items-center gap-1 rounded-lg border border-zinc-200 px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-50"
        >
          ⚙ ตั้งค่า
        </button>
      </div>
      {err && <p className="text-sm text-red-600">{err}</p>}
      {data && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-zinc-700">
              <th className="border-b-2 border-zinc-300 bg-zinc-50 px-3 py-2 font-semibold">{data.group_by_label}</th>
              <th className="border-b-2 border-zinc-300 bg-zinc-50 px-3 py-2 text-right font-semibold">จำนวน</th>
              {data.metric_labels.map((m) => (
                <th key={m} className="border-b-2 border-zinc-300 bg-zinc-50 px-3 py-2 text-right font-semibold">{m}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r, i) => (
              <tr key={r.group} className={i % 2 === 0 ? 'bg-white' : 'bg-zinc-50'}>
                <td className="border-b border-zinc-200 px-3 py-2 font-semibold text-zinc-800">{r.group}</td>
                <td className="border-b border-zinc-200 px-3 py-2 text-right tabular-nums text-zinc-800">{r.count}</td>
                {data.metric_labels.map((m) => (
                  <td key={m} className="border-b border-zinc-200 px-3 py-2 text-right tabular-nums text-zinc-800">
                    {r.metrics[m] ?? '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
