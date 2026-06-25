import type { Dimension } from '../types'

interface Props {
  dimension: Dimension
  onDimension: (d: Dimension) => void
  view: '3d' | 'table'
  onView: (v: '3d' | 'table') => void
  start: string
  end: string
  onRange: (start: string, end: string) => void
}

const DIMS: Dimension[] = ['content', 'followers', 'viewers']

export function Filters({ dimension, onDimension, view, onView, start, end, onRange }: Props) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-black/50 p-2 backdrop-blur">
      <div className="flex gap-1">
        {DIMS.map((d) => (
          <button
            key={d}
            onClick={() => onDimension(d)}
            className={`rounded px-2 py-1 text-xs capitalize ${
              dimension === d ? 'bg-amber-500 text-black' : 'bg-white/5 text-zinc-300'
            }`}
          >
            {d}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1 text-xs text-zinc-300">
        <input
          type="date"
          value={start}
          onChange={(e) => onRange(e.target.value, end)}
          className="rounded bg-white/5 px-1 py-0.5"
        />
        <span>→</span>
        <input
          type="date"
          value={end}
          onChange={(e) => onRange(start, e.target.value)}
          className="rounded bg-white/5 px-1 py-0.5"
        />
      </div>
      <button
        onClick={() => onView(view === '3d' ? 'table' : '3d')}
        className="rounded bg-white/10 px-2 py-1 text-xs text-zinc-200"
      >
        {view === '3d' ? 'Table view' : '3D view'}
      </button>
    </div>
  )
}
