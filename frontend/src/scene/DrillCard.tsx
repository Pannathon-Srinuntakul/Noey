import { Html } from '@react-three/drei'
import { X } from 'lucide-react'
import type { Entity } from '../types'

const fmtNum = (n: number) => n.toLocaleString()
const fmtPct = (r: number) => `${(r * 100).toFixed(2)}%`

/** Floating drill-in card anchored at the data world origin (top-center overlay). */
export function DrillCard({ entity, onClose }: { entity: Entity; onClose: () => void }) {
  return (
    <Html center position={[0, 4.2, 0]} distanceFactor={12} zIndexRange={[100, 0]}>
      <div className="w-64 rounded-xl border border-white/10 bg-black/80 p-3 text-sm text-zinc-100 shadow-xl backdrop-blur">
        <div className="mb-2 flex items-start justify-between gap-2">
          <span className="font-medium leading-tight">{entity.label}</span>
          <button onClick={onClose} className="text-zinc-400 hover:text-white" aria-label="close">
            <X size={14} />
          </button>
        </div>
        <dl className="space-y-1">
          <Row k="Views" v={fmtNum(entity.views)} />
          <Row k="Engagement" v={fmtPct(entity.engagementRate)} />
        </dl>
      </div>
    </Html>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-zinc-400">{k}</dt>
      <dd className="tabular-nums">{v}</dd>
    </div>
  )
}
