/* eslint-disable react-refresh/only-export-components -- provider + its hook
 * are colocated by design, same as lib/jobs.tsx. */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'

/**
 * App-level home for the editors' long-running AI work (zoom placement, zoom
 * bake, AI re-edit of the cut).
 *
 * These used to live in the editor components, so leaving the screen killed the
 * visible job: the request kept running with nobody listening, its result was
 * dropped on the floor, and coming back showed an idle editor with no hint that
 * anything was happening (live report 2026-08-13). Here the work outlives every
 * screen — like `lib/jobs.tsx` does for renders — and its progress and result
 * are readable from anywhere, so returning to the editor picks up where it was.
 */

export type FxJobKind = 'ai' | 'render' | 'reedit'

export interface FxJob {
  uid: string
  kind: FxJobKind
  /** One line for banners outside the editor ("AI กำลังวางการซูม…"). */
  label: string
  progress: string
  thinking: string
  startedAt: number
}

export interface FxJobResult<T = unknown> {
  kind: FxJobKind
  value: T
  finishedAt: number
}

export interface FxRunContext {
  onProgress: (msg: string) => void
  onThinking: (msg: string) => void
  signal: AbortSignal
}

interface FxJobsApi {
  jobFor: (uid: string) => FxJob | undefined
  resultFor: (uid: string) => FxJobResult | undefined
  errorFor: (uid: string) => string | undefined
  clearResult: (uid: string) => void
  clearError: (uid: string) => void
  stop: (uid: string) => void
  /**
   * Run `fn` for project `uid`, keeping its progress and result at app level.
   * One job per project — starting a second is a no-op, since both would write
   * the same effects doc.
   */
  run: <T>(
    uid: string,
    kind: FxJobKind,
    label: string,
    fn: (ctx: FxRunContext) => Promise<T>
  ) => Promise<void>
}

const FxJobsContext = createContext<FxJobsApi | null>(null)

export function FxJobsProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [jobs, setJobs] = useState<ReadonlyMap<string, FxJob>>(new Map())
  const [results, setResults] = useState<ReadonlyMap<string, FxJobResult>>(new Map())
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map())
  const controllers = useRef<Map<string, AbortController>>(new Map())

  const patchJob = useCallback((uid: string, p: Partial<FxJob>) => {
    setJobs((prev) => {
      const cur = prev.get(uid)
      if (!cur) return prev
      const next = new Map(prev)
      next.set(uid, { ...cur, ...p })
      return next
    })
  }, [])

  const dropJob = useCallback((uid: string) => {
    setJobs((prev) => {
      if (!prev.has(uid)) return prev
      const next = new Map(prev)
      next.delete(uid)
      return next
    })
    controllers.current.delete(uid)
  }, [])

  const run = useCallback(
    async <T,>(
      uid: string,
      kind: FxJobKind,
      label: string,
      fn: (ctx: FxRunContext) => Promise<T>
    ): Promise<void> => {
      // One AI/render job per project — a second would fight the first over the
      // same effects doc and the same output file. Returning silently made the
      // press look like it did nothing at all, so say what is already running.
      const busy = controllers.current.has(uid)
      if (busy) {
        setErrors((prev) =>
          new Map(prev).set(uid, 'มีงานของโปรเจกต์นี้ทำอยู่แล้ว — รอให้เสร็จหรือกดหยุดก่อน')
        )
        return
      }
      const ac = new AbortController()
      controllers.current.set(uid, ac)
      setErrors((prev) => {
        if (!prev.has(uid)) return prev
        const next = new Map(prev)
        next.delete(uid)
        return next
      })
      setJobs((prev) =>
        new Map(prev).set(uid, {
          uid,
          kind,
          label,
          progress: '',
          thinking: '',
          startedAt: Date.now()
        })
      )
      try {
        const value = await fn({
          onProgress: (progress) => patchJob(uid, { progress }),
          onThinking: (thinking) => patchJob(uid, { thinking }),
          signal: ac.signal
        })
        setResults((prev) => new Map(prev).set(uid, { kind, value, finishedAt: Date.now() }))
      } catch (e) {
        // A stop is a choice, not a failure — it leaves nothing to report.
        if (!(e instanceof DOMException && e.name === 'AbortError')) {
          const message = e instanceof Error ? e.message : String(e)
          void window.noey.log.write('fxJobs', `${kind} failed uid=${uid}: ${message}`)
          setErrors((prev) => new Map(prev).set(uid, message))
        }
      } finally {
        dropJob(uid)
      }
    },
    [patchJob, dropJob]
  )

  const api = useMemo<FxJobsApi>(
    () => ({
      jobFor: (uid) => jobs.get(uid),
      resultFor: (uid) => results.get(uid),
      errorFor: (uid) => errors.get(uid),
      clearResult: (uid) =>
        setResults((prev) => {
          if (!prev.has(uid)) return prev
          const next = new Map(prev)
          next.delete(uid)
          return next
        }),
      clearError: (uid) =>
        setErrors((prev) => {
          if (!prev.has(uid)) return prev
          const next = new Map(prev)
          next.delete(uid)
          return next
        }),
      stop: (uid) => controllers.current.get(uid)?.abort(),
      run
    }),
    [jobs, results, errors, run]
  )

  return <FxJobsContext.Provider value={api}>{children}</FxJobsContext.Provider>
}

export function useFxJobs(): FxJobsApi {
  const ctx = useContext(FxJobsContext)
  if (!ctx) throw new Error('useFxJobs must be used inside <FxJobsProvider>')
  return ctx
}
