import { lazy, Suspense } from 'react'
import type { Session } from '../../App'
import { useRouter } from '../../lib/router'

// Lazy on purpose. The zoom editor and everything under it — the canvas
// editor, the transform catalog, the effects pipeline — is ~3,000 lines that
// only `canUseZoomEffects` can reach, and that is constant false in a browser.
// A static import put all of it in the first chunk every visitor downloads.
const EffectsClipRoute = lazy(() => import('../../pages/EffectsClipRoute'))
import EffectsStudioPage from '../../pages/EffectsStudioPage'
import JobProgressPage from '../../pages/JobProgressPage'
import ProjectDetailPage from '../../pages/ProjectDetailPage'
import ProjectsPage from '../../pages/ProjectsPage'
import SettingsPage from '../../pages/SettingsPage'
import TimelineRoute from '../../pages/TimelineRoute'
import VoiceoverPage from '../../pages/VoiceoverPage'
import { canRecordVoiceover } from '../../lib/platformFeatures'
import WizardPage from '../../pages/WizardPage'

/** Screens the router knows about but later chunks build (PLAN.md 4–10).
 * Reachable only if something navigates there early — better a labelled stub
 * than a blank frame. */
function NotBuiltYet({ what }: { what: string }): React.JSX.Element {
  return (
    <div className="flex flex-1 items-center justify-center">
      <p className="text-sm text-muted">{what} — ยังไม่ได้สร้างในขั้นนี้</p>
    </div>
  )
}

export function RouteView({
  session,
  onLogout
}: {
  session: Session
  onLogout: () => void
}): React.JSX.Element {
  const { route } = useRouter()

  switch (route.name) {
    case 'projects':
      return <ProjectsPage />
    case 'progress':
      return <JobProgressPage uid={route.uid} />
    case 'library':
      return <EffectsStudioPage session={session} initialCategory={route.category} />
    case 'settings':
      return <SettingsPage session={session} onLogout={onLogout} />
    case 'wizard':
      return <WizardPage initialFiles={route.initialFiles} />
    case 'detail':
      return <ProjectDetailPage uid={route.uid} />
    case 'timeline':
      return <TimelineRoute uid={route.uid} />
    case 'effectsClip':
      return (
        <Suspense fallback={<div className="p-6 text-sm text-muted">กำลังโหลด…</div>}>
          <EffectsClipRoute uid={route.uid} />
        </Suspense>
      )
    case 'voiceover':
      // The recorder is hidden on this build (see lib/platformFeatures) — a
      // stale link or restored route lands on the project instead of a screen
      // full of controls that were meant to be gone.
      if (!canRecordVoiceover) return <ProjectDetailPage uid={route.uid} />
      return <VoiceoverPage uid={route.uid} />
    default:
      return <NotBuiltYet what="หน้านี้" />
  }
}
