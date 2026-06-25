import { FolderOpen, ScrollText, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { RoomPage } from '../hud/RoomPage'
import type { PanelDef } from '../hud/RoomPage'
import { useNavigateWithDoor } from '../navigation/NavigationContext'
import type { RoomConfig } from '../scene/InteractiveRoom'
import type { ImportRunOut } from '../types'

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

const today = () => new Date().toISOString().slice(0, 10)

const STATUS_STYLE: Record<string, string> = {
  ok: 'bg-green-700/20 text-green-800',
  error: 'bg-red-700/15 text-red-800',
  running: 'bg-amber-500/20 text-amber-800',
}

const config: RoomConfig = {
  dims: { W: 8, D: 7, H: 3.6 },
  palette: {
    bg: '#0a1418',
    floor: '#6a5a3a',
    floorPlank: '#453a22',
    wall: '#bccfce',
    ceiling: '#788c8a',
    beam: '#453a22',
  },
  ambient: 0.35,
  lights: [
    { position: [-2.2, 2.5, -1.6], color: '#ffcf8a', intensity: 1.9 },
    { position: [2.4, 2.4, 0.6], color: '#a8d8e0', intensity: 1.3 },
  ],
  envPreset: 'sunset',
  tint: '#c0a06e',
  camera: { position: [-0.5, 1.85, 3.3], target: [0, 1.15, -0.4] },
  furniture: [
    // right-back: desk (holds Import Log laptop) + chair
    { url: '/models/furniture/desk.glb', height: 0.78, position: [2.4, 0, -2.75] },
    { url: '/models/furniture/chair.glb', height: 0.9, position: [2.4, 0, -1.8], rotation: Math.PI },
    // left wall: stacked cargo crates next to the open-crate hotspot
    { url: '/models/furniture/cardboardBoxClosed.glb', height: 0.55, position: [-3.1, 0, 0.6], rotation: 0.2 },
    { url: '/models/furniture/cardboardBoxClosed.glb', height: 0.45, position: [-3.0, 0, 1.6], rotation: -0.2 },
    // accents
    { url: '/models/decor/lantern.glb', height: 0.5, position: [3.2, 0, 1.8] },
    { url: '/models/furniture/pottedPlant.glb', height: 0.75, position: [-3.1, 0, 2.3] },
    { url: '/models/furniture/rugRectangle.glb', height: 0.04, position: [0, 0.02, 0.4], tint: '#3f7a6a' },
  ],
  hotspots: [
    {
      id: 'upload',
      label: 'Upload CSV',
      url: '/models/furniture/cardboardBoxOpen.glb',
      height: 0.7,
      position: [-2.2, 0, -2.7],
      rotation: 0.15,
      labelY: 1.1,
    },
    {
      id: 'history',
      label: 'Import Log',
      url: '/models/furniture/laptop.glb',
      height: 0.32,
      position: [2.4, 0.78, -2.7],
      labelY: 0.6,
    },
  ],
}

export default function ImportPage() {
  const { navigateWithDoor } = useNavigateWithDoor()
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
      window.dispatchEvent(new CustomEvent('data-imported'))
      navigateWithDoor('/')
    } catch (e) {
      setError((e as Error).message)
      setUploading(false)
    }
  }

  const fileList = files ? Array.from(files) : []

  const panels: Record<string, PanelDef> = {
    upload: {
      title: 'Upload CSV',
      icon: <Upload size={15} />,
      body: (
        <div className="space-y-4">
          <label className="block text-sm">
            <span className="mb-1 block text-[#5b3a1a]/80">Export date (from folder name)</span>
            <input
              type="date"
              value={exportDate}
              onChange={(e) => setExportDate(e.target.value)}
              className="rounded border border-[#5b3a1a]/40 bg-[#fffaf0] px-3 py-2 outline-none"
            />
          </label>

          <input ref={inputRef} type="file" multiple accept=".csv,.zip" onChange={(e) => setFiles(e.target.files)} className="hidden" />

          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="flex w-full items-center justify-center gap-2 rounded-lg border-2 border-dashed border-[#5b3a1a]/40 bg-[#5b3a1a]/5 px-4 py-4 text-sm font-medium text-[#5b3a1a] transition hover:bg-[#5b3a1a]/10"
          >
            <FolderOpen size={16} /> {fileList.length > 0 ? `${fileList.length} file(s) selected` : 'Choose CSV or ZIP files'}
          </button>

          {fileList.length > 0 && (
            <ul className="space-y-1">
              {fileList.map((f) => (
                <li key={f.name} className="flex items-center justify-between rounded bg-[#5b3a1a]/10 px-3 py-1.5 text-xs">
                  <span>{f.name}</span>
                  <span className="ml-2 rounded bg-amber-200/60 px-1.5 py-0.5 text-[10px] font-medium text-[#5b3a1a]">
                    {detectType(f.name)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {error && <p className="rounded bg-red-100 px-3 py-2 text-sm text-red-700">{error}</p>}

          <button
            onClick={handleUpload}
            disabled={!files || files.length === 0 || uploading}
            className="rounded-lg bg-[#5b3a1a] px-5 py-2.5 font-medium text-amber-50 shadow disabled:opacity-40"
          >
            {uploading ? 'Importing…' : 'Upload & Import'}
          </button>
        </div>
      ),
    },
    history: {
      title: 'Import Log',
      icon: <ScrollText size={15} />,
      body:
        runs.length === 0 ? (
          <p className="text-sm text-[#5b3a1a]/50">No imports yet.</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[#5b3a1a]/60">
                <th className="pb-2 font-semibold">Date</th>
                <th className="pb-2 font-semibold">Files</th>
                <th className="pb-2 text-right font-semibold">Rows</th>
                <th className="pb-2 text-right font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-t border-[#5b3a1a]/15">
                  <td className="py-2">{r.export_date}</td>
                  <td className="py-2 text-[#5b3a1a]/60">{r.filenames.join(', ')}</td>
                  <td className="py-2 text-right tabular-nums">{r.rows_imported}</td>
                  <td className="py-2 text-right">
                    <span className={`rounded px-1.5 py-0.5 font-medium ${STATUS_STYLE[r.status] ?? ''}`}>
                      {r.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ),
    },
  }

  return <RoomPage icon={<Upload size={16} />} title="Lighthouse — Import Data" config={config} panels={panels} />
}
