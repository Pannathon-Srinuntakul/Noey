/* eslint-disable react-refresh/only-export-components -- provider + its hook
 * are colocated by design; splitting `useJobs` into its own module would force
 * a circular import back to the context defined here. */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { LocalProject } from '@renderer/platform/types'
import { useProjectPipeline, type ProjectPipeline } from './useProjectPipeline'
import { isBusy, isTerminal, STEP_LABELS, TERMINAL_LABELS, type ProjectStep } from './projectFlow'
import type { ApiSession } from './videosLocalApi'
import { useToast } from './toast'

interface JobsApi {
  /** The authenticated API session every project screen needs — exposed here
   * so consumers don't each have to thread it down from App. */
  session: ApiSession
  projects: LocalProject[]
  loading: boolean
  /** Live pipeline for a project, or undefined before its host has published
   * its first snapshot (one render tick after the project appears). */
  jobFor: (uid: string) => ProjectPipeline | undefined
  /** Projects currently mid-render, newest first — drives the running-job bar. */
  runningJobs: ProjectPipeline[]
  reload: () => void
  addProject: (project: LocalProject) => void
  removeProject: (uid: string) => void
}

const JobsContext = createContext<JobsApi | null>(null)

/**
 * Runs one project's pipeline and publishes it upward. Renders nothing.
 *
 * These hosts live at app level and stay mounted for the whole session, so a
 * render started on one screen keeps running while the user navigates
 * anywhere else. Previously the pipeline hook lived inside `ProjectCard`,
 * which forced the entire projects grid to be kept mounted-but-hidden behind
 * every other view (see the old `view !== 'projects' && 'hidden'` in App.tsx)
 * — that hack does not survive a real router, which is why this moves out
 * before the detail-page split (PLAN.md chunk 4).
 */
function PipelineHost({
  project,
  session,
  publish,
  onFinished
}: {
  project: LocalProject
  session: ApiSession
  publish: (uid: string, pipeline: ProjectPipeline) => void
  onFinished: (pipeline: ProjectPipeline, previousStep: ProjectStep) => void
}): null {
  const pipeline = useProjectPipeline(project, session)
  const pipelineRef = useRef(pipeline)

  const { uid } = project
  const {
    step,
    progressMsg,
    waitingSlot,
    thinking,
    error,
    mediaKey,
    stopping,
    editScript,
    showEditor
  } = pipeline
  const updatedAt = pipeline.project.updatedAt

  // Effects run in declaration order, so this refreshes the ref before the
  // two effects below read it. (Assigning during render instead would be a
  // react-hooks/refs violation.)
  useEffect(() => {
    pipelineRef.current = pipeline
  })

  // Republish whenever anything observable changes. Deps are the primitives
  // only — the pipeline object itself is a fresh reference every render, so
  // depending on it would loop forever. The action closures ride along from
  // the same render that changed a primitive, so they never go stale in a way
  // that matters (they close over the same values the snapshot reports).
  //
  // This list must cover EVERY field of ProjectPipeline that consumers read.
  // Omitting one does not fail loudly — the value simply freezes at whatever
  // it was on the last publish. (`showEditor` was missed once, which left the
  // timeline route stuck on its loading state forever.)
  useEffect(() => {
    publish(uid, pipelineRef.current)
  }, [
    uid,
    step,
    progressMsg,
    waitingSlot,
    thinking,
    error,
    mediaKey,
    stopping,
    editScript,
    showEditor,
    updatedAt,
    publish
  ])

  // Mount/unmount trail. A host must only unmount when its project leaves the
  // list — never on navigation. If these ever bracket a route change, job
  // ownership has regressed back into the routed tree and in-flight renders
  // are being killed by navigating away.
  useEffect(() => {
    void window.noey.log.write('jobs', `host mounted uid=${uid}`)
    return () => {
      void window.noey.log.write('jobs', `host unmounted uid=${uid}`)
    }
  }, [uid])

  // Completion notification. Fires on the busy → terminal transition only,
  // so resuming an already-finished project on app start stays silent.
  const previousStepRef = useRef<ProjectStep>(step)
  useEffect(() => {
    const previous = previousStepRef.current
    previousStepRef.current = step
    if (previous === step) return
    if (isBusy(previous) && isTerminal(step)) onFinished(pipelineRef.current, previous)
  }, [step, onFinished])

  return null
}

