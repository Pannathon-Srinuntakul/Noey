import { useCallback, useEffect, useRef, useState } from 'react'
import type { LocalProject, SidecarEvent } from '../../../preload'
import { ApiError } from './api'
import {
  analyzeVideo,
  cancelRemoteProject,
  createLocalProject,
  deleteMusic,
  getEditScript,
  getLocalTimeline,
  patchLocalStatus,
  planDub,
  pollJob,
  putLocalEditScript,
  putLocalTimeline,
  reeditDubScenes,
  uploadAudio,
  uploadMusic,
  type ApiSession,
  type CaptionStyleIn,
  type DubEditScript,
  type DubTimeline,
  type ProxyManifestEntry
} from './videosLocalApi'
import {
  configureEditorApi,
  editCutsFromDubSegments,
  editScriptFromCuts,
  type CaptionLine,
  type EditCut,
  type SaveCutPayload
} from './editorApi'
import { captionWordsFromLines, dubCaptionLines, groupWordsIntoLines } from './captionLines'
import { dubScenesFor, timelineScenesFor } from './dubScenes'
import type { CaptionStyle } from './captionStyle'
import { pickFile } from './pickFile'
import type { ProjectMode, ProjectStep } from './projectFlow'
import { isBusy, isTerminal, resumeStep } from './projectFlow'

/** Rejects with a labeled error if `promise` doesn't settle within `ms` —
 * used around local Electron IPC calls that should always be fast, so a
 * wedged main process shows up as a clear timeout instead of a silent
 * permanent hang with nothing to point at in the logs. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    )
  })
}

/**
 * The brief actually sent to the AI: the one saved at creation, plus every
 * recut comment as one appended block.
 *
 * Composed per run rather than written back to `project.brief`, so round five
 * carries each comment once instead of five stacked copies of the earlier
 * ones. Oldest first — the model reads them as a running list of corrections,
 * and the newest is the one it has not tried yet.
 */
export function briefWithRecutNotes(project: LocalProject): string {
  const base = (project.brief ?? '').trim()
  const notes = project.recutNotes ?? []
  if (notes.length === 0) return base
  const lines = notes.map((n) => `- ${n.text}`).join('\n')
  const block = `สิ่งที่ผู้ใช้ขอให้แก้เพิ่ม (เรียงจากรอบเก่าไปใหม่):\n${lines}`
  return base ? `${base}\n\n${block}` : block
}

/**
 * One project's full render pipeline (analyze → silent render → voiceover →
 * final render, or talking_head's extract-audio → transcribe → render), as a
 * hook so each project card in the grid can run its own instance
 * independently — matching the web app's per-card live job model instead of
 * a single full-page wizard for one project at a time.
 *
 * Config (brief/userScript/scriptStyles/targetDurationSec) is read straight
 * off `project` — the sidebar computes and persists the final values at
 * creation time, so runAnalyze/runTalkingHead need no separate config args
 * and "retry" naturally reuses whatever was saved the first time.
 */
export interface ProjectPipeline {
  project: LocalProject
  step: ProjectStep
  mode: ProjectMode
  /** Epoch ms when the running stage began, or null if nothing is running in
   * this session — the only honest basis for a remaining-time estimate. */
  runStartedAt: number | null
  progressMsg: string
  thinking: string
  editScript: DubEditScript | null
  error: string | null
  mediaKey: number
  showEditor: boolean
  setShowEditor: (show: boolean) => void
  runAnalyze: () => Promise<void>
  runTalkingHead: () => Promise<void>
  runFinal: () => Promise<void>
  /** Write a field on the project AND refresh this pipeline's copy. Screens
   * must use this rather than `window.noey.projects.update` directly, or the
   * write lands on disk while every consumer keeps rendering the old value. */
  patch: (patch: Partial<LocalProject>) => Promise<void>
  /** Plan + render against a voiceover already on disk (the recorder's
   * assembled WAV). `runFinal` is this plus a file picker. */
  runFinalWithAudio: (voiceoverPath: string) => Promise<void>
  pickMusic: () => Promise<LocalProject['music'] | undefined>
  updateMusic: (patch: Partial<NonNullable<LocalProject['music']>>) => Promise<void>
  removeMusic: () => Promise<void>
  retry: () => Promise<void>
  /** Re-run the cut with the same settings plus a comment on what to change. */
  recut: (text: string) => Promise<void>
  /** Put the render kept before the last recut back, discarding the new one. */
  revertRecut: () => Promise<void>
  stop: () => Promise<void>
  stopping: boolean
  openEditor: () => void
}

/**
 * The cut's scenes in OUTPUT time, tagged with the voiceover line each was cut
 * for. Durations accumulate because the segments play back to back, which is
 * what makes an output-time caption possible without re-measuring the render.
 */

