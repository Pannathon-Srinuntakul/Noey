import { FolderOpen, Settings, Shapes } from 'lucide-react'
import { BrandMark } from '../ui/BrandMark'
import { cn } from '../../lib/cn'
import { useRouter } from '../../lib/router'
import { navGroupFor, type Route } from '../../lib/routes'
import { useNavSection } from '../../lib/navSection'
import { canUseStyles } from '../../lib/platformFeatures'

interface NavItem {
  key: 'projects' | 'library' | 'settings'
  label: string
  icon: React.ComponentType<{ size?: number; className?: string }>
  route: Route
}

const NAV_ITEMS: NavItem[] = [
  { key: 'projects', label: 'โปรเจกต์', icon: FolderOpen, route: { name: 'projects' } },
  ...(canUseStyles
    ? [{ key: 'library', label: 'สไตล์', icon: Shapes, route: { name: 'library' } } as NavItem]
    : []),
  { key: 'settings', label: 'ตั้งค่า', icon: Settings, route: { name: 'settings' } }
]

/**
 * Left nav, 208px (HANDOFF §4). Account block pins to the bottom above a
 * divider and shows the name only — no credit line anywhere in the UI.
 *
 * On a window too narrow to give it a column, the SAME rail slides in over the
 * page instead of being redesigned: 208px of nav beside a 390px screen leaves
 * no room for the work, but a different nav on small screens would be a second
 * design to keep in step with this one.
 */
export function NavRail({
  accountName,
  overlay = false,
  open = true,
  onNavigate
}: {
  accountName: string
  /** Draw over the page instead of beside it. */
  overlay?: boolean
  /** Overlay only: whether the drawer is showing. */
  open?: boolean
  /** Overlay only: called after any navigation, to close the drawer. */
  onNavigate?: () => void
}): React.JSX.Element {
  const { route, navigate } = useRouter()
  const activeGroup = navGroupFor(route)
  const section = useNavSection()

  const go = (to: Route): void => {
    navigate(to)
    onNavigate?.()
  }

  return (
    <nav
      data-app-chrome
      aria-hidden={overlay && !open}
      className={cn(
        'flex w-52 shrink-0 flex-col gap-5 border-r border-divider bg-surface px-3 py-5',
        // `top-[38px]`, not `inset-y-0`: the drawer used to cover the title
        // bar, which is where its own toggle lives — opening it made the
        // button that closes it unclickable, and the strip beside it belonged
        // to neither drawer nor scrim and swallowed taps.
        overlay &&
          'fixed bottom-0 left-0 top-[38px] z-40 shadow-[8px_0_24px_rgb(0_0_0_/_0.45)] transition-transform duration-150 ease-out',
        overlay && (open ? 'translate-x-0' : '-translate-x-full')
      )}
    >
      <div className="flex items-center gap-2.5 px-2">
        <BrandMark size={20} className="text-accent" />
        <span className="whitespace-nowrap font-display text-[19px] text-ink">Noey Studio</span>
      </div>

      <div className="flex flex-col gap-0.5">
        {NAV_ITEMS.map((item) => {
          const active = activeGroup === item.key
          const Icon = item.icon
          return (
            <button
              key={item.key}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => go(item.route)}
              className={cn(
                'flex h-11 items-center gap-2.5 rounded-md px-2.5 text-[15px] transition-colors duration-state ease-out md:h-10',
                active
                  ? 'bg-accent-nav font-semibold text-accent shadow-[inset_2px_0_0_var(--color-accent)]'
                  : 'text-ink-3 hover:bg-[rgb(243_242_242_/_0.06)]'
              )}
            >
              <Icon size={17} />
              {item.label}
            </button>
          )
        })}
      </div>

      {/* Page-contributed sub-nav (the library's categories) — no icons, count
          on the right, and a divider so it doesn't read as more app nav. */}
      {section && (
        <div className="flex flex-col gap-0.5 border-t border-divider pt-4">
          <p className="mb-1.5 px-2.5 text-[13px] text-muted">{section.title}</p>
          {section.items.map((item) => {
            const active = item.id === section.activeId
            return (
              <button
                key={item.id}
                type="button"
                aria-current={active ? 'true' : undefined}
                onClick={() => {
                  section.onSelect(item.id)
                  onNavigate?.()
                }}
                className={cn(
                  // 44px in the overlay drawer, where these are touched; the
                  // design's 36px from `md` up, where they are clicked.
                  'flex h-11 items-center gap-2 rounded-md px-2.5 text-[14px] transition-colors duration-state ease-out md:h-9',
                  // Deliberately quieter than the nav rows above: a neutral
                  // wash, no accent tint and no inset bar, so "where am I"
                  // reads at two levels and the accent bar stays the nav's.
                  active
                    ? 'bg-[rgb(243_242_242_/_0.06)] font-semibold text-ink'
                    : 'text-ink-3 hover:bg-[rgb(243_242_242_/_0.06)]'
                )}
              >
                <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
                <span className="shrink-0 text-sm tabular-nums text-muted">{item.count || ''}</span>
              </button>
            )
          })}
        </div>
      )}

      <div className="mt-auto border-t border-divider pt-3.5">
        <div className="flex items-center gap-2.5 px-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-full border border-border font-display text-[17px] text-accent">
            {accountName.slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0 truncate text-[15px] text-ink">{accountName}</span>
        </div>
      </div>
    </nav>
  )
}
