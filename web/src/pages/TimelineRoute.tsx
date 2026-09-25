import { useEffect, useRef, useState } from 'react'
import { useJobs } from '../lib/jobs'
import { useRouter } from '../lib/router'
import { useStableCallback } from '../lib/useStableCallback'
import { countShotsWithAlternates, segmentIndexForCutId } from '../lib/shotSwap'
import { VideoTimelineEditor } from '../components/TimelineEditor'
import { ShotSwapReview } from '../components/projects/ShotSwapReview'

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
 *
 * It also owns ปรับช็อต: the shot-swap screen lives OUTSIDE the editor (it is
 * the same screen the project page's button opens, over the same project
 * pipeline), so the editor can only offer the key — this route is what can act
 * on it.
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
  /** The cut Enter was pressed on, or null while the swap screen is closed. */
  const [swapCutId, setSwapCutId] = useState<string | null>(null)

  useEffect(() => {
    if (!job) return
    if (configuredFor.current === uid && ready) return
    configuredFor.current = uid
    job.openEditor()
  }, [job, ready, uid])

  // One identity for the editor's life. `job` is a new object on every jobs
  // publish — a draft save is one — so a plain closure changed every time and
  // re-rendered the whole (memoized) editor for nothing. Declared above the
  // early returns: it is a hook.
  const close = useStableCallback((): void => {
    job?.setShowEditor(false)
    navigate({ name: 'detail', uid })
  })

  // Same stability, same reason. Offered only when the cut actually has a
  // backup shot somewhere — exactly the condition that enables the project
  // page's ปรับช็อต button, so the key is never a press that leads nowhere.
  const openShotSwap = useStableCallback((cutId: string): void => {
    setSwapCutId(cutId)
  })

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

  const canShotSwap =
    (job.mode === 'dub_first' || job.mode === 'highlight') &&
    countShotsWithAlternates(job.editScript) > 0

  return (
    <>
      <VideoTimelineEditor
        uid={uid}
        mode={job.mode}
        projectName={job.project.name}
        onClose={close}
        onSaved={close}
        onOpenShotSwap={canShotSwap ? openShotSwap : undefined}
      />
      {swapCutId ? (
        <ShotSwapReview
          job={job}
          // A cut id the script does not explain (a scene added in the editor)
          // opens the review at the start rather than at a guessed shot.
          startAt={segmentIndexForCutId(swapCutId) ?? 0}
          onClose={() => setSwapCutId(null)}
        />
      ) : null}
    </>
  )
}
