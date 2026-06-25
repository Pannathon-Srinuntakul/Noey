import type { TiktokOverview } from '../types'

const fmtNum = (n: number) => n.toLocaleString()
const fmtPct = (r: number) => `${(r * 100).toFixed(2)}%`

export function MetricBar({ overview }: { overview: TiktokOverview | null }) {
  return (
    <div className="flex gap-3">
      <Tile label="VIDEO VIEWS" value={overview ? fmtNum(overview.total_video_views) : '—'} />
      <Tile
        label="FOLLOWERS"
        value={
          overview?.current_followers != null ? fmtNum(overview.current_followers) : '—'
        }
      />
      <Tile
        label="AVG ENGAGEMENT"
        value={overview ? fmtPct(overview.avg_engagement_rate) : '—'}
      />
    </div>
  )
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/50 px-4 py-2 backdrop-blur">
      <div className="text-[10px] tracking-widest text-zinc-400">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  )
}