export function JobsProvider({
  session,
  children
}: {
  session: ApiSession
  children: React.ReactNode
}): React.JSX.Element {
  const [projects, setProjects] = useState<LocalProject[]>([])
  const [loading, setLoading] = useState(true)
  // The first restore from the server is still running. While it is and the
  // list is empty, the page must not say "no projects yet" — on a fresh
  // browser that welcome screen was the answer for the whole restore.
  const [restoring, setRestoring] = useState(false)
  /** Pipelines live in state (not a ref) so consumers re-render when a host
   * republishes. Each publish replaces one entry wholesale. */
  const [pipelines, setPipelines] = useState<ReadonlyMap<string, ProjectPipeline>>(new Map())
  const { showToast } = useToast()

  // Monotonic id so a SLOW earlier listing cannot land after a newer one and
  // put stale rows on screen; the catch keeps a failed listing from pinning
  // the page on its skeletons forever.
  const reloadSeq = useRef(0)
  const reload = useCallback(() => {
    const seq = ++reloadSeq.current
    window.noey.projects
      .list()
      .then((list) => {
        if (seq !== reloadSeq.current) return
        // The service worker gets the uid→remoteUid map BEFORE the list renders:
        // the first <video> mounts the moment setProjects lands, and a media
        // request for a restored project that raced this message 404'd because
        // the worker did not yet know which server project the uid belongs to.
        navigator.serviceWorker?.controller?.postMessage({
          type: 'sw:projects',
          projects: list.map((p) => ({ uid: p.uid, remoteUid: p.remote?.uid ?? null }))
        })
        setProjects(list)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  useEffect(reload, [reload])

  // Projects made in another browser (or lost to Safari's seven-day sweep) are
  // pulled back from the server before the first list render. Only the small
  // `project.json` is fetched; the media follows on demand through the service
  // worker, so this costs a few kilobytes rather than a download per project.
  // The session object is replaced on every token refresh but is mutated IN
  // PLACE first (authedFetch), so a captured reference never holds a dead
  // token. Kept in a ref so the restore below runs once per mount instead of
  // once per session identity — each re-run raced the previous one.
  const sessionRef = useRef(session)
  useEffect(() => {
    sessionRef.current = session
  }, [session])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { restoreMissingProjects, backfillUnsyncedProjects } = await import('./projectSync')
      setRestoring(true)
      // Show each project as it lands instead of all of them at the end —
      // throttled so a burst of four does not re-list four times.
      let listTimer = 0
      const listSoon = (): void => {
        if (listTimer) return
        listTimer = window.setTimeout(() => {
          listTimer = 0
          reload()
        }, 400)
      }
      try {
        await restoreMissingProjects(sessionRef.current, listSoon)
      } finally {
        setRestoring(false)
        // ALWAYS re-read the store, even when this run was superseded or threw
        // half-way. The restore writes each project.json BEFORE it counts it,
        // and its count covers only what THIS run wrote — a run cancelled
        // after its first write (StrictMode remount, a token refresh swapping
        // the session) left the project on disk with nothing on screen, and
        // the replacement run, seeing it already there, counted 0 and
        // reloaded nothing either. That is the "ต้อง refresh 1 ที" report
        // (owner 2026-09-09).
        reload()
      }
      if (cancelled) return

      // Then the other direction. Every push point is a pipeline TRANSITION,
      // which never fires again for a project already resting at waiting_vo or
      // done — so a project finished before its transition learned to sync
      // stays on one machine for good. This is the one-time catch-up, and it
      // is a no-op for a project the server already has.
      const pushed = await backfillUnsyncedProjects(sessionRef.current)
      if (pushed > 0) {
        void window.noey.log.write('projectSync', `backfilled ${pushed} project(s)`)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [reload])

  // A project created on ANOTHER machine while this tab sits open: re-check
  // when the tab comes back to the foreground, at most once a minute. This is
  // what makes the list live across machines instead of only at page load.
  useEffect(() => {
    // Starts "just synced": the mount restore above is already running, and a
    // first focus event at 0 started a second full restore beside it.
    let last = Date.now()
    const resync = (): void => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() - last < 60_000) return
      last = Date.now()
      void (async () => {
        const { restoreMissingProjects } = await import('./projectSync')
        try {
          await restoreMissingProjects(sessionRef.current)
        } finally {
          reload()
        }
      })()
    }
    document.addEventListener('visibilitychange', resync)
    window.addEventListener('focus', resync)
    return () => {
      document.removeEventListener('visibilitychange', resync)
      window.removeEventListener('focus', resync)
    }
  }, [reload])

  // The service worker serves media by project uid, and only the page knows
  // which server-side project a local uid belongs to. Telling it here means
  // every project the list knows about can be streamed from the server when
  // its bytes are not in this browser.
  useEffect(() => {
    const sw = navigator.serviceWorker?.controller
    if (!sw) return
    // The WHOLE map in one message, replacing what the worker holds: per-entry
    // merges kept an entry for every project ever deleted, forever.
    sw.postMessage({
      type: 'sw:projects',
      projects: projects.map((p) => ({ uid: p.uid, remoteUid: p.remote?.uid ?? null }))
    })
  }, [projects])

  // A job started from the phone is written straight to disk by the main
  // process; this is how the host learns it exists and starts running it.
  useEffect(() => window.noey.projects.onChanged(reload), [reload])

  const publish = useCallback((uid: string, pipeline: ProjectPipeline) => {
    setPipelines((prev) => new Map(prev).set(uid, pipeline))
  }, [])

  const onFinished = useCallback(
    (pipeline: ProjectPipeline, previousStep: ProjectStep) => {
      const name = pipeline.project.name
      const failed = pipeline.step === 'error'
      // Named after the state REACHED, not the one that was running: a dub run
      // now finishes out of 'silent_rendering', and keying off that produced
      // "กำลังตัดวิดีโอ (เงียบ) เสร็จแล้ว".
      const reached = TERMINAL_LABELS[pipeline.step] ?? `${STEP_LABELS[previousStep]} เสร็จแล้ว`
      const body = failed ? (pipeline.error ?? 'เกิดข้อผิดพลาดระหว่างทำงาน') : reached

      // Title + detail, not one flattened string: the kit's completion toast
      // names the step that finished under the project's name.
      showToast(
        failed
          ? { text: 'ทำงานไม่สำเร็จ', detail: `${name} · ${body}` }
          : { text: reached, detail: name, variant: 'ok' }
      )
      void window.noey.notify.show({
        title: failed ? 'ทำงานไม่สำเร็จ' : 'งานเสร็จแล้ว',
        body: `${name} · ${body}`,
        projectUid: pipeline.project.uid
      })
    },
    [showToast]
  )

  const jobFor = useCallback((uid: string) => pipelines.get(uid), [pipelines])

  const addProject = useCallback((project: LocalProject) => {
    setProjects((prev) => [project, ...prev])
  }, [])

  const removeProject = useCallback((uid: string) => {
    setPipelines((prev) => {
      if (!prev.has(uid)) return prev
      const next = new Map(prev)
      next.delete(uid)
      return next
    })
    setProjects((prev) => prev.filter((p) => p.uid !== uid))
  }, [])

  // Ordered by the project list (newest first), not Map insertion order.
  const runningJobs = useMemo(
    () =>
      projects
        .map((p) => pipelines.get(p.uid))
        .filter((job): job is ProjectPipeline => job !== undefined && isBusy(job.step)),
    [projects, pipelines]
  )

  const api = useMemo<JobsApi>(
    () => ({
      session,
      projects,
      loading: loading || (restoring && projects.length === 0),
      jobFor,
      runningJobs,
      reload,
      addProject,
      removeProject
    }),
    [session, projects, loading, restoring, jobFor, runningJobs, reload, addProject, removeProject]
  )

  return (
    <JobsContext.Provider value={api}>
      {projects.map((p) => (
        <PipelineHost
          key={p.uid}
          project={p}
          session={session}
          publish={publish}
          onFinished={onFinished}
        />
      ))}
      {children}
    </JobsContext.Provider>
  )
}

export function useJobs(): JobsApi {
  const ctx = useContext(JobsContext)
  if (!ctx) throw new Error('useJobs must be used inside <JobsProvider>')
  return ctx
}