export function useProjectPipeline(initial: LocalProject, session: ApiSession): ProjectPipeline {
  const [project, setProject] = useState<LocalProject>(initial)
  const [progressMsg, setProgressMsg] = useState('')
  // When the current run began, so the progress screens can extrapolate a real
  // remaining time. In memory on purpose: the estimate is only meaningful for
  // the run you are watching, and a persisted timestamp from a previous session
  // would produce a confident, wrong figure.
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null)
  const runStartedAtRef = useRef<number | null>(null)
  const markRunStarted = (): void => {
    runStartedAtRef.current = Date.now()
    setRunStartedAt(runStartedAtRef.current)
  }
  /** How long the run that is finishing took, in whole seconds — persisted so
   * the detail page can say "ใช้เวลาทำ …" long after the run is over. Null when
   * the step advanced without a run we timed (a resumed or imported project),
   * which keeps the figure honest rather than guessing from timestamps. */
  const runSeconds = (): number | undefined => {
    const started = runStartedAtRef.current
    if (!started) return undefined
    return Math.max(1, Math.round((Date.now() - started) / 1000))
  }
  const [thinking, setThinking] = useState('')
  const [editScript, setEditScript] = useState<DubEditScript | null>(
    (initial.editScript as unknown as DubEditScript | undefined) ?? null
  )
  const [error, setError] = useState<string | null>(null)
  const [mediaKey, setMediaKey] = useState(0)
  const [showEditor, setShowEditor] = useState(false)
  const [stopping, setStopping] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const stoppedRef = useRef(false)
  /**
   * Monotonic id of the run currently allowed to touch this project.
   *
   * `stoppedRef` alone could not do this job: stop() clears it again inside
   * resetAfterStop, so an in-flight stage sitting in an `await` woke up, saw
   * `stoppedRef === false`, and carried on to the next stage — the job kept
   * running after "หยุดงาน" and the card started reporting progress again
   * (live report 2026-08-13). A token captured when the run STARTS cannot be
   * un-stopped by anything that happens afterwards.
   */
  const runIdRef = useRef(0)
  /** Start a run; the returned token stays valid until stop() or a newer run. */
  const beginRun = (): number => {
    stoppedRef.current = false
    runIdRef.current += 1
    return runIdRef.current
  }
  /** True once this run has been stopped or superseded — bail out. */
  const isStale = (token: number): boolean => token !== runIdRef.current
  const stoppingRef = useRef(false)
  const disposedRef = useRef(false)
  const pipelineRef = useRef<Promise<void> | null>(null)
  const projectRef = useRef(initial)

  const step = project.step as ProjectStep
  const mode: ProjectMode = project.mode ?? 'dub_first'

  // Latest-value mirror for the long-running pipeline promises. Written in an
  // effect (not during render) per react-hooks/refs — the pipeline only reads
  // it after commit, so the one-frame lag is harmless.
  //
  // `stoppingRef` is deliberately NOT synced here: stop() sets it immediately
  // and clears it in resetAfterStop, and an effect echoing the (older) render
  // state would flip it back mid-stop, letting a second press through.
  useEffect(() => {
    projectRef.current = project
  })

  // Merge disk state when the registry is newer — never roll back a step the
  // in-memory pipeline has already advanced (parent list is not patched on
  // every patchProject). Adjusted DURING render (the React-endorsed
  // "state from props" shape) rather than in an effect, so there is no
  // frame where the stale project renders first.
  const [seenInitial, setSeenInitial] = useState({
    uid: initial.uid,
    updatedAt: initial.updatedAt
  })
  if (initial.uid !== seenInitial.uid || initial.updatedAt !== seenInitial.updatedAt) {
    setSeenInitial({ uid: initial.uid, updatedAt: initial.updatedAt })
    setProject((prev) => {
      if (initial.uid !== prev.uid) return initial
      if (initial.updatedAt >= prev.updatedAt) return { ...prev, ...initial }
      return prev
    })
  }

  useEffect(() => {
    // Re-arm on EVERY mount. React StrictMode (dev) runs mount → unmount →
    // mount, so a ref only ever set in the cleanup stayed `true` for the rest
    // of the component's life: this host then silently skipped every state
    // update and swallowed every pipeline error, leaving cards frozen on a
    // stage that had already failed and making "หยุดงาน" look like it did
    // nothing (live 2026-08-13).
    disposedRef.current = false
    return () => {
      disposedRef.current = true
      abortRef.current?.abort()
    }
  }, [])

  /**
   * The project as it is NOW, for code inside a pipeline stage.
   *
   * A run is one long async chain (`bootstrapPipeline` → import → analyze →
   * render), so every stage in it closes over the `project` value from the
   * render that STARTED the chain. Anything the chain itself wrote — the music
   * the import stage attaches from `pendingMusic`, the remote uid, the
   * voiceover path — is invisible through that variable. Stages must read
   * this instead; `patchProject` keeps it current synchronously.
   */
  const live = (): LocalProject => projectRef.current

  // dub_first final render only: extra sidecar job fields for the attached
  // background music track (see TimelineEditor's audio track for editing).
  // Omitted entirely when no music is attached — old VO-only mux, unchanged.
  // The sidecar is a plain local process, so it gets the resolved absolute
  // path (project.music.path itself is project-relative, for media:// use).
  //
  // Reads `live()` rather than taking a project: it used to be handed the
  // stale closure `project`, so a project whose music was attached during the
  // import stage rendered with NO music mix at all — final_silent_music.mp4
  // was never produced and the detail page fell back to the silent cut, while
  // the editor (which plays the raw track through its own <audio>) had music.
  // That is the "เพลงไม่มาในหน้าโปรเจกต์ แต่ในหน้า edit มี" report (2026-08-13).
  const musicJobFields = async (): Promise<{
    musicPath?: string
    musicVolume?: number
    musicOffsetSec?: number
    musicTrimInSec?: number
    musicTrimOutSec?: number
  }> => {
    const p = live()
    if (!p.music) return {}
    const musicPath = await window.noey.projects.resolvePath(p.uid, p.music.path)
    return {
      musicPath,
      musicVolume: p.music.muted ? 0 : p.music.volume,
      musicOffsetSec: p.music.offsetSec,
      musicTrimInSec: p.music.trimInSec,
      // The right trim handle. It was edited, stored and honoured in the
      // preview, but never shipped to a render — every finished file played
      // the song past the point the editor showed it stopping.
      ...(p.music.trimOutSec != null ? { musicTrimOutSec: p.music.trimOutSec } : {})
    }
  }

  const patchProject = async (patch: Partial<LocalProject>): Promise<LocalProject> => {
    const updated = await window.noey.projects.update(project.uid, patch)
    if (!disposedRef.current) setProject(updated)
    // The mirror ref is synced by an effect too, but effects only run after
    // React commits — a long-running stage that patches and then reads
    // `projectRef.current` on the very next line would otherwise see the
    // PRE-patch project. That stalled the pipeline right after the import
    // stage (step still read 'importing', so it returned instead of starting
    // the AI stage — live 2026-08-13).
    projectRef.current = updated
    return updated
  }

  // Sets the in-memory edit script AND persists it to project.json — without
  // this, the script only lived in React state and a failed resume-fetch after
  // an app restart silently left it null forever, permanently disabling the
  // timeline editor button with no visible error (see ProjectCard.tsx disabled
  // check on `!editScript`).
  const applyEditScript = (script: DubEditScript): void => {
    setEditScript(script)
    void patchProject({ editScript: script as unknown as Record<string, unknown> })
  }

  const resetAfterStop = async (): Promise<void> => {
    const remoteUid = project.remote?.uid
    if (!disposedRef.current) {
      setProgressMsg('')
      setThinking('')
      setStopping(false)
    }
    stoppingRef.current = false
    // stoppedRef is NOT cleared here: a stage that throws AFTER this reset
    // (an aborted poll rejecting late) must still be classified as "stopped",
    // not as a failure that flips the card to error. beginRun() clears it when
    // the next run actually starts.
    abortRef.current = null
    await patchProject({
      step: 'imported',
      error: undefined,
      remote: remoteUid ? { uid: remoteUid } : undefined
    })
  }

  const isStopError = (exc: unknown): boolean =>
    stoppedRef.current ||
    (exc instanceof ApiError && (exc.detail === 'ยกเลิกแล้ว' || /cancel/i.test(exc.detail)))

  const handlePipelineError = async (exc: unknown): Promise<void> => {
    // A failure must reach DISK even when this host is gone. Bailing out
    // wholesale on `disposedRef` meant that if the component unmounted while a
    // stage was in flight (the projects list re-renders its hosts constantly),
    // the error vanished: project.json kept the in-flight step, and the card —
    // rebuilt from that — sat on "กำลังอัพโหลดไฟล์เสียง…" forever with no way
    // to find out why (live 2026-08-13; the real cause was a 400 from the
    // server). React state updates are the only part that is unsafe after
    // unmount, and `fail`/`resetAfterStop` do their persistence first.
    if (disposedRef.current) {
      void window.noey.log.write(
        'useProjectPipeline',
        `pipeline error after dispose uid=${project.uid}: ${String((exc as Error)?.message ?? exc)}`
      )
    }
    if (isStopError(exc)) {
      await resetAfterStop()
      return
    }
    if (!disposedRef.current) {
      setStopping(false)
      stoppedRef.current = false
    }
    await fail(exc)
  }

  const stop = async (): Promise<void> => {
    // Guard off REFS, not render state. The button lives on a published
    // snapshot that can be one render behind, so `stopping`/`step` here could
    // still describe the previous frame — a press then did nothing and the
    // user had to click again (live report 2026-08-13: "ต้องกด 2 รอบ").
    if (stoppingRef.current) return
    const liveStep = projectRef.current.step as ProjectStep
    if (!isBusy(liveStep) && !isBusy(step)) return
    void window.noey.log.write('useProjectPipeline', `stop: start uid=${project.uid} step=${step}`)
    setStopping(true)
    stoppingRef.current = true
    stoppedRef.current = true
    // Invalidate whatever is in flight: every stage checks its own token, so
    // this is what actually makes the work stop rather than pause.
    runIdRef.current += 1
    setProgressMsg('กำลังหยุด…')
    setThinking('')
    abortRef.current?.abort()
    try {
      // These are local Electron main-process IPC calls (no server round
      // trip) — they should return in milliseconds. If either ever hangs,
      // the main process itself is wedged (not a network/server issue) —
      // the timeout here logs exactly which call never returned instead of
      // stop() (and the whole UI) freezing forever with no diagnostic trail.
      void window.noey.log.write('useProjectPipeline', 'stop: calling projects.dir')
      const projectDir = await withTimeout(
        window.noey.projects.dir(project.uid),
        10_000,
        'projects.dir'
      )
      void window.noey.log.write('useProjectPipeline', `stop: got projectDir=${projectDir}`)
      await withTimeout(window.noey.sidecar.cancel(projectDir), 10_000, 'sidecar.cancel')
      void window.noey.log.write('useProjectPipeline', 'stop: sidecar.cancel done')
    } catch (err) {
      void window.noey.log.write(
        'useProjectPipeline',
        `stop: cancel step failed/timed out: ${String(err)}`
      )
    }
    const remoteUid = project.remote?.uid
    if (remoteUid) {
      cancelRemoteProject(session, remoteUid).catch(() => undefined)
    }
    // Always reset here directly — previously this was skipped while a
    // server job was being polled (wasPolling), relying entirely on the
    // aborted pollJob() rejecting and its catch (handlePipelineError →
    // resetAfterStop) to reset the UI instead. That's an indirect chain
    // with more to go wrong (observed stuck on "กำลังหยุด…" indefinitely,
    // 2026-07-19) — now that concurrent patchProject calls are safe
    // (main/projects.ts's per-uid write lock), stop() can just reset
    // directly and not depend on a parallel chain noticing the abort.
    void window.noey.log.write('useProjectPipeline', 'stop: resetting UI state')
    await resetAfterStop()
  }

  const fail = async (exc: unknown): Promise<void> => {
    const message = exc instanceof ApiError ? exc.detail : String((exc as Error).message ?? exc)
    void window.noey.log.write('useProjectPipeline', `fail uid=${project.uid}: ${message}`)
    if (!disposedRef.current) setError(message)
    // Persisted unconditionally — see handlePipelineError.
    await patchProject({ step: 'error', error: message })
    const remoteUid = project.remote?.uid
    if (remoteUid) {
      patchLocalStatus(session, remoteUid, 'error', message).catch(() => undefined)
    }
  }

  // ── background music (dub_first only) ─────────────────────────────────────
  // Picked ahead of "AI ตัด" — the local path is stashed here; runAnalyze
  // uploads it (for librosa beat detection) once the remote project exists,
  // right before the cut-decision call, so the AI already has the beat grid.
  // Re-mix music onto an EXISTING final_silent.mp4 — covers music picked or
  // edited AFTER the silent cut already exists (the inline mix inside
  // runRenderSilent only covers music attached before that render). Failure
  // is non-fatal and silent (e.g. the silent cut doesn't exist yet — music
  // picked before the first analyze, which runRenderSilent already handles).
  const remixMusicOntoSilent = async (music: LocalProject['music'] | undefined): Promise<void> => {
    void window.noey.log.write(
      'useProjectPipeline',
      `mixMusic start: ${music ? `path=${music.path} vol=${music.volume} offset=${music.offsetSec} trimIn=${music.trimInSec}` : 'clearing music'}`
    )
    const projectDir = await window.noey.projects.dir(project.uid)
    const unsub = window.noey.sidecar.mixMusic.onProgress((evt: SidecarEvent) => {
      setProgressMsg(evt.stage === 'music' ? 'กำลังใส่เพลงประกอบ…' : 'กำลังอัพเดตไฟล์ทั้งชุด…')
      void window.noey.log.write('useProjectPipeline', `mixMusic progress: ${JSON.stringify(evt)}`)
    }, projectDir)
    try {
      const musicPath = music
        ? await window.noey.projects.resolvePath(project.uid, music.path)
        : null
      const done = await window.noey.sidecar.mixMusic.run({
        projectDir,
        musicPath,
        musicVolume: music ? (music.muted ? 0 : music.volume) : 0.25,
        musicOffsetSec: music?.offsetSec ?? 0,
        musicTrimInSec: music?.trimInSec ?? 0,
        // Same omission as musicJobFields had — the right trim handle never
        // reached the mix, so the re-mixed file ignored it too.
        ...(music?.trimOutSec != null ? { musicTrimOutSec: music.trimOutSec } : {})
      })
      void window.noey.log.write('useProjectPipeline', `mixMusic done: ${JSON.stringify(done)}`)
      setMediaKey((k) => k + 1)
      setProgressMsg('')
    } catch (err) {
      void window.noey.log.write('useProjectPipeline', `mixMusic skipped: ${String(err)}`)
      setProgressMsg('')
    } finally {
      unsub()
    }
  }

  const pickMusic = async (): Promise<LocalProject['music'] | undefined> => {
    const picked = await pickFile('video/*,audio/*')
    if (!picked) return live().music
    // Copied into the project dir (like clips) so the editor's waveform can
    // fetch it via media:// — window.electron file objects aren't otherwise
    // readable from the renderer's fetch/decodeAudioData.
    const relPath = await window.noey.projects.importMusic(project.uid, picked.path)
    const music: NonNullable<LocalProject['music']> = {
      path: relPath,
      volume: 0.25,
      offsetSec: 0,
      trimInSec: 0,
      trimOutSec: null,
      muted: false
    }
    await patchProject({ music })
    await remixMusicOntoSilent(music)
    return music
  }

  /**
   * Patch the attached track. Reads `live()`, never the render closure: the
   * editor holds ONE `configureEditorApi` snapshot for the whole session
   * (openEditor runs once), and every music edit arrives as a PARTIAL patch
   * that `projects.update` merges over the WHOLE `music` object. Merging onto a
   * frozen copy therefore reverted the previous edit — drag the block to 8s,
   * then nudge the volume, and the offset silently went back to 0 and the mix
   * was re-rendered at 0. Picking a track from inside the editor was worse: the
   * frozen copy had no `music` at all, so every later edit was a no-op.
   */
  const updateMusic = async (patch: Partial<NonNullable<LocalProject['music']>>): Promise<void> => {
    const current = live().music
    if (!current) return
    const music = { ...current, ...patch }
    await patchProject({ music })
    await remixMusicOntoSilent(music)
  }

  const removeMusic = async (): Promise<void> => {
    await setMusicTrack(null)
  }

  /**
   * Replace the whole track at once — what the editor's undo/redo needs.
   * `updateMusic` can only patch a track that is already attached, so it cannot
   * put back a track that was detached (or take away one that was attached),
   * which are both single steps in the editor's history.
   */
  const setMusicTrack = async (music: LocalProject['music'] | null): Promise<void> => {
    await patchProject({ music: music ?? undefined })
    await remixMusicOntoSilent(music ?? undefined)
    const remoteUid = live().remote?.uid
    // The server copy only exists to give the cut AI a beat grid; dropping the
    // track locally means it must not keep steering the next cut.
    if (!music && remoteUid) deleteMusic(session, remoteUid).catch(() => undefined)
  }

  // ── stage: analyze (frames → upload → LLM → edit script → silent render) ──
  const runAnalyze = async (): Promise<void> => {
    setError(null)
    setThinking('')
    markRunStarted()
    const runToken = beginRun()
    void window.noey.log.write('useProjectPipeline', `runAnalyze start token=${runToken}`)
    setProgressMsg('กำลังเตรียมวิเคราะห์…')
    try {
      let current = await patchProject({ step: 'analyzing', error: undefined })

      let remoteUid = current.remote?.uid
      if (!remoteUid) {
        const created = await createLocalProject(session, {
          mode,
          brief: current.brief || null,
          user_script: current.userScript || null,
          target_duration_sec: current.targetDurationSec ?? null,
          clips: current.clips.map((c) => ({
            id: c.id,
            durationSec: c.durationSec,
            width: c.width,
            height: c.height,
            fps: c.fps
          }))
        })
        remoteUid = created.uid
        current = await patchProject({ remote: { uid: remoteUid } })
      }

      // `beatSync !== false` rather than `=== true`: projects created before
      // the wizard exposed the switch have no field, and they were beat-cut.
      if (current.music?.path && current.beatSync !== false) {
        setProgressMsg('กำลังวิเคราะห์จังหวะเพลง…')
        try {
          const absMusicPath = await window.noey.projects.resolvePath(
            project.uid,
            current.music.path
          )
          const beats = await uploadMusic(session, remoteUid, absMusicPath)
          current = await patchProject({
            music: current.music ? { ...current.music, beats: beats.beats } : current.music
          })
        } catch (err) {
          // Non-fatal: cut analysis still works without beat data.
          void window.noey.log.write('useProjectPipeline', `uploadMusic failed: ${String(err)}`)
        }
        if (isStale(runToken)) return
      }

      setProgressMsg('กำลังย่อวิดีโอให้ AI…')
      const projectDir = await window.noey.projects.dir(project.uid)
      const unsub = window.noey.sidecar.extractProxy.onProgress((evt: SidecarEvent) => {
        setProgressMsg(`กำลังย่อวิดีโอให้ AI ${evt.step}/${evt.total}…`)
      }, projectDir)
      try {
        await window.noey.sidecar.extractProxy.run({ projectDir })
      } finally {
        unsub()
      }
      if (isStale(runToken)) return

      setProgressMsg('กำลังอัพโหลดวิดีโอให้ AI…')
      const manifestUrl = window.noey.media.urlFor(project.uid, 'proxy/proxy_manifest.json')
      let proxies: ProxyManifestEntry[]
      try {
        proxies = (await (await fetch(manifestUrl)).json()) as ProxyManifestEntry[]
      } catch (err) {
        void window.noey.log.write(
          'useProjectPipeline',
          `proxy manifest fetch failed ${manifestUrl}: ${String(err)}`
        )
        throw new Error('อ่านไฟล์วิดีโอที่ย่อไว้ไม่ได้ — ลองวิเคราะห์ใหม่อีกครั้ง')
      }
      const { job_id } = await analyzeVideo(
        session,
        remoteUid,
        project.uid,
        proxies,
        current.cutStyleUid,
        briefWithRecutNotes(current)
      )
      await patchProject({ remote: { uid: remoteUid, jobId: job_id } })

      abortRef.current = new AbortController()
      await pollJob(
        session,
        job_id,
        (status) => {
          const result = status.result ?? {}
          setProgressMsg(String(result.message ?? 'กำลังวิเคราะห์…'))
          if (typeof result.thinking === 'string') setThinking(result.thinking)
          else setThinking('')
        },
        { signal: abortRef.current.signal }
      )

      const script = await getEditScript(session, remoteUid)
      applyEditScript(script)
      await runRenderSilent(script, remoteUid)
    } catch (exc) {
      await handlePipelineError(exc)
    }
  }

  // Zoom is NOT part of the render pipeline (2026-08-13): the wizard no longer
  // asks for a zoom style, and no pass runs automatically. Zoom is placed after
  // the cut exists, from the zoom-effects editor, against real footage.

  // ── stage: import (copy + normalise the sources) ─────────────────────────
  /**
   * Runs the sidecar ingest the wizard used to await. Owning it here means the
   * copy/transcode reports progress on the project's own card, fails like any
   * other stage (retry works), and survives an app restart mid-import — the
   * inputs live on the project row (`pendingSources`/`pendingMusic`).
   */
  const runImport = async (): Promise<boolean> => {
    const current = projectRef.current
    const sources = current.pendingSources ?? []
    if (sources.length === 0) {
      // Nothing to import (an older project, or a half-written row): treat the
      // clips already on disk as the import result rather than hanging here.
      await patchProject({ step: 'imported' })
      return true
    }
    markRunStarted()
    setProgressMsg('กำลังนำเข้าคลิป…')
    const projectDir = await window.noey.projects.dir(current.uid)
    const unsub = window.noey.sidecar.ingest.onProgress((evt: SidecarEvent) => {
      const msg = String(evt.message ?? '')
      setProgressMsg(
        evt.stage === 'transcode'
          ? msg || 'กำลังแปลงวิดีโอให้เล่น/ลากได้…'
          : `กำลังนำเข้าคลิป ${evt.step}/${evt.total}${msg ? ` · ${msg}` : ''}`
      )
    }, projectDir)
    let ingested: { clips?: unknown }
    try {
      ingested = (await window.noey.sidecar.ingest.run({
        projectDir,
        sources,
        mode: current.mode ?? 'dub_first'
      })) as { clips?: unknown }
    } finally {
      unsub()
    }

    // Music has to land before the step flips: the analyze stage reads
    // project.music when it starts, and the beat upload only happens if it is
    // already there.
    const pm = current.pendingMusic
    const music = pm
      ? {
          path: await window.noey.projects.importMusic(current.uid, pm.path),
          volume: 0.25,
          offsetSec: 0,
          trimInSec: pm.trimInSec,
          trimOutSec: pm.trimOutSec,
          muted: false
        }
      : undefined

    await patchProject({
      clips: (ingested.clips ?? []) as LocalProject['clips'],
      step: 'imported',
      pendingSources: undefined,
      pendingMusic: undefined,
      ...(music ? { music } : {})
    })
    setProgressMsg('')
    return true
  }

  /**
   * Burned-in caption fields for a dub render job.
   *
   * A dub has no transcript, so the lines ARE the source of truth: derived from
   * the cut the first time, then whatever the timeline editor saved. Captions
   * used to be dropped entirely on this path — the sidecar was never told about
   * them and the finished cut came out bare (live report 2026-08-13).
   */
  const captionJobFields = (
    lines: CaptionLine[]
  ): {
    captionStyle?: CaptionStyle
    captionLines?: CaptionLine[]
    captionWords?: ReturnType<typeof captionWordsFromLines>
  } => {
    const style = projectRef.current.captionStyle as CaptionStyle | undefined
    const usable = lines.filter((l) => l.text.trim() && l.end > l.start)
    if (!style || usable.length === 0) return {}
    return {
      captionStyle: style,
      captionLines: usable,
      captionWords: captionWordsFromLines(usable)
    }
  }

  /** Saved lines win; otherwise split each spoken line across its own scenes. */
  const dubCaptionLinesFor = (script: DubEditScript | null): CaptionLine[] => {
    const saved = projectRef.current.captionLines as CaptionLine[] | undefined
    if (saved?.length) return saved
    return dubCaptionLines(dubScenesFor(script))
  }

  /** Post-VO equivalent: lines the editor saved against the planned timeline,
   * else the same split re-timed onto that timeline's cuts. */
  const finalCaptionLinesFor = (
    timeline: DubTimeline,
    script: DubEditScript | null
  ): CaptionLine[] => {
    const saved = timeline.captionLines as CaptionLine[] | undefined
    if (saved?.length) return saved
    return dubCaptionLines(timelineScenesFor(timeline, script))
  }

  // ── stage: silent render ──────────────────────────────────────────────────
  const runRenderSilent = async (script: DubEditScript, remoteUid: string): Promise<void> => {
    await patchProject({ step: 'silent_rendering' })
    const projectDir = await window.noey.projects.dir(project.uid)
    const unsub = window.noey.sidecar.renderSilent.onProgress((evt: SidecarEvent) => {
      const msg =
        evt.stage === 'cut'
          ? `กำลังตัดซีนที่ ${evt.step}/${evt.total}…`
          : evt.stage === 'concat'
            ? 'กำลังรวมคลิป…'
            : evt.stage === 'music'
              ? 'กำลังใส่เพลงประกอบ…'
              : evt.stage === 'captions'
                ? 'กำลังใส่คำบรรยาย…'
                : evt.stage === 'bundle'
                  ? 'กำลังรวมไฟล์ทั้งชุด…'
                  : `กำลังทำ (${String(evt.stage)})…`
      setProgressMsg(msg)
      void window.noey.log.write(
        'useProjectPipeline',
        `renderSilent progress: ${JSON.stringify(evt)}`
      )
    }, projectDir)
    const captionLines = dubCaptionLinesFor(script)
    let clipDurationsSec: number[] | undefined
    try {
      const done = await window.noey.sidecar.renderSilent.run({
        projectDir,
        editScript: script,
        brief: live().brief || null,
        ...captionJobFields(captionLines),
        ...(await musicJobFields())
      })
      clipDurationsSec = (done as { clipDurationsSec?: number[] }).clipDurationsSec
    } finally {
      unsub()
    }
    // Real per-clip output durations (post frame-accurate re-encode) — the
    // effects layer's cut-boundary math (buildEffectsCutPoints) uses these
    // instead of the edit script's nominal sourceOut-sourceIn when present,
    // so scene-cut timing doesn't drift as rounding error accumulates across
    // segments (live report 2026-07-19).
    // Persist the lines that were actually burned in, so the timeline editor
    // opens on the same text/timing the video shows rather than re-deriving.
    const burnedLines = captionJobFields(captionLines).captionLines
    if (mode === 'highlight') {
      // No voiceover step at all — the silent cut IS the final output,
      // mirrors talking_head's runRenderTimeline going straight to done.
      await patchLocalStatus(session, remoteUid, 'done')
      await patchProject({
        step: 'done',
        clipDurationsSec,
        lastRunSeconds: runSeconds(),
        ...(burnedLines ? { captionLines: burnedLines } : {})
      })
    } else {
      await patchLocalStatus(session, remoteUid, 'waiting_vo')
      await patchProject({
        step: 'waiting_vo',
        clipDurationsSec,
        lastRunSeconds: runSeconds(),
        ...(burnedLines ? { captionLines: burnedLines } : {})
      })
    }
    setMediaKey((k) => k + 1)
    setProgressMsg('')
  }

  // ── stage: voiceover → plan → final render ───────────────────────────────
  /**
   * Plan and render the final cut against a voiceover that already exists on
   * disk — whichever way it got there. The recorder screen assembles takes
   * into one WAV and calls this; `runFinal` picks a file and calls this.
   */
  /**
   * The optional voiceover render, started from VoiceoverPage.
   *
   * Claims `pipelineRef` the way `retry()` does. Without it the busy effect
   * saw no live pipeline at step='planning', called ensurePipeline →
   * bootstrapPipeline, and `resumeStep('planning')` patched the step back to
   * 'waiting_vo' mid-render. That already bounced the user off the progress
   * screen; with waiting_vo terminal it would also fire a false "เสร็จแล้ว"
   * toast and OS notification.
   */
  const runFinalWithAudio = async (voiceoverPath: string): Promise<void> => {
    if (pipelineRef.current) return
    const run = runFinalWithAudioInner(voiceoverPath)
    pipelineRef.current = run.finally(() => {
      pipelineRef.current = null
    })
    await pipelineRef.current
  }

  const runFinalWithAudioInner = async (voiceoverPath: string): Promise<void> => {
    setError(null)
    markRunStarted()
    try {
      const remoteUid = live().remote?.uid
      if (!remoteUid) throw new Error('ไม่พบ remote project')

      const probe = await window.noey.sidecar.probe(voiceoverPath)
      const voDuration = Number(probe.duration)
      if (!voDuration || voDuration <= 0) throw new Error('อ่านความยาวไฟล์เสียงไม่ได้')

      await patchProject({ step: 'planning', voiceoverPath })
      setProgressMsg('AI กำลังวางแผน timeline ตามเสียงพากย์…')
      const timeline = await planDub(
        session,
        remoteUid,
        voDuration,
        live().clips.map((c) => c.durationSec)
      )

      await patchProject({ step: 'final_rendering', timeline })
      const projectDir = await window.noey.projects.dir(project.uid)
      const unsub = window.noey.sidecar.renderFinal.onProgress((evt: SidecarEvent) => {
        setProgressMsg(
          evt.stage === 'cut'
            ? `กำลังตัดช่วงที่ ${evt.step}/${evt.total}…`
            : evt.stage === 'mux'
              ? live().music
                ? 'กำลังใส่เสียงพากย์ + เพลงประกอบ…'
                : 'กำลังใส่เสียงพากย์…'
              : evt.stage === 'concat'
                ? 'กำลังรวมคลิป…'
                : evt.stage === 'captions'
                  ? 'กำลังใส่คำบรรยาย…'
                  : evt.stage === 'bundle'
                    ? 'กำลังรวมไฟล์ทั้งชุด…'
                    : `กำลังทำ (${String(evt.stage)})…`
        )
        void window.noey.log.write(
          'useProjectPipeline',
          `renderFinal progress: ${JSON.stringify(evt)}`
        )
      }, projectDir)
      const captionLines = finalCaptionLinesFor(timeline, editScript)
      let finalClipDurations: number[] | undefined
      try {
        const doneFinal = await window.noey.sidecar.renderFinal.run({
          projectDir,
          timeline,
          voiceoverPath,
          ...captionJobFields(captionLines),
          ...(await musicJobFields())
        })
        finalClipDurations = (doneFinal as { clipDurationsSec?: number[] }).clipDurationsSec
      } finally {
        unsub()
      }
      // This pass re-cut clips/ from its own cut list, so the durations the
      // silent render stored describe a video that no longer exists. Persist
      // the new ones BEFORE the effects re-apply below — that step clamps zoom
      // windows to cut boundaries derived from exactly this array.
      if (finalClipDurations?.length) {
        await patchProject({ clipDurationsSec: finalClipDurations })
      }

      // Effects placed while waiting for the VO (on final_silent.mp4) carry
      // over: same cuts → same timing, so re-composite the stored effects.json
      // onto the voiced final.mp4 automatically.
      try {
        const { getEffectsDoc } = await import('./effectsLocalApi')
        const { renderEffectsDoc } = await import('./effectsPipeline')
        const fxDoc = await getEffectsDoc(session, remoteUid)
        if (fxDoc.instances.length > 0) {
          setProgressMsg('กำลังใส่การซูมเดิมลงวิดีโอที่มีเสียง…')
          await renderEffectsDoc(
            {
              session,
              localUid: project.uid,
              remoteUid,
              baseFile: 'final.mp4',
              project: live(),
              onProgress: setProgressMsg
            },
            fxDoc
          )
        }
      } catch (fxErr) {
        // Effects re-apply is best-effort — the voiced final.mp4 is already
        // good; the user can re-render effects from the editor if this fails.
        console.error('effects re-apply failed', fxErr)
      }

      await patchLocalStatus(session, remoteUid, 'done')
      await patchProject({ step: 'done', lastRunSeconds: runSeconds() })
      setMediaKey((k) => k + 1)
      setProgressMsg('')
    } catch (exc) {
      await handlePipelineError(exc)
    }
  }

  /** Pick one audio file for the whole clip — the path that predates the
   * per-line recorder, kept for a voiceover recorded elsewhere. */
  const runFinal = async (): Promise<void> => {
    setError(null)
    const picked = await pickFile('audio/*')
    if (!picked) return
    await runFinalWithAudio(picked.path)
  }

  // ── stage: talking_head (extract audio → server transcribe+plan → local render) ──
  const runTalkingHead = async (): Promise<void> => {
    setError(null)
    setThinking('')
    markRunStarted()
    const runToken = beginRun()
    void window.noey.log.write('useProjectPipeline', `runTalkingHead start token=${runToken}`)
    setProgressMsg('กำลังเตรียมถอดเสียง…')
    try {
      let current = await patchProject({
        step: 'extracting_audio',
        mode: 'talking_head',
        error: undefined
      })

      let remoteUid = current.remote?.uid
      if (!remoteUid) {
        const created = await createLocalProject(session, {
          mode: 'talking_head',
          brief: current.brief || null,
          target_duration_sec: current.targetDurationSec ?? null,
          clips: current.clips.map((c) => ({
            id: c.id,
            durationSec: c.durationSec,
            width: c.width,
            height: c.height,
            fps: c.fps
          })),
          caption_style: (current.captionStyle as CaptionStyleIn | undefined) ?? null
        })
        remoteUid = created.uid
        current = await patchProject({ remote: { uid: remoteUid } })
      }

      const projectDir = await window.noey.projects.dir(project.uid)
      setProgressMsg('กำลังแยกเสียงจากคลิป…')
      const unsubAudio = window.noey.sidecar.extractAudio.onProgress((evt: SidecarEvent) => {
        setProgressMsg(`กำลังแยกเสียงคลิป ${evt.step}/${evt.total}…`)
      }, projectDir)
      let wavs: { file: string; name: string }[]
      try {
        const done = await window.noey.sidecar.extractAudio.run({ projectDir })
        wavs = done.wavs as { file: string; name: string }[]
      } finally {
        unsubAudio()
      }
      if (isStale(runToken)) return

      // No proxy encode here: the cut is decided from Scribe's word timings, so
      // talking_head never sends video off the machine — only the speech WAVs.
      await patchProject({ step: 'transcribing' })
      setProgressMsg('กำลังอัพโหลดไฟล์เสียง…')
      const { job_id } = await uploadAudio(session, remoteUid, project.uid, wavs)
      await patchProject({ remote: { uid: remoteUid, jobId: job_id } })

      abortRef.current = new AbortController()
      await pollJob(
        session,
        job_id,
        (status) => {
          const result = status.result ?? {}
          setProgressMsg(String(result.message ?? 'กำลังถอดเสียง…'))
          if (typeof result.thinking === 'string') setThinking(result.thinking)
          else setThinking('')
        },
        { signal: abortRef.current.signal }
      )

      const timeline = await getLocalTimeline(session, remoteUid)
      await runRenderTimeline(timeline, remoteUid)
    } catch (exc) {
      await handlePipelineError(exc)
    }
  }

  const runRenderTimeline = async (timeline: DubTimeline, remoteUid: string): Promise<void> => {
    await patchProject({ step: 'rendering', timeline })
    const projectDir = await window.noey.projects.dir(project.uid)
    const unsub = window.noey.sidecar.renderTimeline.onProgress((evt: SidecarEvent) => {
      setProgressMsg(
        evt.stage === 'cut'
          ? `กำลังตัดช่วงที่ ${evt.step}/${evt.total}…`
          : evt.stage === 'concat'
            ? 'กำลังรวมคลิป…'
            : 'กำลังรวมไฟล์ทั้งชุด…'
      )
    }, projectDir)
    try {
      await window.noey.sidecar.renderTimeline.run({ projectDir, timeline })
    } finally {
      unsub()
    }
    await patchLocalStatus(session, remoteUid, 'done')
    await patchProject({ step: 'done', lastRunSeconds: runSeconds() })
    setMediaKey((k) => k + 1)
    setProgressMsg('')
  }

  const resumeFromJobPoll = async (kind: 'analyzing' | 'transcribing'): Promise<void> => {
    const remoteUid = projectRef.current.remote?.uid
    const jobId = projectRef.current.remote?.jobId
    if (!remoteUid || !jobId) {
      if (kind === 'analyzing') await runAnalyze()
      else await runTalkingHead()
      return
    }

    setProgressMsg(
      kind === 'analyzing' ? 'กำลังเชื่อมต่อ job วิเคราะห์…' : 'กำลังเชื่อมต่อ job ถอดเสียง…'
    )
    setError(null)
    setThinking('')
    beginRun()
    abortRef.current = new AbortController()
    try {
      await pollJob(
        session,
        jobId,
        (status) => {
          const result = status.result ?? {}
          setProgressMsg(
            String(result.message ?? (kind === 'analyzing' ? 'กำลังวิเคราะห์…' : 'กำลังถอดเสียง…'))
          )
          if (typeof result.thinking === 'string') setThinking(result.thinking)
          else setThinking('')
        },
        { signal: abortRef.current.signal }
      )
      if (kind === 'analyzing') {
        const script = await getEditScript(session, remoteUid)
        applyEditScript(script)
        await runRenderSilent(script, remoteUid)
      } else {
        const timeline = await getLocalTimeline(session, remoteUid)
        await runRenderTimeline(timeline, remoteUid)
      }
    } catch (exc) {
      await handlePipelineError(exc)
    }
  }

  const bootstrapPipeline = async (): Promise<void> => {
    const current = projectRef.current
    const currentStep = current.step as ProjectStep
    const currentMode: ProjectMode = current.mode ?? 'dub_first'
    // Who starts work, and why, is the single hardest thing to reconstruct
    // after the fact when a stopped job appears to restart itself.
    void window.noey.log.write(
      'useProjectPipeline',
      `bootstrap uid=${current.uid} step=${currentStep} mode=${currentMode} remote=${current.remote?.uid ?? 'none'} runId=${runIdRef.current}`
    )

    if (isTerminal(currentStep)) return

    // Sources still need copying/transcoding — do that first, then continue
    // into this mode's first AI stage without waiting for another kick.
    if (currentStep === 'importing') {
      const importToken = beginRun()
      if (!(await runImport())) return
      // Stopped while the sources were being copied/transcoded — do not walk
      // on into the AI stage.
      if (isStale(importToken)) return
      if (currentMode === 'talking_head') await runTalkingHead()
      else await runAnalyze()
      return
    }

    // Stopped mid-run: user must hit retry — do not auto-restart.
    if (currentStep === 'imported' && current.remote?.uid) return

    // Brand-new project: no remote row yet → start once.
    if (currentStep === 'imported') {
      if (currentMode === 'talking_head') await runTalkingHead()
      else await runAnalyze()
      return
    }

    // Remount / HMR while server job still running → resume poll or restart.
    if (currentStep === 'analyzing' || currentStep === 'transcribing') {
      await resumeFromJobPoll(currentStep)
      return
    }

    if (currentStep === 'silent_rendering' && current.remote?.uid) {
      const remoteUid = current.remote.uid
      setProgressMsg('กำลังโหลด edit script…')
      const script = await getEditScript(session, remoteUid).catch(() => null)
      if (script) {
        applyEditScript(script)
        await runRenderSilent(script, remoteUid)
      } else {
        await fail(new Error('ไม่พบ edit script บนเซิร์ฟเวอร์ — ลองวิเคราะห์ใหม่'))
      }
      return
    }

    if (currentStep === 'rendering' && current.remote?.uid) {
      const remoteUid = current.remote.uid
      setProgressMsg('กำลังโหลด timeline…')
      const timeline =
        (current.timeline as DubTimeline | undefined) ??
        (await getLocalTimeline(session, remoteUid).catch(() => null))
      if (timeline) await runRenderTimeline(timeline, remoteUid)
      else await fail(new Error('ไม่พบ timeline บนเซิร์ฟเวอร์ — ลองถอดเสียงใหม่'))
      return
    }

    const checkpoint = resumeStep(currentStep)
    if (checkpoint === currentStep) return
    await patchProject({ step: checkpoint })
    if (checkpoint === 'imported' && !current.remote?.uid) {
      if (currentMode === 'talking_head') await runTalkingHead()
      else await runAnalyze()
    }
  }

  const ensurePipeline = useCallback((): void => {
    if (pipelineRef.current) return
    const currentStep = projectRef.current.step as ProjectStep
    if (isTerminal(currentStep)) return
    if (stoppingRef.current) return
    pipelineRef.current = bootstrapPipeline().finally(() => {
      pipelineRef.current = null
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session])

  // Resume: reload edit script / timeline when reopening at review steps.
  useEffect(() => {
    const remoteUid = project.remote?.uid
    const hasEditScript = mode === 'dub_first' || mode === 'highlight'
    if (hasEditScript && (step === 'waiting_vo' || step === 'done')) {
      void window.noey.log.write(
        'useProjectPipeline',
        `resume-check uid=${project.uid} remoteUid=${remoteUid ?? 'MISSING'} hasEditScript=${Boolean(editScript)}`
      )
    }
    if (!remoteUid) return
    if (hasEditScript && !editScript && (step === 'waiting_vo' || step === 'done')) {
      getEditScript(session, remoteUid)
        .then(applyEditScript)
        .catch((err) =>
          window.noey.log.write(
            'useProjectPipeline',
            `resume edit-script fetch failed (uid=${remoteUid}): ${String(err)}`
          )
        )
    }
    if (mode === 'talking_head' && !project.timeline && (step === 'rendering' || step === 'done')) {
      getLocalTimeline(session, remoteUid)
        .then((tl) => patchProject({ timeline: tl }))
        .catch(() => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  // Kick pipeline on mount and whenever a busy step has no in-flight work
  // (covers Vite HMR preserving step=analyzing but dropping the async chain).
  useEffect(() => {
    ensurePipeline()
  }, [ensurePipeline])

  useEffect(() => {
    if (!isBusy(step) || stopping) return
    if (pipelineRef.current) return
    ensurePipeline()
  }, [step, stopping, ensurePipeline])

  /**
   * Manual start / restart. Marked as the in-flight pipeline for its whole
   * duration: without that, the busy-step effect saw `pipelineRef === null`,
   * ran bootstrapPipeline CONCURRENTLY with this chain, and its resume branch
   * rewrote `step` back to the checkpoint underneath a live run (observed
   * 2026-08-13: two bootstraps mid-run right after "เริ่มตัดต่อ").
   */
  const retry = async (): Promise<void> => {
    if (pipelineRef.current) return
    void window.noey.log.write('useProjectPipeline', `retry uid=${project.uid} step=${step}`)
    setError(null)
    const run = (async () => {
      await patchProject({ step: 'imported', error: undefined })
      if (mode === 'talking_head') await runTalkingHead()
      else await runAnalyze()
    })()
    pipelineRef.current = run.finally(() => {
      pipelineRef.current = null
    })
    await pipelineRef.current
  }

  /**
   * "ให้ AI ตัดใหม่" — run the cut again with the same settings plus a comment
   * about what to change (HANDOFF R12.4).
   *
   * The comment is appended to the brief at RUN time and never written over
   * `project.brief`: the stored brief has to stay the original, or round five
   * would carry five stacked copies of every earlier comment.
   *
   * Only dub_first/highlight. talking_head cuts to a transcript, not to an
   * AI's judgement, so there is nothing for a comment to steer — the menu item
   * is disabled for it rather than failing silently here.
   */
  const recut = async (text: string): Promise<void> => {
    const note = text.trim()
    if (!note || pipelineRef.current || mode === 'talking_head') return
    void window.noey.log.write('useProjectPipeline', `recut uid=${project.uid}`)
    setError(null)

    const run = (async () => {
      const current = live()
      const notes = current.recutNotes ?? []
      const round = (notes.at(-1)?.round ?? 1) + 1

      // Keep this round's output before anything overwrites it. stashRender
      // replaces whatever was kept before, so the folder holds one spare
      // version no matter how many rounds are run.
      const files = await window.noey.projects.stashRender(project.uid)
      await patchProject({
        recutNotes: [...notes, { round, text: note, at: new Date().toISOString() }],
        previousRender: {
          round: round - 1,
          at: current.updatedAt,
          files,
          editScript: current.editScript,
          clipDurationsSec: current.clipDurationsSec,
          timeline: current.timeline,
          captionLines: current.captionLines
        },
        step: 'imported',
        error: undefined
      })
      await runAnalyze()
    })()
    pipelineRef.current = run.finally(() => {
      pipelineRef.current = null
    })
    await pipelineRef.current
  }

  /**
   * Undo the latest recut: put the kept render back and drop the new one.
   *
   * `recutNotes` is deliberately left alone — what the user asked for is still
   * what they asked for, and the dialog shows that history to build on.
   */
  const revertRecut = async (): Promise<void> => {
    const kept = live().previousRender
    if (!kept || pipelineRef.current) return
    void window.noey.log.write('useProjectPipeline', `revertRecut uid=${project.uid}`)
    await window.noey.projects.restoreRender(project.uid)
    const restored = await patchProject({
      previousRender: undefined,
      editScript: kept.editScript,
      clipDurationsSec: kept.clipDurationsSec,
      timeline: kept.timeline,
      captionLines: kept.captionLines,
      error: undefined
    })
    setEditScript((restored.editScript as unknown as DubEditScript | undefined) ?? null)
    setMediaKey((k) => k + 1)
  }

  /** Draft save: write the edit model to disk + server, render nothing. */
  const saveDraftCuts = async (
    cuts: SaveCutPayload[],
    target: 'edit_script' | 'timeline',
    captionLines?: CaptionLine[]
  ): Promise<void> => {
    const remoteUid = live().remote?.uid
    if (!remoteUid) return
    if (target === 'edit_script') {
      const es = editScriptFromCuts(cuts)
      applyEditScript(es)
      // Pre-VO caption edits have nowhere else to live: there is no planned
      // timeline yet, so they go on the project and the next silent render
      // burns exactly them.
      if (captionLines) await patchProject({ captionLines })
      await putLocalEditScript(session, remoteUid, es)
      return
    }
    const base = (live().timeline ?? {}) as DubTimeline
    const timeline: DubTimeline = {
      ...base,
      mode,
      timeline: cuts.map((c) => ({
        type: 'cut',
        source: c.source,
        in: c.in,
        out: c.out,
        label: c.label
      })),
      ...(captionLines ? { captionLines } : {})
    }
    await putLocalTimeline(session, remoteUid, timeline).catch(() => undefined)
    // A draft is only ever a fallback for work not yet rendered, so it must
    // never win over a render that started after it: pressing Save while a
    // debounced draft was mid-flight let the draft's post-round-trip write land
    // last and put the pre-render timeline back on the project.
    if (isBusy(projectRef.current.step as ProjectStep)) return
    await patchProject({ timeline })
  }

  const saveEditedCuts = async (
    cuts: SaveCutPayload[],
    target: 'edit_script' | 'timeline',
    captionLines?: CaptionLine[]
  ): Promise<void> => {
    const remoteUid = live().remote?.uid
    if (!remoteUid) throw new Error('ไม่พบ remote project')
    if (target === 'edit_script') {
      const es = editScriptFromCuts(cuts)
      applyEditScript(es)
      if (captionLines) await patchProject({ captionLines })
      await putLocalEditScript(session, remoteUid, es)
      await runRenderSilent(es, remoteUid)
    } else {
      const base = (live().timeline ?? {}) as DubTimeline
      const timeline: DubTimeline = {
        ...base,
        mode,
        timeline: cuts.map((c) => ({
          type: 'cut',
          source: c.source,
          in: c.in,
          out: c.out,
          label: c.label
        })),
        // talking_head burns from `timeline.captionStyle` (the sidecar reads it
        // off the timeline, not off the project), and the editor's appearance
        // picker writes only `project.captionStyle` — so every change made in
        // the editor was dropped at render and the clip kept the style chosen
        // at creation. Carry the project's copy in, it is the live one.
        ...(live().captionStyle ? { captionStyle: live().captionStyle } : {}),
        ...(captionLines ? { captionLines } : {})
      }
      if (mode === 'talking_head') {
        await putLocalTimeline(session, remoteUid, timeline).catch(() => undefined)
        await runRenderTimeline(timeline, remoteUid)
        return
      }
      if (!live().voiceoverPath) throw new Error('ไม่พบไฟล์เสียงพากย์เดิม')
      await patchProject({ step: 'final_rendering', timeline })
      const projectDir = await window.noey.projects.dir(project.uid)
      const unsub = window.noey.sidecar.renderFinal.onProgress((evt: SidecarEvent) => {
        setProgressMsg(
          evt.stage === 'cut'
            ? `กำลังตัดช่วงที่ ${evt.step}/${evt.total}…`
            : evt.stage === 'mux'
              ? live().music
                ? 'กำลังใส่เสียงพากย์ + เพลงประกอบ…'
                : 'กำลังใส่เสียงพากย์…'
              : 'กำลังประกอบวิดีโอ…'
        )
        void window.noey.log.write(
          'useProjectPipeline',
          `renderFinal progress: ${JSON.stringify(evt)}`
        )
      }, projectDir)
      let finalClipDurations: number[] | undefined
      try {
        const doneFinal = await window.noey.sidecar.renderFinal.run({
          projectDir,
          timeline,
          voiceoverPath: live().voiceoverPath,
          ...captionJobFields(finalCaptionLinesFor(timeline, editScript)),
          ...(await musicJobFields())
        })
        finalClipDurations = (doneFinal as { clipDurationsSec?: number[] }).clipDurationsSec
      } finally {
        unsub()
      }
      await patchLocalStatus(session, remoteUid, 'done')
      // Re-cut clips → the stored per-clip durations describe the old render.
      await patchProject({
        step: 'done',
        lastRunSeconds: runSeconds(),
        ...(finalClipDurations?.length ? { clipDurationsSec: finalClipDurations } : {})
      })
      setMediaKey((k) => k + 1)
      setProgressMsg('')
    }
  }

  /** dub_first pre-render only: AI-assisted re-edit of the LIVE (possibly
   * unsaved) cuts. Renders a fresh silent preview off `cuts` (not the last
   * save), uploads it + the current script + instruction, polls the job, and
   * returns the revised cut list — preview only, caller still hits Save. */
  const requestAiReedit = async (
    cuts: SaveCutPayload[],
    selectedLineIds: number[],
    instruction: string
  ): Promise<EditCut[]> => {
    const remoteUid = project.remote?.uid
    if (!remoteUid) throw new Error('ไม่พบ remote project')
    const es = editScriptFromCuts(cuts)
    const projectDir = await window.noey.projects.dir(project.uid)
    setProgressMsg('กำลังสร้าง preview จากที่แก้ไขอยู่…')
    const previewEvt = (await window.noey.sidecar.renderAiPreview.run({
      projectDir,
      editScript: es
    })) as SidecarEvent & { preview?: string }
    const previewPath = String(previewEvt.preview ?? '')
    if (!previewPath) throw new Error('สร้าง preview ไม่สำเร็จ')

    setProgressMsg('กำลังส่งให้ AI แก้ไข…')
    const { job_id } = await reeditDubScenes(
      session,
      remoteUid,
      previewPath,
      { selectedLineIds, instruction },
      project.cutStyleUid
    )
    const final = await pollJob(session, job_id, (status) => {
      const result = status.result as { thinking?: string; message?: string } | null
      if (result?.thinking) setThinking(result.thinking)
      else if (result?.message) setProgressMsg(result.message)
    })
    setThinking('')
    setProgressMsg('')
    const segments =
      (final.result as { segments?: Record<string, unknown>[] } | null)?.segments ?? []
    return editCutsFromDubSegments(segments)
  }

  const openEditor = (): void => {
    // talking_head always edits the render timeline. dub_first: post-VO
    // (done + planned timeline) edits the timeline; otherwise the edit script.
    const target: 'edit_script' | 'timeline' =
      mode === 'talking_head' || (step === 'done' && project.timeline) ? 'timeline' : 'edit_script'
    const timeline = (project.timeline as DubTimeline | undefined) ?? null
    // Captions apply to both modes now, on different sources. A previously
    // saved edit always wins; otherwise the initial grouping is derived so
    // there is something to edit on first open.
    //
    // talking_head has real word timestamps from the transcript.
    // dub_first has none — the voiceover is recorded against the cut, never
    // transcribed — so its lines come from splitting each spoken line's text
    // across the scenes cut for it (see dubCaptionLines).
    const savedCaptionLines = timeline?.captionLines as CaptionLine[] | undefined
    const captionLines = !project.captionStyle
      ? undefined
      : mode === 'talking_head'
        ? (savedCaptionLines ??
          groupWordsIntoLines(
            (timeline?.words as { word: string; start: number; end: number }[]) ?? []
          ))
        : (savedCaptionLines ??
          (project.captionLines as CaptionLine[] | undefined) ??
          dubCaptionLines(dubScenesFor(editScript)))
    configureEditorApi({
      localUid: project.uid,
      clips: project.clips,
      editTarget: target,
      editScript,
      timeline,
      captionLines,
      // dubCaptionLines lays the spoken lines along the CUT (output clock);
      // groupWordsIntoLines uses raw transcript words (source clock).
      captionTimeBase: mode === 'talking_head' ? 'source' : 'output',
      // preload types captionStyle structurally (strings, not the literal
      // unions) because it crosses the IPC boundary; the values are written by
      // the wizard's own CaptionStyle picker, so the narrowing is safe.
      captionStyle: project.captionStyle as CaptionStyle | undefined,
      // Changing appearance re-renders nothing on its own — the burn-in happens
      // on the next render, and the editor's Save is what triggers that.
      onCaptionStyleChange: async (captionStyle) => {
        await patchProject({ captionStyle })
      },
      music: mode === 'dub_first' || mode === 'highlight' ? project.music : undefined,
      onMusicChange: mode === 'dub_first' || mode === 'highlight' ? updateMusic : undefined,
      onSetMusic: mode === 'dub_first' || mode === 'highlight' ? setMusicTrack : undefined,
      onPickMusic: mode === 'dub_first' || mode === 'highlight' ? pickMusic : undefined,
      onRemoveMusic: mode === 'dub_first' || mode === 'highlight' ? removeMusic : undefined,
      onSave: (cuts, lines) => saveEditedCuts(cuts, target, lines),
      onSaveDraft: (cuts, lines) => saveDraftCuts(cuts, target, lines),
      // AI re-edit only applies to dub_first before the voiceover/final render.
      onAiReedit:
        target === 'edit_script'
          ? (cuts, selectedLineIds, instruction) =>
              requestAiReedit(cuts, selectedLineIds, instruction)
          : undefined
    })
    setShowEditor(true)
  }

  return {
    project,
    step,
    mode,
    runStartedAt,
    progressMsg,
    thinking,
    editScript,
    error,
    mediaKey,
    showEditor,
    setShowEditor,
    runAnalyze,
    runTalkingHead,
    runFinal,
    runFinalWithAudio,
    patch: async (p) => {
      await patchProject(p)
    },
    pickMusic,
    updateMusic,
    removeMusic,
    retry,
    recut,
    revertRecut,
    stop,
    stopping,
    openEditor
  }
}
