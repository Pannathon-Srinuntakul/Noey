import { useEffect, useRef, useState } from 'react'
import { api, formatUserError } from '../../api'
import type { ImportRunOut } from '../../types'
import { Room } from '../Room'

const CSV_TYPES: Record<string, string> = {
  overview: 'Overview',
  content: 'Content',
  followeractivity: 'Follower Activity',
  followergender: 'Follower Gender',
  followerhistory: 'Follower History',
  followertopterritories: 'Follower Territories',
  viewers: 'Viewers',
}

function detectType(filename: string): string {
  if (filename.toLowerCase().endsWith('.zip')) return 'ZIP archive'
  const stem = filename.replace(/\.[^.]+$/, '').toLowerCase().replace(/[\s_]/g, '')
  return CSV_TYPES[stem] ?? 'Unknown'
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

const STATUS_STYLE: Record<string, string> = {
  ok: 'bg-green-700/20 text-green-800',
  error: 'bg-red-700/15 text-red-800',
  running: 'bg-amber-500/20 text-amber-800',
}

export function ImportRoom({ onClose, onImported }: { onClose: () => void; onImported?: () => void }) {
  const [exportDate, setExportDate] = useState(today())
  const [files, setFiles] = useState<FileList | null>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [runs, setRuns] = useState<ImportRunOut[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    api.listImportRuns().then(setRuns).catch(() => {})
  }, [])

  async function handleUpload() {
    if (!files || files.length === 0) return
    setUploading(true)
    setError(null)
    try {
      const result = await api.importCsv(files, exportDate)
      setRuns((prev) => [result, ...prev])
      setFiles(null)
      if (inputRef.current) inputRef.current.value = ''
      onImported?.()
    } catch (e) {
      setError(formatUserError(e))
    } finally {
      setUploading(false)
    }
  }

  const fileList = files ? Array.from(files) : []

  return (
    <Room title="Lighthouse — Import Data" icon="📥" onClose={onClose}>
      <div className="space-y-5">
        {/* Upload section */}
        <section>
          <h3 className="mb-2 font-semibold">Upload CSV exports</h3>

          <label className="mb-2 block text-sm">
            <span className="mb-1 block text-[#5b3a1a]">Export date (from folder name)</span>
            <input
              type="date"
              value={exportDate}
              onChange={(e) => setExportDate(e.target.value)}
              className="rounded border border-[#5b3a1a]/40 bg-[#fffaf0] px-2 py-1.5 outline-none"
            />
          </label>

          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".csv,.zip"
            onChange={(e) => setFiles(e.target.files)}
            className="hidden"
          />

          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="mb-3 flex w-full items-center justify-center gap-2 rounded-lg border-2 border-dashed border-[#5b3a1a]/40 bg-[#5b3a1a]/5 px-4 py-3 text-sm font-medium text-[#5b3a1a] transition hover:border-[#5b3a1a]/70 hover:bg-[#5b3a1a]/10"
          >
            <span className="text-lg">📂</span>
            {fileList.length > 0 ? `${fileList.length} file${fileList.length > 1 ? 's' : ''} selected` : 'Choose CSV or ZIP files'}
          </button>

          {fileList.length > 0 && (
            <ul className="mb-3 space-y-1">
              {fileList.map((f) => (
                <li
                  key={f.name}
                  className="flex items-center justify-between rounded bg-[#5b3a1a]/10 px-3 py-1 text-xs"
                >
                  <span>{f.name}</span>
                  <span className="ml-2 rounded bg-amber-200/60 px-1.5 py-0.5 text-[10px] font-medium text-[#5b3a1a]">
                    {detectType(f.name)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {error && (
            <p className="mb-2 rounded bg-red-100 px-3 py-1 text-sm text-red-700">{error}</p>
          )}

          <div className="flex gap-2">
            <button
              onClick={handleUpload}
              disabled={!files || files.length === 0 || uploading}
              className="rounded-lg bg-[#5b3a1a] px-5 py-2 font-medium text-amber-50 disabled:opacity-40"
            >
              {uploading ? 'Importing…' : 'Upload & Import'}
            </button>
            {fileList.length > 0 && !uploading && (
              <button
                onClick={() => { setFiles(null); if (inputRef.current) inputRef.current.value = '' }}
                className="rounded-lg border border-[#5b3a1a]/30 px-3 py-2 text-sm text-[#5b3a1a]/70 hover:bg-[#5b3a1a]/10"
              >
                Clear
              </button>
            )}
          </div>
        </section>

        {/* Import history */}
        <section>
          <h3 className="mb-2 font-semibold">Import history</h3>
          {runs.length === 0 ? (
            <p className="text-sm text-[#5b3a1a]/60">No imports yet.</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-left text-[#5b3a1a]/70">
                <tr>
                  <th className="py-1">Date</th>
                  <th className="py-1">Files</th>
                  <th className="py-1 text-right">Rows</th>
                  <th className="py-1 text-right">Status</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="border-t border-[#5b3a1a]/15">
                    <td className="py-1.5">{r.export_date}</td>
                    <td className="py-1.5 text-[#5b3a1a]/70">{r.filenames.join(', ')}</td>
                    <td className="py-1.5 text-right tabular-nums">{r.rows_imported}</td>
                    <td className="py-1.5 text-right">
                      <span
                        className={`rounded px-1.5 py-0.5 font-medium ${STATUS_STYLE[r.status] ?? ''}`}
                      >
                        {r.status}
                      </span>
                      {r.error && (
                        <span className="ml-1 text-red-700" title={r.error}>
                          ⚠
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </Room>
  )
}
