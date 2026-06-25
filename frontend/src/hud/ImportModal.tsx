import * as Dialog from '@radix-ui/react-dialog'
import { AlertTriangle, CheckCircle2, Download, Upload, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { api } from '../api'
import type { ColumnMeta } from '../types'

interface Props {
  tableId: string
  columns: ColumnMeta[]   // table's columns for header validation
  open: boolean
  onClose: () => void
  onImported: () => void
}

interface CsvPreview {
  headers: string[]
  rows: string[][]
  matchedHeaders: string[]
  unmatchedHeaders: string[]
}

function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/)
  if (lines.length === 0) return { headers: [], rows: [] }
  const split = (line: string): string[] => {
    const result: string[] = []
    let cur = '', inQuote = false
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') { inQuote = !inQuote }
      else if (line[i] === ',' && !inQuote) { result.push(cur.trim()); cur = '' }
      else { cur += line[i] }
    }
    result.push(cur.trim())
    return result
  }
  const headers = split(lines[0])
  const rows = lines.slice(1).filter((l) => l.trim()).map(split)
  return { headers, rows }
}

export function ImportModal({ tableId, columns, open, onClose, onImported }: Props) {
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<CsvPreview | null>(null)
  const [dragging, setDragging] = useState(false)
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<{ rows_inserted: number; rows_updated: number; rows_skipped: number; errors: string[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const columnLabels = new Set(['id', ...columns.filter((c) => c.ui_type !== 'formula').map((c) => c.label)])

  async function pickFile(f: File | null) {
    if (!f) return
    if (!f.name.toLowerCase().endsWith('.csv')) { setError('รองรับเฉพาะไฟล์ .csv'); return }
    setResult(null)
    setError(null)
    try {
      const text = await f.text()
      const { headers, rows } = parseCsv(text)
      if (headers.length === 0) { setError('CSV ไม่มีหัวคอลัมน์'); return }

      const matchedHeaders = headers.filter((h) => columnLabels.has(h) && h !== 'id')
      const unmatchedHeaders = headers.filter((h) => !columnLabels.has(h))

      if (matchedHeaders.length === 0) {
        setError(
          `ไม่มีคอลัมน์ที่ตรงกับตารางนี้\n` +
          `หัวคอลัมน์ใน CSV: ${headers.slice(0, 5).join(', ')}${headers.length > 5 ? '…' : ''}\n` +
          `คอลัมน์ในตาราง: ${[...columnLabels].filter((l) => l !== 'id').slice(0, 5).join(', ')}`
        )
        setFile(null)
        setPreview(null)
        return
      }

      setFile(f)
      setPreview({ headers, rows, matchedHeaders, unmatchedHeaders })
    } catch (e) {
      setError(`อ่านไฟล์ไม่ได้: ${(e as Error).message}`)
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragging(false)
    void pickFile(e.dataTransfer.files[0] ?? null)
  }

  async function doImport() {
    if (!file) return
    setImporting(true)
    setError(null)
    try {
      const res = await api.tables.importCsv(tableId, file)
      setResult(res)
      onImported()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setImporting(false)
    }
  }

  async function downloadSample() {
    try { await api.tables.sampleCsv(tableId) } catch (e) { setError((e as Error).message) }
  }

  function reset() {
    setFile(null); setPreview(null); setResult(null); setError(null)
  }

  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (!v) { reset(); onClose() } }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-white shadow-2xl">
          <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3">
            <Dialog.Title className="font-bold text-zinc-800">นำเข้าข้อมูล (Import CSV)</Dialog.Title>
            <Dialog.Close className="rounded p-1 text-zinc-400 hover:text-zinc-700"><X size={16} /></Dialog.Close>
          </div>

          <div className="flex-1 overflow-auto p-5 space-y-4">
            {/* drop zone */}
            {!file && !error && (
              <div
                onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
                onDragLeave={() => setDragging(false)}
                onDrop={handleDrop}
                onClick={() => fileRef.current?.click()}
                className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed py-10 transition ${
                  dragging ? 'border-amber-400 bg-amber-50' : 'border-zinc-300 hover:border-zinc-400'
                }`}
              >
                <Upload size={32} className={dragging ? 'text-amber-500' : 'text-zinc-300'} />
                <span className="text-sm text-zinc-500">ลากไฟล์ CSV มาวาง หรือคลิกเพื่อเลือก</span>
              </div>
            )}
            <input ref={fileRef} type="file" accept=".csv" className="hidden"
              onChange={(e) => void pickFile(e.target.files?.[0] ?? null)} />

            {/* error */}
            {error && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
                <div className="flex items-center gap-2 text-sm font-medium text-red-700">
                  <AlertTriangle size={15} /> เกิดข้อผิดพลาด
                </div>
                <p className="mt-1 whitespace-pre-line text-xs text-red-600">{error}</p>
                <button onClick={() => { setError(null); fileRef.current?.click() }}
                  className="mt-2 text-xs text-red-500 underline hover:text-red-700">ลองใหม่</button>
              </div>
            )}

            {/* column match summary */}
            {preview && (
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-1 text-green-700">
                  <CheckCircle2 size={12} /> จับคู่ได้ {preview.matchedHeaders.length} คอลัมน์
                </span>
                {preview.unmatchedHeaders.length > 0 && (
                  <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-zinc-500">
                    ไม่ตรง {preview.unmatchedHeaders.length} คอลัมน์ (จะถูกข้าม)
                  </span>
                )}
                <button onClick={() => { reset(); fileRef.current?.click() }}
                  className="ml-auto text-zinc-400 hover:text-zinc-700">เปลี่ยนไฟล์</button>
              </div>
            )}

            {/* preview table — ALL rows, scrollable */}
            {preview && !result && (
              <div className="overflow-auto rounded-lg border border-zinc-200" style={{ maxHeight: '40vh' }}>
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-zinc-50">
                    <tr>
                      {preview.headers.map((h, i) => {
                        const matched = columnLabels.has(h)
                        return (
                          <th key={i} className={`border-b px-2 py-1.5 text-left font-semibold whitespace-nowrap ${matched ? 'text-zinc-700 border-zinc-200' : 'text-zinc-400 border-zinc-100'}`}>
                            {h}
                            {!matched && <span className="ml-1 text-zinc-300">(ข้าม)</span>}
                          </th>
                        )
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row, ri) => (
                      <tr key={ri} className={ri % 2 === 0 ? 'bg-white' : 'bg-zinc-50/50'}>
                        {row.map((cell, ci) => {
                          const matched = columnLabels.has(preview.headers[ci])
                          return (
                            <td key={ci} className={`border-b border-zinc-100 px-2 py-1.5 max-w-[200px] truncate ${matched ? 'text-zinc-700' : 'text-zinc-400'}`}>
                              {cell}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="sticky bottom-0 border-t border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs text-zinc-400">
                  {preview.rows.length} แถว
                </div>
              </div>
            )}

            {/* download sample */}
            <button onClick={downloadSample}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-200 py-2 text-sm text-zinc-600 hover:bg-zinc-50">
              <Download size={14} /> ดาวน์โหลด Sample CSV (พร้อมข้อมูลตัวอย่าง)
            </button>

            {/* result */}
            {result && (
              <div className="rounded-lg bg-green-50 px-4 py-3 text-sm space-y-1">
                <p className="font-medium text-green-800">นำเข้าสำเร็จ</p>
                <p className="text-green-700">
                  เพิ่ม {result.rows_inserted} แถว
                  {result.rows_updated > 0 && ` · อัปเดต ${result.rows_updated} แถว`}
                  {result.rows_skipped > 0 && ` · ข้าม ${result.rows_skipped} แถว`}
                </p>
                {result.errors.length > 0 && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-red-600">ข้อผิดพลาด ({result.errors.length})</summary>
                    <ul className="mt-1 space-y-0.5 text-xs text-red-600">
                      {result.errors.map((e, i) => <li key={i}>{e}</li>)}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 border-t border-zinc-100 px-5 py-3">
            <Dialog.Close className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100">
              {result ? 'ปิด' : 'ยกเลิก'}
            </Dialog.Close>
            {!result && file && preview && (
              <button onClick={doImport} disabled={importing}
                className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white shadow disabled:opacity-40 hover:bg-amber-700">
                {importing ? 'กำลังนำเข้า…' : `Import ${preview.rows.length} แถว`}
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
