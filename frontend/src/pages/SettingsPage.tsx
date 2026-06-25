import { Check, RefreshCw, Settings, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, formatUserError } from '../api'
import type { UsageMeOut } from '../api'
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
    {
      id: 'usage',
      label: 'Token Usage',
      url: '/models/furniture/stoolBar.glb',
      height: 0.9,
      position: [3.2, 0, -1.0],
      labelY: 1.4,
    },
  ],
}

export default function SettingsPage() {
  const [s, setS] = useState<SettingsOut | null>(null)
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [saved, setSaved] = useState(false)
  const [usage, setUsage] = useState<UsageMeOut | null>(null)
  const [usageError, setUsageError] = useState<string | null>(null)
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null)
  const [resetting, setResetting] = useState(false)
  const [resetDone, setResetDone] = useState(false)

  useEffect(() => {
    api.getSettings().then((d) => {
      setS(d)
      setModel(d.llm_model)
      setBaseUrl(d.llm_base_url ?? '')
    })
    api.usage.getMe().then((d) => {
      setUsage(d)
    }).catch((e: Error) => {
      setUsageError(formatUserError(e))
    })
    // Probe admin access to decide whether to show reset
    api.usage.adminGetAll().then(() => setIsAdmin(true)).catch(() => setIsAdmin(false))
  }, [])

  async function save() {
    const d = await api.putSettings({ llm_model: model, llm_base_url: baseUrl })
    setS(d)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  async function resetMyUsage() {
    if (!usage) return
    setResetting(true)
    try {
      await api.usage.adminResetUsage(usage.user_id)
      const refreshed = await api.usage.getMe()
      setUsage(refreshed)
      setResetDone(true)
      setTimeout(() => setResetDone(false), 2000)
    } finally {
      setResetting(false)
    }
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

  panels.usage = {
    title: 'Token Usage',
    icon: <Settings size={15} />,
    body: usageError ? (
      <p className="text-sm text-red-700">{usageError}</p>
    ) : !usage ? (
      <p className="text-[#5b3a1a]/60 text-sm">Loading…</p>
    ) : (
      <UsagePanel
        usage={usage}
        isAdmin={isAdmin ?? false}
        resetting={resetting}
        resetDone={resetDone}
        onReset={resetMyUsage}
      />
    ),
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

const PLAN_COLORS: Record<string, string> = {
  free:       'bg-zinc-200 text-zinc-700',
  starter:    'bg-blue-100 text-blue-800',
  pro:        'bg-violet-100 text-violet-800',
  enterprise: 'bg-amber-100 text-amber-800',
}

function fmt(n: number) {
  return n.toLocaleString()
}

function nextMonthFirst() {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).toLocaleDateString('th-TH', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

function UsagePanel({
  usage,
  isAdmin,
  resetting,
  resetDone,
  onReset,
}: {
  usage: UsageMeOut
  isAdmin: boolean
  resetting: boolean
  resetDone: boolean
  onReset: () => void
}) {
  const pct = usage.unlimited ? 0 : (usage.usage_pct ?? 0)
  const barColor = usage.unlimited
    ? 'bg-green-500'
    : pct >= 100
    ? 'bg-red-500'
    : pct >= 80
    ? 'bg-yellow-500'
    : 'bg-green-500'

  const featureLabel: Record<string, string> = {
    chat: 'Chat',
    video: 'Video',
    prompt_cron: 'Prompt Cron',
  }

  return (
    <div className="space-y-4 text-sm">
      {/* Plan badge */}
      <div className="flex items-center gap-2">
        <span className="text-[#5b3a1a]/70">Plan</span>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide ${PLAN_COLORS[usage.plan] ?? 'bg-zinc-100 text-zinc-700'}`}>
          {usage.plan}
        </span>
      </div>

      {/* Token progress bar */}
      <div className="space-y-1">
        <div className="flex justify-between text-[#5b3a1a]/80">
          <span>Token ที่ใช้เดือนนี้</span>
          <span className="font-mono">
            {fmt(usage.used_tokens)}{usage.unlimited ? '' : ` / ${fmt(usage.limit_tokens)}`}
          </span>
        </div>
        {!usage.unlimited && (
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-[#5b3a1a]/10">
            <div
              className={`h-full rounded-full transition-all ${barColor}`}
              style={{ width: `${Math.min(pct, 100)}%` }}
            />
          </div>
        )}
        {usage.unlimited ? (
          <p className="text-xs text-green-700">ไม่จำกัด</p>
        ) : (
          <p className="text-xs text-[#5b3a1a]/60">
            {usage.remaining_tokens != null ? `เหลือ ${fmt(usage.remaining_tokens)} tokens` : ''}
            {usage.usage_pct != null ? ` (${usage.usage_pct}%)` : ''}
          </p>
        )}
      </div>

      {/* Cost */}
      <div className="flex justify-between rounded-lg border border-[#5b3a1a]/15 bg-white/40 px-3 py-2">
        <span className="text-[#5b3a1a]/70">ค่าใช้จ่ายประมาณ</span>
        <span className="font-mono font-medium">${usage.estimated_cost_usd.toFixed(4)} USD</span>
      </div>

      {/* Period */}
      <div className="rounded-lg border border-[#5b3a1a]/15 bg-white/40 px-3 py-2 space-y-0.5">
        <div className="flex justify-between">
          <span className="text-[#5b3a1a]/60">เริ่มรอบ</span>
          <span className="font-mono text-xs">{new Date(usage.period_start).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-[#5b3a1a]/60">Reset อัตโนมัติ</span>
          <span className="font-mono text-xs">{nextMonthFirst()}</span>
        </div>
        {usage.reset_at && (
          <div className="flex justify-between">
            <span className="text-[#5b3a1a]/60">Reset ล่าสุด (admin)</span>
            <span className="font-mono text-xs">{new Date(usage.reset_at).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })}</span>
          </div>
        )}
      </div>

      {/* Per-feature breakdown */}
      {usage.by_feature.length > 0 && (
        <div className="space-y-1">
          <p className="font-medium text-[#5b3a1a]/80">แยกตาม feature</p>
          <div className="overflow-hidden rounded-lg border border-[#5b3a1a]/15">
            <table className="w-full text-xs">
              <thead className="bg-[#5b3a1a]/8 text-[#5b3a1a]/60">
                <tr>
                  <th className="px-2 py-1.5 text-left">Feature</th>
                  <th className="px-2 py-1.5 text-right">Input</th>
                  <th className="px-2 py-1.5 text-right">Output</th>
                  <th className="px-2 py-1.5 text-right">รวม</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#5b3a1a]/8">
                {usage.by_feature.map((r) => (
                  <tr key={r.feature} className="bg-white/30">
                    <td className="px-2 py-1.5 font-medium capitalize">{featureLabel[r.feature] ?? r.feature}</td>
                    <td className="px-2 py-1.5 text-right font-mono">{fmt(r.input_tokens)}</td>
                    <td className="px-2 py-1.5 text-right font-mono">{fmt(r.output_tokens)}</td>
                    <td className="px-2 py-1.5 text-right font-mono font-semibold">{fmt(r.total_tokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {usage.by_feature.length === 0 && (
        <p className="text-center text-xs text-[#5b3a1a]/40 py-2">ยังไม่มีการใช้งานในรอบนี้</p>
      )}

      {/* Admin reset */}
      {isAdmin && (
        <button
          onClick={onReset}
          disabled={resetting}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-[#5b3a1a]/30 bg-white/50 px-4 py-2 text-sm font-medium text-[#5b3a1a] hover:bg-[#5b3a1a]/10 disabled:opacity-50"
        >
          <RefreshCw size={13} className={resetting ? 'animate-spin' : ''} />
          {resetDone ? 'Reset แล้ว!' : resetting ? 'กำลัง reset…' : 'Reset usage period (Admin)'}
        </button>
      )}
    </div>
  )
}
