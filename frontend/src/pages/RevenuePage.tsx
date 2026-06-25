import { BarChart2, DollarSign } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { RoomPage } from '../hud/RoomPage'
import type { PanelDef } from '../hud/RoomPage'
import type { RoomConfig } from '../scene/InteractiveRoom'
import type { TiktokOverview, VideoRow } from '../types'

const fmtNum = (n: number) => n.toLocaleString()
const fmtPct = (r: number) => `${(r * 100).toFixed(2)}%`

const config: RoomConfig = {
  dims: { W: 7.5, D: 6.5, H: 3.4 },
  palette: {
    bg: '#0d0a04',
    floor: '#2f2716',
    floorPlank: '#1a150b',
    wall: '#3b3120',
    ceiling: '#241d10',
    beam: '#16110a',
  },
  ambient: 0.22,
  lights: [
    { position: [0, 2.4, -1.2], color: '#ffb733', intensity: 2.6 },
    { position: [2.2, 1.4, 1.2], color: '#ffcc55', intensity: 1.4 },
    { position: [-2.4, 1.6, 0.5], color: '#ff9d2a', intensity: 1.2 },
  ],
  envPreset: 'night',
  camera: { position: [0.3, 1.75, 3.0], target: [0, 1.05, -0.5] },
  furniture: [
    // back-left: gold mine
    { url: '/models/gold_mine.glb', height: 1.3, position: [-2.3, 0, -2.3], rotation: 0.3 },
    // front corners: wooden pillars framing the vault
    { url: '/models/decor/pillar-wood.glb', height: 2.6, position: [-3.1, 0, 2.3] },
    { url: '/models/decor/pillar-wood.glb', height: 2.6, position: [3.1, 0, 2.3] },
    // lantern on the right wall
    { url: '/models/decor/lantern.glb', height: 0.55, position: [3.1, 0, -1.6] },
    // scattered coin pile
    { url: '/models/coins.glb', height: 0.3, position: [-1.7, 0, 1.0], rotation: 0.5 },
    { url: '/models/furniture/rugRectangle.glb', height: 0.04, position: [0, 0.02, -0.4], tint: '#7a2f22' },
  ],
  hotspots: [
    {
      id: 'top',
      label: 'Top Videos',
      url: '/models/chest.glb',
      height: 0.95,
      position: [0, 0, -1.7],
      labelY: 1.4,
    },
    {
      id: 'overview',
      label: 'Overview Stats',
      url: '/models/coins.glb',
      height: 0.5,
      position: [1.9, 0, 0.5],
      rotation: -0.3,
      labelY: 0.9,
    },
  ],
}

export default function RevenuePage() {
  const [overview, setOverview] = useState<TiktokOverview | null>(null)
  const [videos, setVideos] = useState<VideoRow[]>([])

  useEffect(() => {
    Promise.all([api.analyticsOverview(), api.analyticsContent(undefined, undefined, 50)])
      .then(([ov, vids]) => {
        setOverview(ov)
        setVideos(vids)
      })
      .catch(() => {})
  }, [])

  const top = [...videos].sort((a, b) => b.views - a.views).slice(0, 8)

  const panels: Record<string, PanelDef> = {
    top: {
      title: 'Top Videos',
      icon: <DollarSign size={15} />,
      body: (
        <ul className="space-y-2">
          {top.map((v, i) => (
            <li key={v.video_id} className="flex items-center gap-3 rounded-lg border border-[#5b3a1a]/15 bg-white/40 px-3 py-2.5">
              <span className="w-5 text-center text-sm font-bold text-[#5b3a1a]/40">{i + 1}</span>
              <a href={v.video_url} target="_blank" rel="noopener noreferrer" className="flex-1 truncate text-sm hover:underline">
                {v.video_title || v.video_id}
              </a>
              <span className="shrink-0 text-sm font-bold tabular-nums text-[#5b3a1a]">{fmtNum(v.views)}</span>
            </li>
          ))}
          {top.length === 0 && <li className="text-sm text-[#5b3a1a]/50">No video data — upload a Content.csv.</li>}
        </ul>
      ),
    },
    overview: {
      title: 'Overview Stats',
      icon: <BarChart2 size={15} />,
      body: (
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Video views" value={overview ? fmtNum(overview.total_video_views) : '—'} />
          <Stat label="Profile views" value={overview ? fmtNum(overview.total_profile_views) : '—'} />
          <Stat label="Followers" value={overview?.current_followers != null ? fmtNum(overview.current_followers) : '—'} />
          <Stat label="Avg engagement" value={overview ? fmtPct(overview.avg_engagement_rate) : '—'} />
          <Stat label="Likes" value={overview ? fmtNum(overview.total_likes) : '—'} />
          <Stat label="Comments" value={overview ? fmtNum(overview.total_comments) : '—'} />
        </div>
      ),
    },
  }

  return <RoomPage icon={<DollarSign size={16} />} title="Treasure — Revenue Vault" config={config} panels={panels} />
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[#5b3a1a]/20 bg-white/40 px-3 py-3 text-center">
      <div className="text-[10px] font-bold tracking-widest text-[#5b3a1a]/55">{label.toUpperCase()}</div>
      <div className="mt-1 text-xl font-bold tabular-nums text-[#5b3a1a]">{value}</div>
    </div>
  )
}
