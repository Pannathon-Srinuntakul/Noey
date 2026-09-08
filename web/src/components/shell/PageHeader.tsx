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
          //
          // `break-words` is what makes wrapping actually apply here. Project
          // names are generated from the source filename and carry no spaces
          // at all — `quality_restoration_25690818174324447` is ONE word, so
          // normal wrapping has nowhere to break and it ran straight off the
          // right edge of an iPhone (live report 2026-09-09). Capped at two
          // lines so a long name cannot push the whole page down; the full name
          // stays reachable as the element's own title.
          title={title}
          // `line-clamp-1` above `sm`, not `truncate`: they fight over
          // `overflow` and Tailwind, not the class order here, decides which
          // wins. Same one line with an ellipsis, one utility family.
          className={`line-clamp-2 break-words text-[22px] font-semibold leading-[1.2] text-ink sm:line-clamp-1 sm:text-[34px] sm:leading-[1.15] ${
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
