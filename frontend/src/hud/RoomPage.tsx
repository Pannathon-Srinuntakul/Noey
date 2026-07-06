import { ArrowLeft, X } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigateWithDoor } from '../navigation/NavigationContext'
import { InteractiveRoom } from '../scene/InteractiveRoom'
import type { RoomConfig } from '../scene/InteractiveRoom'

export interface PanelDef {
  title: string
  icon?: ReactNode
  body: ReactNode
}

export function RoomPage({
  title,
  icon,
  config,
  panels,
}: {
  title: string
  icon: ReactNode
  config: RoomConfig
  panels: Record<string, PanelDef>
}) {
  const { navigateWithDoor } = useNavigateWithDoor()
  const [active, setActive] = useState<string | null>(null)
  const panel = active ? panels[active] : null

  return (
    <div className="relative h-full w-full overflow-hidden">
      {/* 3D interactive room */}
      <InteractiveRoom config={config} active={active} onSelect={setActive} />

      {/* Top header */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-between px-5 py-3"
        style={{
          background: 'linear-gradient(180deg, rgba(20,12,4,0.7) 0%, rgba(20,12,4,0) 100%)',
        }}
      >
        <button
          onClick={() => navigateWithDoor('/')}
          className="pointer-events-auto flex items-center gap-1.5 rounded-lg border border-amber-300/30 bg-black/40 px-3 py-1.5 text-sm font-medium text-amber-200 backdrop-blur transition hover:bg-black/60"
        >
          <ArrowLeft size={14} /> Island
        </button>
        <h1 className="text-sm font-bold tracking-widest text-amber-100 drop-shadow-lg">
          {icon} {title}
        </h1>
        <div className="w-20" />
      </div>

      {/* Hint */}
      {!panel && (
        <div className="pointer-events-none absolute inset-x-0 bottom-5 z-10 flex justify-center px-4">
          <span
            style={{ maxWidth: 'calc(100vw - 2rem)' }}
            className="rounded-full bg-black/45 px-4 py-1.5 text-center text-xs text-amber-100/80 backdrop-blur"
          >
            🖱️ Drag to look around · click a glowing object to open its data
          </span>
        </div>
      )}

      {/* Slide-in data panel */}
      <div
        className={`absolute right-0 top-0 z-20 flex h-full w-full max-w-md flex-col transition-transform duration-300 ease-out ${
          panel ? 'translate-x-0' : 'translate-x-full'
        }`}
        style={{
          background: 'linear-gradient(160deg, rgba(245,233,203,0.97) 0%, rgba(225,205,158,0.97) 100%)',
          backdropFilter: 'blur(10px)',
          borderLeft: '3px solid #5b3a1a',
          boxShadow: '-12px 0 40px rgba(0,0,0,0.55)',
        }}
      >
        {panel && (
          <>
            <div
              className="flex shrink-0 items-center justify-between px-5 py-3"
              style={{ background: 'linear-gradient(180deg,#4a2e0c,#5b3a1a)' }}
            >
              <h2 className="font-bold tracking-wide text-amber-100">
                {panel.icon} {panel.title}
              </h2>
              <button
                onClick={() => setActive(null)}
                className="rounded p-1 text-amber-200/80 hover:bg-white/10"
              >
                <X size={16} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-5 text-[#3a2a14]">{panel.body}</div>
          </>
        )}
      </div>
    </div>
  )
}
