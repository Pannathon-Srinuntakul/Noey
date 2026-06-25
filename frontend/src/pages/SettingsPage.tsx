import { Check, Settings, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { RoomPage } from '../hud/RoomPage'
import type { PanelDef } from '../hud/RoomPage'
import type { RoomConfig } from '../scene/InteractiveRoom'
import type { SettingsOut } from '../types'

const config: RoomConfig = {
  dims: { W: 8, D: 7, H: 3.6 },
  palette: {
    bg: '#15180e',
    floor: '#5a5230',
    floorPlank: '#39341d',
    wall: '#c6c4a2',
    ceiling: '#8d8a63',
    beam: '#39341d',
  },
  ambient: 0.34,
  lights: [
    { position: [-2.2, 2.5, -1.6], color: '#ffd98a', intensity: 1.9 },
    { position: [2.4, 2.3, 0.8], color: '#ffe6b0', intensity: 1.3 },
  ],
  envPreset: 'apartment',
  tint: '#b6a574',
  camera: { position: [0.4, 1.9, 3.3], target: [0, 1.15, -0.4] },
  furniture: [
    { url: '/models/furniture/rugRectangle.glb', height: 0.04, position: [0, 0.02, 0.4], tint: '#6f7a44' },
    // stool in front of the bookshelf
    { url: '/models/furniture/stoolBar.glb', height: 0.9, position: [-2.2, 0, -1.8] },
    // radio sits on the desk (AI Model hotspot)
    { url: '/models/furniture/radio.glb', height: 0.3, position: [2.0, 0.8, -2.7], rotation: -0.3 },
    // left wall: floor lamp; right wall: coat rack + plant
    { url: '/models/furniture/lampRoundFloor.glb', height: 1.5, position: [-3.2, 0, -2.4] },
    { url: '/models/furniture/coatRack.glb', height: 1.7, position: [3.2, 0, -2.4] },
    { url: '/models/furniture/pottedPlant.glb', height: 0.75, position: [3.2, 0, 2.2] },
    { url: '/models/furniture/trashcan.glb', height: 0.5, position: [-3.2, 0, 1.2] },
  ],
  hotspots: [
    {
      id: 'model',
      label: 'AI Model',
      url: '/models/furniture/desk.glb',
      height: 0.8,
      position: [2.0, 0, -2.75],
      labelY: 1.3,
    },
    {
      id: 'keys',
      label: 'API Keys (env)',
      url: '/models/furniture/bookcaseClosed.glb',
      height: 2.0,
      position: [-3.2, 0, -2.0],
    },
  ],
}

export default function SettingsPage() {
  const [s, setS] = useState<SettingsOut | null>(null)
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [saved, setSaved] = useState(false)


  useEffect(() => {
    api.getSettings().then((d) => {
      setS(d)
      setModel(d.llm_model)
      setBaseUrl(d.llm_base_url ?? '')
    })
  }, [])

  async function save() {
    const d = await api.putSettings({ llm_model: model, llm_base_url: baseUrl })
    setS(d)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  const panels: Record<string, PanelDef> = {
    model: {
      title: 'AI Model',
      icon: <Settings size={15} />,
      body: !s ? (
        <p className="text-[#5b3a1a]/60">Loading…</p>
      ) : (
        <div className="space-y-4">
          <Field label="Model (e.g. anthropic/claude-sonnet-4-6, ollama/llama3)" value={model} onChange={setModel} />
          <Field label="Local base URL (optional, e.g. http://localhost:11434)" value={baseUrl} onChange={setBaseUrl} />
          <button
            onClick={save}
            className="rounded-lg bg-[#5b3a1a] px-6 py-2.5 font-medium text-amber-50 shadow hover:bg-[#4a2e0c]"
          >
            {saved ? <span className="flex items-center gap-1"><Check size={14} /> Saved</span> : 'Save settings'}
          </button>
        </div>
      ),
    },
    keys: {
      title: 'API Keys (env)',
      icon: <Settings size={15} />,
      body: !s ? (
        <p className="text-[#5b3a1a]/60">Loading…</p>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-[#5b3a1a]/70">Keys are read from <code>.env</code> — never stored in the DB.</p>
          <ul className="space-y-2">
            {Object.entries(s.keys).map(([k, v]) => (
              <li
                key={k}
                className="flex items-center justify-between rounded-lg border border-[#5b3a1a]/15 bg-white/40 px-3 py-2"
              >
                <span className="font-medium">{k}</span>
                <span
                  className={`rounded px-2 py-0.5 text-xs font-bold ${
                    v ? 'bg-green-700/20 text-green-800' : 'bg-red-700/15 text-red-800'
                  }`}
                >
                  {v ? <span className="flex items-center gap-1"><Check size={11} /> SET</span> : <span className="flex items-center gap-1"><X size={11} /> MISSING</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ),
    },
  }

  return <RoomPage icon={<Settings size={16} />} title="Workshop — Settings" config={config} panels={panels} />
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-[#5b3a1a]/80">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded border border-[#5b3a1a]/40 bg-[#fffaf0] px-3 py-2 text-zinc-800 outline-none placeholder:text-[#5b3a1a]/30 focus:border-[#5b3a1a]"
      />
    </label>
  )
}
