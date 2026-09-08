import { Loader2 } from 'lucide-react'
import { cn } from '../lib/cn'
import { fmtSize, KINDS, type Artifact, type KindRow } from '../lib/artifacts'
import { Checkbox } from './ui/Checkbox'

export function ArtifactChecklist({
  artifacts,
  rows,
  checked,
  onToggle,
  emptyNote
}: {
  /** null while still reading the project dir. */
  artifacts: Artifact[] | null
  rows: Map<Artifact['kind'], KindRow>
  checked: Set<Artifact['kind']>
  onToggle: (kind: Artifact['kind']) => void
  emptyNote: string
}): React.JSX.Element {
  if (artifacts === null) {
    return (
      <div className="flex h-[200px] items-center justify-center gap-2 text-sm text-muted">
        <Loader2 size={15} className="animate-spin" /> กำลังอ่านไฟล์…
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2.5">
      {KINDS.map((def) => {
        const row = rows.get(def.kind)
        const isOn = row !== undefined && checked.has(def.kind)
        const available = row !== undefined
        return (
          // The whole row is the target, not just the 18px box — a checklist of
          // full-width cards reads as clickable cards, and aiming at the box is
          // the kind of precision nobody should need. The row owns the role and
          // the click; the Checkbox only draws the state.
          <button
            key={def.kind}
            type="button"
            role="checkbox"
            aria-checked={isOn}
            disabled={!available}
            onClick={() => onToggle(def.kind)}
            className={cn(
              'flex w-full items-center gap-3.5 rounded-md border px-4 py-3.5 text-left transition-colors duration-state ease-out',
              // Ticked rows carry the accent border + tint (R5). The tint is
              // 0.08, not the 0.12 accent-tint token — across a full-width row
              // 0.12 reads as a filled button.
              isOn
                ? 'border-accent bg-[rgb(217_164_65_/_0.08)]'
                : available
                  ? 'border-divider hover:border-[rgb(243_242_242_/_0.28)] hover:bg-[rgb(243_242_242_/_0.03)]'
                  : 'cursor-not-allowed border-border-faint'
            )}
          >
            <Checkbox indicatorOnly checked={isOn} onChange={() => onToggle(def.kind)} />
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  'text-[15px]',
                  row ? 'text-ink' : 'text-muted',
                  isOn && 'font-semibold'
                )}
              >
                {row?.label ?? def.label}
              </p>
              <p className="mt-0.5 text-sm text-muted">
                {row ? def.blurb : 'โปรเจกต์นี้ยังไม่มีไฟล์นี้'}
              </p>
            </div>
            <span className="shrink-0 text-sm tabular-nums text-muted">
              {row ? fmtSize(row.totalSize) : '—'}
            </span>
          </button>
        )
      })}
      {rows.size === 0 ? <p className="pt-2 text-sm text-muted">{emptyNote}</p> : null}
    </div>
  )
}
