import { cn } from '../../lib/cn'

type SwitchCore = {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
  id?: string
}

type DisabledSlice =
  { disabled?: false; disabledReason?: never } | { disabled: true; disabledReason: string }

export type SwitchProps = SwitchCore & DisabledSlice

export function Switch({
  checked,
  onChange,
  label,
  id,
  disabled,
  disabledReason
}: SwitchProps): React.JSX.Element {
  const isDisabled = disabled === true

  return (
    <span className="inline-flex items-center gap-2.5">
      <button
        type="button"
        id={id}
        role="switch"
        aria-checked={checked}
        disabled={isDisabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'flex h-5 w-9 shrink-0 items-center rounded-full border p-[3px] transition-colors duration-state ease-out disabled:cursor-not-allowed',
          checked ? 'border-accent bg-[rgb(217_164_65_/_0.25)]' : 'border-border bg-transparent',
          isDisabled && 'border-border-faint bg-transparent'
        )}
      >
        <span
          className={cn(
            'h-3.5 w-3.5 rounded-full transition-transform duration-state ease-out',
            // 14px of travel, not 16: the 36px track spends 2px on its border
            // and 6px on padding, so translate-x-4 pushed the knob into them.
            checked ? 'translate-x-[14px]' : 'translate-x-0',
            isDisabled
              ? 'bg-[rgb(243_242_242_/_0.28)]'
              : checked
                ? 'bg-accent'
                : 'bg-[rgb(243_242_242_/_0.5)]'
          )}
        />
      </button>
      {label ? (
        <label
          htmlFor={id}
          className={cn('text-sm', isDisabled ? 'text-[rgb(243_242_242_/_0.4)]' : 'text-ink')}
        >
          {label}
        </label>
      ) : null}
      {isDisabled && disabledReason ? (
        <span className="text-xs text-muted">{disabledReason}</span>
      ) : null}
    </span>
  )
}
