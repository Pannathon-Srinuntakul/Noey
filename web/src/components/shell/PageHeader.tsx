import { ArrowLeft } from 'lucide-react'

/** Standard content-screen header (HANDOFF §4): padding 28/32/18, bottom
 * divider, 34px title, primary action right. Screens that sit under another
 * (detail, progress) pass `backLabel` for the "← โปรเจกต์ทั้งหมด" link and
 * use the tighter 24px top padding the mockups show for that variant. */
export function PageHeader({
  title,
  subtitle,
  backLabel,
  onBack,
  actions
}: {
  title: string
  subtitle?: React.ReactNode
  backLabel?: string
  onBack?: () => void
  actions?: React.ReactNode
}): React.JSX.Element {
  return (
    // Wraps rather than shrinks below `sm`: the action is a real control and a
    // squeezed one is worse than one on its own row. Above `sm` the row is
    // exactly as it was.
    <div
      className={`flex shrink-0 flex-wrap items-end justify-between gap-x-4 gap-y-3 border-b border-divider px-5 pb-[18px] sm:flex-nowrap sm:px-8 ${
        backLabel ? 'pt-6' : 'pt-7'
      }`}
    >
      <div className="min-w-0">
        {backLabel && onBack ? (
          <button
            type="button"
            onClick={onBack}
            // 20px tall and hover-only: half the touch floor, and a mistap on
            // a phone produced no feedback at all.
            className="-ml-2 inline-flex min-h-11 items-center gap-[7px] rounded-md px-2 text-sm text-muted transition-colors duration-state ease-out hover:text-ink active:bg-[rgb(243_242_242_/_0.06)] md:-ml-1 md:min-h-0 md:px-1"
          >
            <ArrowLeft size={14} />
            {backLabel}
          </button>
        ) : null}
        <h1
          // Wraps below `sm` rather than truncating: a generated 32-char
          // project name was cut to a few characters with no tooltip and no
          // second line.
          className={`text-[22px] font-semibold leading-[1.2] text-ink sm:truncate sm:text-[34px] sm:leading-[1.15] ${
            backLabel ? 'mt-1.5' : ''
          }`}
        >
          {title}
        </h1>
        {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-3">{actions}</div> : null}
    </div>
  )
}
