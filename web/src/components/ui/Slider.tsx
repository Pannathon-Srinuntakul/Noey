import { cn } from '../../lib/cn'

type SliderCore = {
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
  /** Rendered as the required 14px tabular label beside the track. */
  formatValue: (value: number) => string
  label?: string
  id?: string
  className?: string
}

type DisabledSlice =
  { disabled?: false; disabledReason?: never } | { disabled: true; disabledReason: string }

export type SliderProps = SliderCore & DisabledSlice

/* Electron ships Chromium only — no Firefox slider fallback needed. */
export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  formatValue,
  label,
  id,
  className,
  disabled,
  disabledReason
}: SliderProps): React.JSX.Element {
  const isDisabled = disabled === true
  const pct = ((value - min) / (max - min)) * 100

  return (
    <div className={className}>
      {label ? (
        <label htmlFor={id} className="mb-1.5 block text-sm text-muted">
          {label}
        </label>
      ) : null}
      <div className="flex items-center gap-3">
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={isDisabled}
          onChange={(e) => onChange(Number(e.target.value))}
          style={{
            // The inline background OVERRIDES the class bg entirely (shorthand
            // wins), so the unfilled side must carry its own visible color —
            // `transparent` here made the rail vanish into the page (live
            // report 2026-08-12: ขนาด slider in the caption panel).
            background: `linear-gradient(to right, var(--color-accent) ${pct}%, rgb(243 242 242 / 0.22) ${pct}%)`
          }}
          className={cn(
            // min-w-0: a range input has an intrinsic width (~129px in
            // Chromium) and `flex-1` alone will not shrink below it, so in a
            // narrow slider the row overflowed its own box and the value label
            // was painted on top of the control next to it (live report
            // 2026-08-13: "คำว่าวิ มันทับปุ่ม").
            'noey-slider h-[3px] min-w-0 flex-1 appearance-none rounded-[2px] bg-[rgb(243_242_242_/_0.22)] outline-none disabled:cursor-not-allowed',
            isDisabled && 'opacity-40'
          )}
        />
        <span className="flex-shrink-0 whitespace-nowrap text-sm tabular-nums text-ink">
          {formatValue(value)}
        </span>
      </div>
      {isDisabled && disabledReason ? (
        <p className="mt-1.5 text-xs text-muted">{disabledReason}</p>
      ) : null}
    </div>
  )
}
