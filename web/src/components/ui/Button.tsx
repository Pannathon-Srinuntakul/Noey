import { Loader2 } from 'lucide-react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { Tooltip } from './Tooltip'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary:
    'border border-accent bg-accent-tint text-accent hover:bg-accent-tint-hover hover:text-accent-hover-text active:border-accent-press active:bg-accent-tint-press disabled:border-[rgb(217_164_65_/_0.4)] disabled:bg-[rgb(217_164_65_/_0.06)] disabled:text-[rgb(217_164_65_/_0.55)]',
  secondary:
    'border border-border text-ink hover:border-border-strong hover:bg-[rgb(243_242_242_/_0.06)] active:bg-[rgb(243_242_242_/_0.12)] disabled:border-border-faint disabled:text-[rgb(243_242_242_/_0.4)]',
  ghost: 'text-muted hover:bg-[rgb(243_242_242_/_0.06)] disabled:text-[rgb(243_242_242_/_0.4)]',
  danger:
    'border border-error bg-error-tint text-error hover:bg-[rgb(224_139_132_/_0.2)] disabled:border-[rgb(224_139_132_/_0.4)] disabled:text-[rgb(224_139_132_/_0.55)]'
}

type ButtonCore = {
  variant?: ButtonVariant
  loading?: boolean
  icon?: ReactNode
  children?: ReactNode
  /**
   * Where a disabled button's reason goes. Default `text` is the HANDOFF §3
   * contract: a 12px reason beside the button.
   *
   * `tooltip` is for **toolbar rows** — several controls side by side, where an
   * inline reason per control pushes the row apart and repeats itself. Same
   * reasoning Chip already uses. The reason is still required; only its
   * placement changes, so nothing can ship a disabled control with no
   * explanation.
   */
  reasonAs?: 'text' | 'tooltip'
  /**
   * Row height. `md` (40px/15px) is the app default; `sm` (36px/14px) is the
   * size R6's stacked card actions are drawn at. A size lives here rather than
   * in a caller's className because `cn` does not merge conflicting Tailwind
   * utilities — an `h-9` passed in would lose to the base `h-10`.
   */
  size?: 'md' | 'sm'
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled' | 'aria-label'>

// A disabled primary must show a reason beside it (HANDOFF §3 Button); make
// that structurally impossible to skip rather than relying on call sites
// remembering.
//
// Because this is a discriminated union, a conditional spread
// (`{...(cond ? { disabled: true, disabledReason: r } : {})}`) will NOT
// typecheck — TypeScript cannot narrow a union through a JSX spread. For a
// button that is disabled only sometimes, branch on the whole element:
//
//   reason ? <Button disabled disabledReason={reason}>…</Button>
//          : <Button onClick={fn}>…</Button>
type DisabledSlice =
  { disabled?: false; disabledReason?: never } | { disabled: true; disabledReason: string }

// icon-only needs an aria-label — `title` alone is not acceptable (HANDOFF §3).
type IconOnlySlice =
  { iconOnly?: false; 'aria-label'?: string } | { iconOnly: true; 'aria-label': string }

export type ButtonProps = ButtonCore & DisabledSlice & IconOnlySlice

export function Button({
  variant = 'secondary',
  reasonAs = 'text',
  size = 'md',
  loading = false,
  icon,
  iconOnly = false,
  children,
  disabled,
  disabledReason,
  className,
  'aria-label': ariaLabel,
  ...rest
}: ButtonProps): React.JSX.Element {
  const isDisabled = disabled === true || loading

  const button = (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={isDisabled}
        aria-label={ariaLabel}
        aria-busy={loading || undefined}
        className={cn(
          'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md font-semibold transition-colors duration-state ease-out disabled:cursor-not-allowed',
          size === 'sm' ? 'h-9 text-sm' : 'h-10 text-[15px]',
          iconOnly ? 'min-w-11 px-0' : variant === 'primary' ? 'px-5' : 'px-4',
          VARIANT_CLASS[variant],
          className
        )}
        {...rest}
      >
        {loading ? <Loader2 size={16} className="animate-spin" /> : icon}
        {!iconOnly && children}
      </button>
      {disabled === true && disabledReason && reasonAs === 'text' ? (
        <span className="text-xs text-muted">{disabledReason}</span>
      ) : null}
    </span>
  )

  // A disabled control swallows pointer events, so the tooltip has to hang off
  // the wrapper — the same shape Chip uses.
  if (disabled === true && disabledReason && reasonAs === 'tooltip') {
    return <Tooltip content={disabledReason}>{button}</Tooltip>
  }
  return button
}
