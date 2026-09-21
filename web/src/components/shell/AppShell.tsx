import { useEffect, useState } from 'react'
import type { Session } from '../../App'
import { useJobs } from '../../lib/jobs'
import { useReloadGuard } from '../../lib/reloadGuard'
import { useRouter } from '../../lib/router'
import { useIsCompact } from '../../lib/useMediaQuery'
import { routeHasNav } from '../../lib/routes'
import { NavSectionProvider } from './NavSectionProvider'
import { NavRail } from './NavRail'
import { TitleBar } from './TitleBar'

/** Title-bar label per screen. Project-scoped screens append the project
 * name once it is known. */
function useTitleBarLabel(): string {
  const { route } = useRouter()
  const { jobFor } = useJobs()
  const name = 'uid' in route ? (jobFor(route.uid)?.project.name ?? '') : ''

  switch (route.name) {
    case 'projects':
      return 'โปรเจกต์'
    case 'wizard':
      return 'สร้างวิดีโอใหม่'
    case 'library':
      return 'สไตล์'
    case 'settings':
      return 'ตั้งค่า'
    case 'progress':
      return name ? `${name} · กำลังทำงาน` : 'กำลังทำงาน'
    case 'timeline':
      return name ? `แก้ไขวิดีโอ — ${name}` : 'แก้ไขวิดีโอ'
    case 'effectsClip':
      return name ? `เอฟเฟกต์ — ${name}` : 'เอฟเฟกต์'
    case 'voiceover':
      return name ? `อัดเสียงพากย์ — ${name}` : 'อัดเสียงพากย์'
    case 'detail':
      return name || 'โปรเจกต์'
    default:
      return 'Noey Video Edit'
  }
}

export function AppShell({
  session,
  children
}: {
  session: Session
  children: React.ReactNode
}): React.JSX.Element {
  const { route, navigate } = useRouter()
  useReloadGuard()
  const label = useTitleBarLabel()
  const compact = useIsCompact()
  const showNav = routeHasNav(route)

  // The drawer records WHERE it was opened — which screen, and at which width.
  // Both ways it has to close then fall out of that: navigating changes the
  // screen, and widening the window puts the rail back in its own column.
  //
  // The reset happens during render, not in an effect. Chasing it with an
  // effect means a first paint that still shows the drawer, and a lint rule
  // that (rightly) calls it a cascading render.
  const [openAt, setOpenAt] = useState<{ route: string; compact: boolean } | null>(null)
  if (openAt && (openAt.route !== route.name || openAt.compact !== compact)) {
    setOpenAt(null)
  }
  const navOpen = compact && openAt !== null
  const closeNav = (): void => setOpenAt(null)

  // Clicking an OS notification focuses the window and lands on that project.
  useEffect(() => {
    return window.noey.notify.onActivated((uid) => navigate({ name: 'detail', uid }))
  }, [navigate])

  return (
    <NavSectionProvider>
      <div className="flex h-full flex-col bg-ground">
        {/* R2 puts "ยกเลิก (Esc)" on the right of the wizard's title bar. It
            stays a note rather than a control: the whole bar is an OS drag
            region, and Esc (WizardPage) is the affordance it names. */}
        <TitleBar
          label={label}
          rightNote={route.name === 'wizard' ? 'ยกเลิก (Esc)' : undefined}
          onMenu={
            showNav && compact
              ? () => setOpenAt(navOpen ? null : { route: route.name, compact })
              : undefined
          }
        />
        <div className="relative flex min-h-0 flex-1">
          {showNav ? (
            <NavRail
              accountName={session.profile.email.split('@')[0]}
              overlay={compact}
              open={navOpen}
              onNavigate={closeNav}
            />
          ) : null}
          {/* Tapping the page is how a drawer is dismissed everywhere else. */}
          {showNav && compact && navOpen ? (
            <button
              type="button"
              aria-label="ปิดเมนู"
              onClick={closeNav}
              className="absolute inset-0 z-30 bg-[rgb(0_0_0_/_0.5)]"
            />
          ) : null}
          <main className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</main>
        </div>
      </div>
    </NavSectionProvider>
  )
}
