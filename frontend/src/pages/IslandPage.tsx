import { Film, Palmtree } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { ChatPanel } from '../hud/ChatPanel'
import { MetricBar } from '../hud/MetricBar'
import { PromptCron } from '../hud/PromptCron'
import { IslandWorld } from '../scene/IslandWorld'
import { useNavigateWithDoor } from '../navigation/NavigationContext'
import type { Entity, RoomName, TiktokOverview, VideoRow } from '../types'

const ROOM_ROUTES: Record<Exclude<RoomName, 'revenue'>, string> = {
  catalog: '/catalog',
  market: '/market',
  settings: '/settings',
  account: '/import',
  tables: '/tables',
}

export default function IslandPage() {
  const { navigateWithDoor } = useNavigateWithDoor()

  const [tiktokOverview, setTiktokOverview] = useState<TiktokOverview | null>(null)
  const [entities, setEntities] = useState<Entity[]>([])
  const [activity, setActivity] = useState(0)
  const [tab, setTab] = useState<'chat' | 'cron'>('chat')
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const [ov, videos, runs] = await Promise.all([
        api.analyticsOverview(),
        api.analyticsContent(undefined, undefined, 50),
        api.listRuns(),
      ])
      setTiktokOverview(ov)
      setActivity(runs.length)
      setEntities(
        videos.map((v) => ({
          id: v.video_id,
          label: v.video_title || v.video_id,
          views: v.views,
          engagementRate: v.engagement_rate,
        })),
      )
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Refresh data when CSV import completes in another route
  useEffect(() => {
    const handler = () => load()
    window.addEventListener('data-imported', handler)
    return () => window.removeEventListener('data-imported', handler)
  }, [load])

  return (
    <div className="relative h-full w-full overflow-hidden">
      <div className="absolute inset-0">
        <IslandWorld
          activity={activity}
          onSelectChest={() => navigateWithDoor('/revenue')}
          onOpenRoom={(room) => {
            const route = ROOM_ROUTES[room as Exclude<RoomName, 'revenue'>]
            if (route) navigateWithDoor(route)
          }}
        />
      </div>

      {/* top HUD */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-3">
        <div className="pointer-events-auto">
          <h1 className="mb-2 flex items-center gap-1.5 font-bold tracking-wide text-amber-200"><Palmtree size={16} /> Creator Island</h1>
          <MetricBar overview={tiktokOverview} />
        </div>
        <div className="pointer-events-auto flex items-center gap-2">
          <span className="text-xs text-zinc-300/80">Click a building to enter a room</span>
          <button
            onClick={() => navigateWithDoor('/videos')}
            className="flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-black/40 px-3 py-1.5 text-xs font-medium text-amber-300 backdrop-blur hover:border-amber-400 hover:bg-black/60"
          >
            <Film size={13} /> AI Video Editor
          </button>
        </div>
      </div>

      {error && (
        <div className="absolute left-3 top-28 rounded bg-red-500/20 px-3 py-1 text-xs text-red-200">
          API: {error}
        </div>
      )}

      {/* right sidebar */}
      <div
        className={`absolute right-3 top-24 bottom-3 flex w-80 flex-col overflow-hidden rounded-xl border ${
          tab === 'chat' ? 'border-[#5b3a1a]/35' : 'border-white/10 bg-black/60 backdrop-blur'
        }`}
        style={tab === 'chat' ? { background: 'linear-gradient(160deg, rgba(245,233,203,0.97) 0%, rgba(225,205,158,0.97) 100%)' } : undefined}
      >
        <div
          className={`flex gap-1 border-b p-2 ${
            tab === 'chat' ? 'border-[#5b3a1a]/25' : 'border-white/10'
          }`}
          style={tab === 'chat' ? { background: 'linear-gradient(180deg, #4a2e0c, #5b3a1a)' } : undefined}
        >
          {(['chat', 'cron'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 rounded px-2 py-1 text-xs ${
                tab === t
                  ? t === 'chat'
                    ? 'bg-[#fffaf0] font-medium text-[#5b3a1a]'
                    : 'bg-amber-500 text-black'
                  : t === 'chat' && tab === 'cron'
                    ? 'bg-white/10 text-amber-100/80 hover:bg-white/15'
                    : 'bg-white/5 text-zinc-300'
              }`}
            >
              {t === 'chat' ? 'Chat' : 'Prompt-cron'}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1">{tab === 'chat' ? <ChatPanel /> : <PromptCron />}</div>
      </div>
    </div>
  )
}
