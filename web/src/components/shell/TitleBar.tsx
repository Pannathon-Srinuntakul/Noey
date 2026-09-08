import { Menu } from 'lucide-react'
import { BrandMark } from '../ui/BrandMark'

/**
 * 38px title bar, cross-platform (HANDOFF §4).
 *
 * Windows: main/index.ts hides the native bar and draws caption buttons as an
 * overlay on the right; this strip fills the rest and stays draggable.
 * macOS: `hiddenInset` floats the traffic lights over the left of this strip,
 * so the label is padded clear of them.
 * Linux: keeps its native frame — this bar still renders for the screen
 * label/autosave note, just with no OS controls sharing it.
 */
export function TitleBar({
  label,
  rightNote,
  onMenu
}: {
  /** Current screen or open project name. */
  label: string
  /** Autosave note, right-aligned. */
  rightNote?: string
  /**
   * Opens the nav drawer. Passed only on a window too narrow to show the rail
   * beside the page — at every other width there is no button, so the bar is
   * unchanged.
   */
  onMenu?: () => void
}): React.JSX.Element {
  const isMac = window.noey.platform === 'darwin'

  return (
    <div
      data-app-chrome
      className="flex h-[38px] shrink-0 items-center justify-between border-b border-divider bg-surface px-3.5"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* macOS gets real traffic lights floated over this strip. Non-mac used to
          draw three fake dots imitating them; they were decoration that did
          nothing, so the brand mark carries this end of the bar instead.
          The mark belongs here — on Windows this strip replaces the native
          frame that would otherwise show the app icon. */}
      <span className={`flex min-w-0 flex-1 items-center gap-2 ${isMac ? 'pl-[68px]' : ''}`}>
        {onMenu ? (
          <button
            type="button"
            aria-label="เมนู"
            onClick={onMenu}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            className="-ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-[rgb(243_242_242_/_0.08)] hover:text-ink"
          >
            <Menu size={16} />
          </button>
        ) : null}
        <BrandMark size={14} className="shrink-0 text-accent" />
        <span className="truncate text-[13px] text-muted">{label}</span>
      </span>
      {rightNote ? <span className="shrink-0 pl-4 text-[13px] text-muted">{rightNote}</span> : null}
    </div>
  )
}
