import { useJobs } from '../lib/jobs'
import { useRouter } from '../lib/router'
import { useEffectsBase } from '../lib/usePreviewFile'
import type { ProjectStep } from '../lib/projectFlow'
import EffectsCanvasEditor from '../components/EffectsCanvasEditor'

/**
 * Route that owns the effects editor mount — see TimelineRoute for why these
 * moved off the project card.
 *
 * The base file is derived rather than passed in, so entering from any path
 * composites onto the same clean cut (never the already-baked final_fx.mp4).
 */
export default function EffectsClipRoute({ uid }: { uid: string }): React.JSX.Element {
  const { jobFor, session } = useJobs()
  const { navigate } = useRouter()
  const job = jobFor(uid)
  const baseFile = useEffectsBase(
    uid,
    (job?.step as ProjectStep) ?? 'imported',
    job?.mode ?? 'dub_first',
    job?.mediaKey ?? 0
  )

  if (!job) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted">ไม่พบโปรเจกต์นี้</p>
      </div>
    )
  }
  if (!baseFile) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted">กำลังเตรียมคลิป…</p>
      </div>
    )
  }

  return (
    <EffectsCanvasEditor
      project={job.project}
      session={session}
      baseFile={baseFile}
      onClose={() => navigate({ name: 'detail', uid })}
    />
  )
}
