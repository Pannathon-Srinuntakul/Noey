import type { TiktokOverview, VideoRow } from '../types'

const fmtNum = (n: number) => n.toLocaleString()
const fmtPct = (r: number) => `${(r * 100).toFixed(2)}%`

export function RevenueOverlay({
  overview,
  videos,
  onClose,
}: {
  overview: TiktokOverview | null
  videos: VideoRow[]
  onClose: () => void
}) {
  const top = videos.slice(0, 6)
  return (
    <div
      className="absolute inset-0 z-30 grid place-items-center bg-black/55 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[min(92vw,520px)] rounded-2xl border border-amber-400/30 bg-[#0d1626] p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold text-amber-300">💰 Treasure — Top Videos</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-white">
            ✕
          </button>
        </div>

        <div className="mb-5 grid grid-cols-3 gap-3">
          <Stat k="VIDEO VIEWS" v={overview ? fmtNum(overview.total_video_views) : '—'} accent />
          <Stat
            k="FOLLOWERS"
            v={overview?.current_followers != null ? fmtNum(overview.current_followers) : '—'}
          />
          <Stat
            k="AVG ENGAGEMENT"
            v={overview ? fmtPct(overview.avg_engagement_rate) : '—'}
          />
        </div>

        <h3 className="mb-2 text-xs tracking-widest text-zinc-400">TOP VIDEOS BY VIEWS</h3>
        <ul className="space-y-1">
          {top.map((v) => (
            <li
              key={v.video_id}
              className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-2 text-sm"
            >
              <a
                href={v.video_url}
                target="_blank"
                rel="noopener noreferrer"
                className="truncate hover:text-amber-200"
              >
                {v.video_title || v.video_id}
              </a>
              <span className="ml-3 shrink-0 tabular-nums text-amber-200">
                {fmtNum(v.views)}
              </span>
            </li>
          ))}
          {top.length === 0 && (
            <li className="text-zinc-500">No video data yet. Upload a CSV to get started.</li>
          )}
        </ul>
      </div>
    </div>
  )
}

function Stat({ k, v, accent }: { k: string; v: string; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/30 px-3 py-3 text-center">
      <div className="text-[10px] tracking-widest text-zinc-400">{k}</div>
      <div className={`mt-1 text-lg font-bold tabular-nums ${accent ? 'text-amber-300' : ''}`}>
        {v}
      </div>
    </div>
  )
}
