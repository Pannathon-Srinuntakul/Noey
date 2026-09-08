import { useEffect, useRef } from 'react'
import { useJobs } from '../lib/jobs'
import { useRouter } from '../lib/router'
import { VideoTimelineEditor } from '../components/TimelineEditor'

/**
 * Route that owns the timeline editor mount.
 *
 * It used to be returned from inside `ProjectCard`, which meant every card in
 * the grid could mount a fullscreen editor and its media elements
 * (HANDOFF §7). Only the router mounts it now, so exactly one can exist.
 *
 * `openEditor()` is not just a visibility flag — it calls `configureEditorApi`
 * with the edit target, script/timeline, caption lines and music callbacks.
 * Calling it here rather than at the button press means landing on this route
 * by any path (back/forward, a future deep link) is still configured.
 */
export default function TimelineRoute({ uid }: { uid: string }): React.JSX.Element {
  const { jobFor } = useJobs()
  const { navigate } = useRouter()
  const job = jobFor(uid)
  const ready = job?.showEditor ?? false
  /** Which project `configureEditorApi` was last pointed at. `showEditor` is
   * per-project state that STAYS true after the editor closes, so gating on it
   * alone meant reopening project B's editor while A's flag was still set
   * skipped the reconfigure — the editor then edited B's cuts and saved them
   * into A. The uid, not a boolean, is what says "already configured". */
  const configuredFor = useRef<string | null>(null)

  useEffect(() => {
    if (!job) return
    if (configuredFor.current === uid && ready) return
    configuredFor.current = uid
    job.openEditor()
  }, [job, ready, uid])

  if (!job) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted">ไม่พบโปรเจกต์นี้</p>
      </div>
    )
  }
  if (!ready) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted">กำลังเปิดตัวแก้ไข…</p>
      </div>
    )
  }

  const close = (): void => {
    job.setShowEditor(false)
    navigate({ name: 'detail', uid })
  }

  return (
    <VideoTimelineEditor
      uid={uid}
      mode={job.mode}
      projectName={job.project.name}
      onClose={close}
      onSaved={close}
    />
  )
}
