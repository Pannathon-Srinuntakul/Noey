import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

type FieldChromeProps = {
  label?: string
  error?: string
}

type DisabledSlice =
  { disabled?: false; disabledReason?: never } | { disabled: true; disabledReason: string }

function FieldLabel({ label, id }: { label?: string; id?: string }): React.JSX.Element | null {
  if (!label) return null
  return (
    <label htmlFor={id} className="mb-1.5 block text-sm text-muted">
      {label}
    </label>
  )
}

function FieldError({ error }: { error?: string }): React.JSX.Element | null {
  if (!error) return null
  return <p className="mt-1.5 text-[13px] text-error">{error}</p>
}

function FieldReason({
  disabled,
  disabledReason
}: {
  disabled?: boolean
  disabledReason?: string
}): React.JSX.Element | null {
  if (!disabled || !disabledReason) return null
  return <p className="mt-1.5 text-xs text-muted">{disabledReason}</p>
}

/**
 * Focus is ONE ring, and it is the OUTER one.
 *
 * `assets/main.css` already draws a global `*:focus-visible` outline (2px
 * accent, 2px offset) around every focusable thing. A field that ALSO turned
 * its own border accent on focus therefore drew a second gold ring just inside
 * the first — the double border reported live on 2026-08-13. (An accent
 * box-shadow was a third layer; that went in the same pass.) The resting
 * border stays neutral through focus, so only the global outline moves.
 */
const FIELD_BORDER = 'border-border'
const FIELD_DISABLED =
  'disabled:cursor-not-allowed disabled:border-border-faint disabled:text-[rgb(243_242_242_/_0.4)]'

/**
 * Height + type scale, owned here rather than passed as a class.
 *
 * `cn()` does no Tailwind-conflict merging, so an `h-11` handed in through
 * `className` would leave `h-10` in play as well and the winner would be
 * whichever utility Tailwind happened to emit later — stable today only because
 * the scale is ordered ascending, and wrong the moment a design wants a shorter
 * field. A prop has one answer.
 *
 * Not called `size`: that is a real `<input>` attribute (character width) and is
 * already part of `InputHTMLAttributes`.
 */
const FIELD_SIZE = {
  md: 'h-10 text-[15px]',
  lg: 'h-11 text-[16px]'
} as const

export type FieldSize = keyof typeof FIELD_SIZE

export type InputProps = FieldChromeProps &
  DisabledSlice & { fieldSize?: FieldSize } & Omit<
    InputHTMLAttributes<HTMLInputElement>,
    'disabled'
  >

export function Input({
  label,
  error,
  disabled,
  disabledReason,
  fieldSize = 'md',
  id,
  className,
  ...rest
}: InputProps): React.JSX.Element {
  return (
    <div>
      <FieldLabel label={label} id={id} />
      <input
        id={id}
        disabled={disabled === true}
        className={cn(
          'w-full rounded-md border bg-transparent px-3 text-ink outline-none transition-colors duration-state ease-out',
          FIELD_SIZE[fieldSize],
          error ? 'border-error' : FIELD_BORDER,
          FIELD_DISABLED,
          className
        )}
        {...rest}
      />
      <FieldError error={error} />
      <FieldReason disabled={disabled === true} disabledReason={disabledReason} />
    </div>
  )
}

export type TextareaProps = FieldChromeProps &
  DisabledSlice &
  Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'disabled'>

export function Textarea({
  label,
  error,
  disabled,
  disabledReason,
  id,
  className,
  ...rest
}: TextareaProps): React.JSX.Element {
  return (
    <div>
      <FieldLabel label={label} id={id} />
      <textarea
        id={id}
        disabled={disabled === true}
        className={cn(
          'min-h-16 w-full resize-none rounded-md border bg-transparent px-3 py-2.5 text-[15px] leading-[1.5] text-ink outline-none transition-colors duration-state ease-out',
          error ? 'border-error' : FIELD_BORDER,
          FIELD_DISABLED,
          className
        )}
        {...rest}
      />
      <FieldError error={error} />
      <FieldReason disabled={disabled === true} disabledReason={disabledReason} />
    </div>
  )
}
