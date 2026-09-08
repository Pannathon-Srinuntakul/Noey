import { Check } from 'lucide-react'
import { cn } from '../../lib/cn'

export interface CheckboxProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
  id?: string
  disabled?: boolean
  /** Render as a plain indicator, not a control. For rows where the whole row
   * is the clickable target — a <button> inside a <button> is invalid HTML,
   * so the parent owns the click, the role and the focus, and this only draws
   * the box. */
  indicatorOnly?: boolean
}

const BOX =
  'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[3px] border transition-colors duration-state ease-out'

export function Checkbox({
  checked,
  onChange,
  label,
  id,
  disabled = false,
  indicatorOnly = false
}: CheckboxProps): React.JSX.Element {
  const tone = checked
    ? 'border-accent bg-[rgb(217_164_65_/_0.16)]'
    : 'border-[rgb(243_242_242_/_0.4)] bg-transparent'
  const mark = checked ? <Check size={12} className="text-accent" strokeWidth={3} /> : null

  if (indicatorOnly) {
    return (
      <span aria-hidden className={cn(BOX, tone)}>
        {mark}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-2.5">
      <button
        type="button"
        id={id}
        role="checkbox"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(BOX, 'disabled:cursor-not-allowed', tone)}
      >
        {mark}
      </button>
      {label ? (
        <label htmlFor={id} className="text-sm text-ink">
          {label}
        </label>
      ) : null}
    </span>
  )
}
