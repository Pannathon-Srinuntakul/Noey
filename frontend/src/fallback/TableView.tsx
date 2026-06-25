import type { Entity } from '../types'

const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 })

/** 2D fallback — all data usable without WebGL / for quick scanning. */
export function TableView({ entities, onSelect }: { entities: Entity[]; onSelect: (e: Entity) => void }) {
  if (entities.length === 0) {
    return <div className="p-8 text-center text-zinc-500">No data yet.</div>
  }
  return (
    <div className="h-full overflow-auto p-4">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-[#07080d] text-left text-xs text-zinc-400">
          <tr>
            <th className="py-2">Name</th>
            <th className="py-2 text-right">GMV</th>
            <th className="py-2 text-right">Commission</th>
            <th className="py-2 text-right">Units</th>
            <th className="py-2 text-right">Rate</th>
          </tr>
        </thead>
        <tbody>
          {entities.map((e) => (
            <tr
              key={e.id}
              onClick={() => onSelect(e)}
              className="cursor-pointer border-t border-white/5 hover:bg-white/5"
            >
              <td className="py-1.5">{e.label}</td>
              <td className="py-1.5 text-right tabular-nums">฿{fmt(e.gmv)}</td>
              <td className="py-1.5 text-right tabular-nums">฿{fmt(e.commission)}</td>
              <td className="py-1.5 text-right tabular-nums">{fmt(e.units)}</td>
              <td className="py-1.5 text-right tabular-nums">
                {e.commissionRate == null ? '—' : `${(e.commissionRate / 100).toFixed(2)}%`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
