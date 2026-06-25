import { Clapperboard, Trophy } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { RoomPage } from '../hud/RoomPage'
import type { PanelDef } from '../hud/RoomPage'
import type { RoomConfig } from '../scene/InteractiveRoom'
import type { VideoRow } from '../types'

const fmtNum = (n: number) => n.toLocaleString()
const fmtPct = (r: number) => `${(r * 100).toFixed(2)}%`

const config: RoomConfig = {
  dims: { W: 8, D: 7, H: 3.6 },
  palette: {
    bg: '#241606',
    floor: '#6b4420',
    floorPlank: '#43290f',
    wall: '#d8c49a',
    ceiling: '#b18f5e',
    beam: '#43290f',
  },
  ambient: 0.32,
  lights: [
    { position: [-2.4, 2.5, -1.8], color: '#ffb347', intensity: 2.0 },
    { position: [2.6, 2.4, 0.5], color: '#ffa83a', intensity: 1.5 },
  ],
  envPreset: 'warehouse',
  tint: '#c79f68',
  camera: { position: [0.6, 1.9, 3.3], target: [0, 1.15, -0.4] },
  furniture: [
    // centre: rug + work table + chair
    { url: '/models/furniture/rugRectangle.glb', height: 0.04, position: [0, 0.02, 0.4], tint: '#9c5a3c' },
    { url: '/models/furniture/table.glb', height: 0.72, position: [0, 0, 0.4] },
    { url: '/models/furniture/books.glb', height: 0.22, position: [0.25, 0.74, 0.4], rotation: 0.3 },
    { url: '/models/furniture/chair.glb', height: 0.9, position: [0, 0, 1.5], rotation: Math.PI },
    // left wall: stacked crates
    { url: '/models/furniture/cardboardBoxClosed.glb', height: 0.6, position: [-3.1, 0, 1.2] },
    { url: '/models/furniture/cardboardBoxOpen.glb', height: 0.55, position: [-3.1, 0, 0.2], rotation: 0.3 },
    { url: '/models/furniture/cardboardBoxClosed.glb', height: 0.45, position: [-3.0, 0, 2.2], rotation: -0.2 },
    // right wall: plant + lantern
    { url: '/models/furniture/pottedPlant.glb', height: 0.75, position: [3.2, 0, 2.2] },
    { url: '/models/decor/lantern.glb', height: 0.5, position: [3.2, 0, -1.2] },
  ],
  hotspots: [
    {
      id: 'catalog',
      label: 'Content Catalog',
      url: '/models/furniture/bookcaseClosed.glb',
      height: 2.0,
      position: [-2.3, 0, -2.9],
    },
    {
      id: 'top',
      label: 'Best & Worst',
      url: '/models/furniture/bookcaseOpen.glb',
      height: 1.8,
      position: [2.3, 0, -2.9],
    },
  ],
}

function VideoTable({ rows }: { rows: VideoRow[] }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-[#5b3a1a]/70">
          <th className="pb-2 font-semibold">Title</th>
          <th className="pb-2 text-right font-semibold">Views</th>
          <th className="pb-2 text-right font-semibold">Eng.</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((v) => (
          <tr key={v.video_id} className="border-t border-[#5b3a1a]/15">
            <td className="py-1.5">
              <a href={v.video_url} target="_blank" rel="noopener noreferrer" className="hover:underline">
                {v.video_title || v.video_id}
              </a>
            </td>
            <td className="py-1.5 text-right tabular-nums">{fmtNum(v.views)}</td>
            <td className="py-1.5 text-right tabular-nums">{fmtPct(v.engagement_rate)}</td>
          </tr>
        ))}
        {rows.length === 0 && (
          <tr>
            <td colSpan={3} className="py-6 text-center text-[#5b3a1a]/50">
              No videos — upload a Content.csv.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  )
}

export default function CatalogPage() {
  const [videos, setVideos] = useState<VideoRow[]>([])

  useEffect(() => {
    api.analyticsContent().then(setVideos).catch(() => {})
  }, [])

  const byEng = useMemo(
    () => [...videos].sort((a, b) => b.engagement_rate - a.engagement_rate),
    [videos],
  )

  const panels: Record<string, PanelDef> = {
    catalog: {
      title: 'Content Catalog',
      icon: <Clapperboard size={15} />,
      body: (
        <>
          <p className="mb-3 text-xs text-[#5b3a1a]/60">{videos.length} videos · sorted by views</p>
          <VideoTable rows={[...videos].sort((a, b) => b.views - a.views)} />
        </>
      ),
    },
    top: {
      title: 'Best & Worst',
      icon: <Trophy size={15} />,
      body: (
        <div className="space-y-5">
          <div>
            <h3 className="mb-2 text-xs font-bold tracking-widest text-green-800/70">TOP 5 ENGAGEMENT</h3>
            <VideoTable rows={byEng.slice(0, 5)} />
          </div>
          <div>
            <h3 className="mb-2 text-xs font-bold tracking-widest text-red-700/70">BOTTOM 5 ENGAGEMENT</h3>
            <VideoTable rows={byEng.slice(-5).reverse()} />
          </div>
        </div>
      ),
    },
  }

  return <RoomPage icon={<Clapperboard size={16} />} title="Warehouse — Content Catalog" config={config} panels={panels} />
}
