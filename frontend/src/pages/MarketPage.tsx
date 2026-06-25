import { BarChart2, TrendingUp } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { RoomPage } from '../hud/RoomPage'
import type { PanelDef } from '../hud/RoomPage'
import type { RoomConfig } from '../scene/InteractiveRoom'
import type { FollowerHistoryRow } from '../types'

const fmtNum = (n: number) => n.toLocaleString()

const config: RoomConfig = {
  dims: { W: 8, D: 7, H: 3.6 },
  palette: {
    bg: '#0e1a24',
    floor: '#48555f',
    floorPlank: '#2c363e',
    wall: '#b9c6cf',
    ceiling: '#7f8d97',
    beam: '#39424a',
  },
  ambient: 0.36,
  lights: [
    { position: [-2.2, 2.6, -1.6], color: '#d4e6ff', intensity: 1.7 },
    { position: [2.4, 2.3, 0.6], color: '#ffd9a0', intensity: 1.2 },
  ],
  envPreset: 'city',
  tint: '#aab6bf',
  camera: { position: [-0.6, 1.85, 3.3], target: [0, 1.15, -0.4] },
  furniture: [
    // right-back: desk (holds the laptop hotspot) + chair
    { url: '/models/furniture/desk.glb', height: 0.78, position: [2.4, 0, -2.75] },
    { url: '/models/furniture/chair.glb', height: 0.9, position: [2.4, 0, -1.8], rotation: Math.PI },
    { url: '/models/furniture/lampSquareTable.glb', height: 0.5, position: [3.1, 0.78, -2.85] },
    // centre: rug + reading lounge chair
    { url: '/models/furniture/rugRound.glb', height: 0.04, position: [0, 0.02, 0.6], tint: '#5e7585' },
    { url: '/models/furniture/loungeChair.glb', height: 0.85, position: [-2.8, 0, 1.0], rotation: 0.7 },
    // accents
    { url: '/models/furniture/plantSmall1.glb', height: 0.4, position: [-3.2, 0, -2.4] },
    { url: '/models/furniture/pottedPlant.glb', height: 0.75, position: [3.2, 0, 2.2] },
  ],
  hotspots: [
    {
      id: 'history',
      label: 'Follower History',
      url: '/models/furniture/cabinetTelevision.glb',
      height: 1.4,
      position: [-1.3, 0, -2.85],
      labelY: 1.8,
    },
    {
      id: 'growth',
      label: 'Growth Summary',
      url: '/models/furniture/laptop.glb',
      height: 0.32,
      position: [2.4, 0.78, -2.7],
      labelY: 0.6,
    },
  ],
}

export default function MarketPage() {
  const [rows, setRows] = useState<FollowerHistoryRow[]>([])

  useEffect(() => {
    api.analyticsFollowers().then(setRows).catch(() => {})
  }, [])

  const stats = useMemo(() => {
    if (rows.length === 0) return null
    const last30 = rows.slice(-30)
    const net30 = last30.reduce((s, r) => s + r.net_change, 0)
    const last7 = rows.slice(-7)
    const net7 = last7.reduce((s, r) => s + r.net_change, 0)
    const current = rows[rows.length - 1]?.followers ?? 0
    const best = [...rows].sort((a, b) => b.net_change - a.net_change)[0]
    return { net30, net7, current, best }
  }, [rows])

  const recent = rows.slice(-60)

  const panels: Record<string, PanelDef> = {
    history: {
      title: 'Follower History',
      icon: <BarChart2 size={15} />,
      body:
        rows.length === 0 ? (
          <p className="text-[#5b3a1a]/60">No follower data — upload FollowerHistory.csv.</p>
        ) : (
          <>
            <p className="mb-3 text-xs text-[#5b3a1a]/60">Last {recent.length} days</p>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-[#5b3a1a]/70">
                  <th className="pb-2 font-semibold">Date</th>
                  <th className="pb-2 text-right font-semibold">Followers</th>
                  <th className="pb-2 text-right font-semibold">Change</th>
                </tr>
              </thead>
              <tbody>
                {[...recent].reverse().map((r) => (
                  <tr key={r.date} className="border-t border-[#5b3a1a]/15">
                    <td className="py-1.5">{r.date}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmtNum(r.followers)}</td>
                    <td
                      className={`py-1.5 text-right tabular-nums font-medium ${
                        r.net_change > 0 ? 'text-green-700' : r.net_change < 0 ? 'text-red-600' : 'text-[#5b3a1a]/40'
                      }`}
                    >
                      {r.net_change > 0 ? '+' : ''}
                      {r.net_change}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ),
    },
    growth: {
      title: 'Growth Summary',
      icon: <TrendingUp size={15} />,
      body: !stats ? (
        <p className="text-[#5b3a1a]/60">No data yet.</p>
      ) : (
        <div className="space-y-4">
          <Big label="Current followers" value={fmtNum(stats.current)} />
          <div className="grid grid-cols-2 gap-3">
            <Card label="Last 7 days" value={`${stats.net7 >= 0 ? '+' : ''}${stats.net7}`} good={stats.net7 >= 0} />
            <Card label="Last 30 days" value={`${stats.net30 >= 0 ? '+' : ''}${stats.net30}`} good={stats.net30 >= 0} />
          </div>
          {stats.best && (
            <p className="text-sm text-[#5b3a1a]/70">
              Best single day: <b>+{stats.best.net_change}</b> on {stats.best.date}
            </p>
          )}
        </div>
      ),
    },
  }

  return <RoomPage icon={<BarChart2 size={16} />} title="Lookout — Follower Analytics" config={config} panels={panels} />
}

function Big({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[#5b3a1a]/20 bg-white/50 px-4 py-4 text-center">
      <div className="text-[10px] font-bold tracking-widest text-[#5b3a1a]/60">{label.toUpperCase()}</div>
      <div className="mt-1 text-3xl font-bold tabular-nums text-[#5b3a1a]">{value}</div>
    </div>
  )
}

function Card({ label, value, good }: { label: string; value: string; good: boolean }) {
  return (
    <div className="rounded-lg border border-[#5b3a1a]/15 bg-white/40 px-3 py-3 text-center">
      <div className="text-[10px] font-bold tracking-widest text-[#5b3a1a]/55">{label.toUpperCase()}</div>
      <div className={`mt-1 text-xl font-bold tabular-nums ${good ? 'text-green-700' : 'text-red-600'}`}>{value}</div>
    </div>
  )
}
