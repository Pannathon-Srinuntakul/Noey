import { useCallback, useEffect, useRef, useState } from 'react'
import type { LocalProject, SidecarEvent } from '@renderer/platform/types'
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
import { clipAbsOffsets, remapWordsToOutput, type TimedWord } from './timelineMath'

/** talking_head + the R17 speech modes all run the audio chain
 * (extract → transcribe → render locally); everything else runs the
 * video-analysis chain. */
function isSpeechMode(mode: string | undefined): boolean {
  return mode === 'talking_head' || mode === 'speech_scenes' || mode === 'speech_highlights'
}

/** The speech_highlights plan: N mini-timelines plus display metadata, embedded
 * in one index so the desktop needs no per-highlight endpoint (R17.3). */
export interface HighlightIndexItem {
  id: string
  title: string
  why: string
  score: number
  srcIn: number
  srcOut: number
  durationSec: number
  speakers: string[]
  video: string
  srt: string
  timeline?: Record<string, unknown>
}

export interface HighlightIndex {
  mode: 'speech_highlights'
  count: number
  items: HighlightIndexItem[]
}

/** What the project row keeps: the metadata WITHOUT the embedded timelines —
 * they are render input, not display state, and a 2 h source makes each one
 * big enough to bloat every project.json write. */
export function stripIndexTimelines(index: HighlightIndex): HighlightIndex {
  return { ...index, items: index.items.map(({ timeline: _t, ...rest }) => ({ ...rest })) }
}
import { dubScenesFor, timelineScenesFor } from './dubScenes'
import { countShotsWithAlternates, retimeTimelineForSwap, type ShotSwapLogEntry } from './shotSwap'
import type { CaptionStyle } from './captionStyle'
import { pickFile } from './pickFile'
import type { ProjectMode, ProjectStep } from './projectFlow'
import { isBusy, isTerminal, resumeStep } from './projectFlow'
import { canSnapToBeat, canUseZoomEffects } from './platformFeatures'
import { transcodeOnServer } from './serverTranscode'

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
  /** R18b ปรับช็อต: persist a shot-swapped edit script and reassemble locally —
   * zero AI calls (the swap data came with the original analysis answer). */
  /** Push this project's files to the server outside a render (voiceover takes). */
  syncFiles: (why: string) => void
  applyShotSwap: (patchedScript: DubEditScript, swapLog?: ShotSwapLogEntry[]) => Promise<void>
  /** Rewrite one dub line's text everywhere it lives (edit script + server) —
   * the detail page's inline script editing. Text only; no re-render. */
  updateScriptLine: (lineId: number, text: string) => Promise<void>
  stop: () => Promise<void>
  stopping: boolean
  openEditor: () => void
}

/**
 * The cut's scenes in OUTPUT time, tagged with the voiceover line each was cut
 * for. Durations accumulate because the segments play back to back, which is
 * what makes an output-time caption possible without re-measuring the render.
 */

/**
 * The clip list POST /videos/local will actually accept — validated HERE so a
 * bad list fails with an actionable Thai sentence instead of the server's
 * pydantic 422 (which is what a dropped import produced: `clips: []`, a 422,
 * and an English error nobody could act on — live 2026-09-09).
 */
function clipsForApi(clips: LocalProject['clips'] | undefined): {
  id: string
  durationSec: number
  width: number
  height: number
  fps: number
}[] {
  const out = (clips ?? [])
    .filter((c) => Number.isFinite(c.durationSec) && c.durationSec > 0)
    .map((c) => ({
      id: c.id,
      durationSec: Number(c.durationSec),
      width: Number.isFinite(c.width) ? Math.round(c.width) : 0,
      height: Number.isFinite(c.height) ? Math.round(c.height) : 0,
      fps: Number.isFinite(c.fps) && c.fps > 0 ? Math.round(c.fps) : 30
    }))
  if (out.length === 0) {
    throw new Error('ยังไม่ได้นำเข้าคลิป — กด "ลองใหม่" เพื่อเริ่มนำเข้าอีกครั้ง')
  }
  return out
}

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

  /** The zoom bake belongs to the render it was baked ON. Local jobs delete it
   * (engine/jobs/renderSilent.ts) but top-level names are never swept, so the
   * server's copy must go explicitly or the preview cascade — which prefers
   * final_fx.mp4 — resurrects last round's bake over the new cut. */
  const dropServerFxBake = (): void => {
    const remoteUid = projectRef.current.remote?.uid
    if (!remoteUid) return
    void (async () => {
      const { deleteProjectFile } = await import('./projectSync')
      await deleteProjectFile(session, remoteUid, 'final_fx.mp4').catch(() => undefined)
    })()
  }

  const resetAfterStop = async (): Promise<void> => {
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
    // The SAME checkpoint a reload uses, not a flat 'imported'. Parking every
    // stop at 'imported' threw away work a crash would have kept: a stop
    // during final_rendering hid the voiceover button and the only path back
    // was retry() -> runAnalyze() -- a second billed AI cut over an approved
    // script. A checkpoint that is itself busy is downgraded to 'imported' so
    // stopping never auto-restarts the thing that was just stopped.
    const liveStep = projectRef.current.step as ProjectStep
    const parked = resumeStep(liveStep)
    await patchProject({
      step: isBusy(parked) ? 'imported' : parked,
      error: undefined,
      remote: projectRef.current.remote
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
    // 'error' is a resting state like waiting_vo: the project can sit here for
    // good, holding files that were expensive to make. Without this a project
    // that died AFTER its silent render existed only in one browser.
    syncToServer('error')
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
      // Removing the track deletes the local mix inside the job -- but the
      // server still holds final_silent_music.mp4, and the preview probe
      // resolves THAT copy through the service worker, so the user heard the
      // music they had just removed. Top-level names are not swept, so the
      // delete has to be explicit.
      if (!music) {
        const remoteUid = live().remote?.uid
        if (remoteUid) {
          void (async () => {
            const { deleteProjectFile } = await import('./projectSync')
            await deleteProjectFile(session, remoteUid, 'final_silent_music.mp4').catch(
              () => undefined
            )
          })()
        }
      }
      // Music edits happen at waiting_vo/done -- resting states where nothing
      // else will ever sync. Both arms: even when the mix was skipped,
      // patchProject({ music }) has already changed project.json.
      syncToServer('music')
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
          engine: current.engine ?? null,
          precision: current.precision ?? null,
          clips: clipsForApi(current.clips)
        })
        remoteUid = created.uid
        current = await patchProject({ remote: { uid: remoteUid } })
      }

      // `beatSync !== false` rather than `=== true`: projects created before
      // the wizard exposed the switch have no field, and they were beat-cut.
      //
      // `canSnapToBeat` gates the whole block on this build: the analysis is a
      // server-side pass and the editor has no snap control to use its result,
      // so the grid would be computed and then ignored. (It is NOT about
      // keeping the music off the server — `music/` is a synced root and the
      // track is already there.)
      if (canSnapToBeat && current.music?.path && current.beatSync !== false) {
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
        briefWithRecutNotes(current),
        // Re-sent every run, including "ให้ AI ตัดใหม่": the local project row
        // is the source of truth for the user's tier choice.
        { engine: current.engine, precision: current.precision }
      )

      // Warm the editor's thumbnail lanes while the AI poll runs — the engine
      // is idle for those minutes, and the first editor open used to pay this
      // cost at the door ("thumbnail ไม่แสดง ต้องรอ", 2026-09-09). Idempotent
      // (the job trusts its manifests) and behind the project lock, so it can
      // never interleave with the render that follows the plan.
      void window.noey.sidecar.filmstrip
        .run({
          projectDir,
          clips: (projectRef.current.clips ?? []).map((c) => ({ id: c.id, file: c.file }))
        })
        .catch(() => undefined)
      // A stop pressed during the upload used to be ignored: no token check
      // between here and the render meant the whole billed run completed and
      // the card flipped back to busy. The job exists now, so a stale run
      // cancels it server-side rather than paying for an answer nobody reads.
      if (isStale(runToken)) {
        cancelRemoteProject(session, remoteUid).catch(() => undefined)
        return
      }
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

      if (isStale(runToken)) return
      const script = await getEditScript(session, remoteUid)
      applyEditScript(script)
      if (isStale(runToken)) return
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
  /** A converted clip is an MP4 whatever the source was called. */
  const replaceExt = (name: string): string => {
    const dot = name.lastIndexOf('.')
    return (dot > 0 ? name.slice(0, dot) : name) + '.mp4'
  }

  /**
   * Copy this project's files to the server so it can be opened elsewhere.
   *
   * Best effort, always: a project whose files did not reach the server still
   * works perfectly on the machine that made it. Losing the sync costs
   * portability, not work — so this never fails a render, and never blocks the
   * UI on a slow upload.
   *
   * Called at the points where the files actually change: after the import
   * that creates them, and after each render that rewrites them.
   */
  const syncToServer = (why: string): void => {
    const current = projectRef.current
    const remoteUid = current.remote?.uid
    if (!remoteUid) return
    void (async () => {
      try {
        const { pushProjectFiles } = await import('./projectSync')
        const res = await pushProjectFiles(session, current.uid, remoteUid)
        if (res.uploaded > 0) {
          void window.noey.log.write(
            'projectSync',
            `${why}: uploaded ${res.uploaded} files, ${(res.bytes / 1e6).toFixed(1)} MB`
          )
        }
      } catch (err) {
        void window.noey.log.write('projectSync', `${why}: sync skipped — ${String(err)}`)
      }
    })()
  }

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

    // Clips this browser cannot decode go to the server's ffmpeg first — see
    // `serverTranscode.ts` for why that exception exists and how narrow it is.
    // Everything else, H.264 included, is handled entirely on this machine.
    const prepared: string[] = []
    for (let i = 0; i < sources.length; i++) {
      const src = sources[i]
      let decodable: boolean | undefined
      let name = src.split('/').pop() ?? 'clip.mp4'
      try {
        const info = await window.noey.sidecar.probe(src)
        decodable = (info as { decodable?: boolean }).decodable
        name = String((info as { name?: string }).name ?? name)
      } catch {
        // A probe that fails is not a verdict — let ingest make the call.
      }
      if (decodable === false) {
        setProgressMsg(`กำลังแปลงคลิป ${i + 1}/${sources.length} บนเซิร์ฟเวอร์…`)
        const blob = await window.noey.pick.read(src)
        const converted = await transcodeOnServer(session, blob, name, (p) =>
          setProgressMsg(`แปลงคลิป ${i + 1}/${sources.length} · ${p.message} (${p.percent}%)`)
        )
        prepared.push(await window.noey.pick.register(converted, replaceExt(name)))
      } else {
        prepared.push(src)
      }
    }

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
        sources: prepared,
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

    let afterImport = await patchProject({
      clips: (ingested.clips ?? []) as LocalProject['clips'],
      step: 'imported',
      pendingSources: undefined,
      pendingMusic: undefined,
      ...(music ? { music } : {})
    })

    // The server row is created HERE, not in the analyze stage. syncToServer
    // no-ops without remote.uid, and on a first run the row used to be born
    // only inside runAnalyze -- which made the sync below structurally dead:
    // an import that then failed at analyze (or a user who closed the tab)
    // left NOTHING on the server, not even project.json, so the project did
    // not exist anywhere but this browser.
    if (!afterImport.remote?.uid) {
      try {
        const created = await createLocalProject(session, {
          mode: (afterImport.mode ?? 'dub_first') as ProjectMode,
          brief: afterImport.brief || null,
          user_script: afterImport.userScript || null,
          target_duration_sec: afterImport.targetDurationSec ?? null,
          engine: afterImport.engine ?? null,
          precision: afterImport.precision ?? null,
          clips: clipsForApi(afterImport.clips)
        })
        afterImport = await patchProject({ remote: { uid: created.uid } })
      } catch (err) {
        // Best-effort like the sync itself: the import must not fail because
        // the row could not be made. runAnalyze retries the creation.
        void window.noey.log.write('useProjectPipeline', `remote row create failed: ${String(err)}`)
      }
    }
    syncToServer('import')
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
  const runRenderSilent = async (
    script: DubEditScript,
    remoteUid: string,
    opts?: { continueToFinal?: boolean }
  ): Promise<void> => {
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
      dropServerFxBake()
      syncToServer('render')
    } else if (opts?.continueToFinal) {
      // The locked shot-swap runs silent -> final as ONE job. Passing through
      // waiting_vo here made jobs.tsx read busy->terminal and announce
      // "ตัดคลิปเสร็จแล้ว" while the final render had not started, and queued
      // a whole-project sync that raced the final render's own.
      await patchProject({
        clipDurationsSec,
        ...(burnedLines ? { captionLines: burnedLines } : {})
      })
    } else {
      // Key first, terminal step second: the moment consumers see waiting_vo
      // they probe for the preview, and probing under the OLD key caches a
      // placeholder-era answer for the new render.
      setMediaKey((k) => k + 1)
      await patchLocalStatus(session, remoteUid, 'waiting_vo')
      await patchProject({
        step: 'waiting_vo',
        clipDurationsSec,
        lastRunSeconds: runSeconds(),
        ...(burnedLines ? { captionLines: burnedLines } : {})
      })
      // `waiting_vo` is TERMINAL — a dub project sits here until someone
      // records a voiceover, which may be days, or never. Syncing only in the
      // `highlight` branch meant every dub project's files stayed on the
      // machine that made them for the whole of that wait: opening the account
      // in another browser showed nothing at all, because even `project.json`
      // had never been uploaded (live, production, 2026-09-08).
      syncToServer('render')
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
      //
      // Gated: without `canUseZoomEffects` this made a network round trip on
      // every voiced render for a document nothing here can apply, and when
      // one came back non-empty (a project pulled from the server) it put
      // "กำลังใส่การซูมเดิม…" on screen for a job the engine rejects outright.
      if (canUseZoomEffects) {
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
      }

      setMediaKey((k) => k + 1)
      await patchLocalStatus(session, remoteUid, 'done')
      await patchProject({ step: 'done', lastRunSeconds: runSeconds() })
      syncToServer('final-render')
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

  // ── stage: speech chain (extract audio → server transcribe(+select) → local render) ──
  // talking_head and the two R17 speech modes share this shape end to end; the
  // only forks are the mode sent to the server, the step shown while the LLM
  // picks, and which renderer runs at the end.
  const runTalkingHead = async (): Promise<void> => {
    setError(null)
    setThinking('')
    markRunStarted()
    const runToken = beginRun()
    const speechMode = (projectRef.current.mode ?? 'talking_head') as
      'talking_head' | 'speech_scenes' | 'speech_highlights'
    void window.noey.log.write(
      'useProjectPipeline',
      `runTalkingHead start token=${runToken} mode=${speechMode}`
    )
    setProgressMsg('กำลังเตรียมถอดเสียง…')
    try {
      let current = await patchProject({
        step: 'extracting_audio',
        mode: speechMode,
        error: undefined
      })

      let remoteUid = current.remote?.uid
      if (!remoteUid) {
        const created = await createLocalProject(session, {
          mode: speechMode,
          brief: current.brief || null,
          target_duration_sec: current.targetDurationSec ?? null,
          clips: clipsForApi(current.clips),
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

      // No proxy encode here: every mode on this chain decides its cut from
      // Scribe's word timings, so no video leaves the machine — only WAVs.
      await patchProject({ step: 'transcribing' })
      setProgressMsg('กำลังอัพโหลดไฟล์เสียง…')
      const { job_id } = await uploadAudio(session, remoteUid, project.uid, wavs, {
        styleUid: speechMode === 'speech_scenes' ? projectRef.current.cutStyleUid : undefined
      })
      // Same stop-during-upload hole as runAnalyze -- see the comment there.
      if (isStale(runToken)) {
        cancelRemoteProject(session, remoteUid).catch(() => undefined)
        return
      }
      await patchProject({ remote: { uid: remoteUid, jobId: job_id } })

      abortRef.current = new AbortController()
      let selecting = false
      await pollJob(
        session,
        job_id,
        (status) => {
          const result = status.result ?? {}
          setProgressMsg(String(result.message ?? 'กำลังถอดเสียง…'))
          if (typeof result.thinking === 'string') setThinking(result.thinking)
          else setThinking('')
          // The worker flips its stage to "select" once transcription lands —
          // surface that as the `selecting` step so the pips advance (R17.9).
          if (
            speechMode !== 'talking_head' &&
            !selecting &&
            String(result.step ?? '') === 'select'
          ) {
            selecting = true
            void patchProject({ step: 'selecting' })
          }
        },
        { signal: abortRef.current.signal }
      )

      if (isStale(runToken)) return
      const timeline = await getLocalTimeline(session, remoteUid)
      if (speechMode === 'speech_highlights') {
        await runRenderHighlights(timeline as unknown as HighlightIndex, remoteUid)
      } else {
        await runRenderTimeline(timeline, remoteUid)
      }
    } catch (exc) {
      await handlePipelineError(exc)
    }
  }

  const runRenderHighlights = async (index: HighlightIndex, remoteUid: string): Promise<void> => {
    await patchProject({
      step: 'rendering',
      highlightIndex: stripIndexTimelines(index) as unknown as Record<string, unknown>
    })
    const projectDir = await window.noey.projects.dir(project.uid)
    const unsub = window.noey.sidecar.renderHighlights.onProgress((evt: SidecarEvent) => {
      if (evt.stage === 'highlight') {
        setProgressMsg(
          `กำลังตัดไฮไลต์ ${evt.step}/${evt.total}${evt.message ? ` · ${evt.message}` : ''}…`
        )
      }
    }, projectDir)
    try {
      await window.noey.sidecar.renderHighlights.run({ projectDir, index })
    } finally {
      unsub()
    }
    setMediaKey((k) => k + 1)
    await patchLocalStatus(session, remoteUid, 'done')
    await patchProject({ step: 'done', lastRunSeconds: runSeconds() })
    syncToServer('highlights')
    setProgressMsg('')
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
    setMediaKey((k) => k + 1)
    await patchLocalStatus(session, remoteUid, 'done')
    await patchProject({ step: 'done', lastRunSeconds: runSeconds() })
    dropServerFxBake()
    syncToServer('timeline')
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
      } else if (projectRef.current.mode === 'speech_highlights') {
        const index = await getLocalTimeline(session, remoteUid)
        await runRenderHighlights(index as unknown as HighlightIndex, remoteUid)
      } else {
        const timeline = await getLocalTimeline(session, remoteUid)
        await runRenderTimeline(timeline, remoteUid)
      }
    } catch (exc) {
      await handlePipelineError(exc)
    }
  }

  // Failures here become a visible error, never a silent hang. The body used
  // to run bare: a throw out of runImport or a render resume left the project
  // parked on a busy step with no error text, no retry button and nothing that
  // would ever re-fire the effect -- a permanently spinning card.
  const bootstrapPipeline = async (): Promise<void> => {
    try {
      await bootstrapPipelineInner()
    } catch (exc) {
      await handlePipelineError(exc)
    }
  }

  const bootstrapPipelineInner = async (): Promise<void> => {
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
      if (isSpeechMode(currentMode)) await runTalkingHead()
      else await runAnalyze()
      return
    }

    // Stopped mid-run: user must hit retry — do not auto-restart.
    if (currentStep === 'imported' && current.remote?.uid) return

    // Brand-new project: no remote row yet → start once.
    if (currentStep === 'imported') {
      if (isSpeechMode(currentMode)) await runTalkingHead()
      else await runAnalyze()
      return
    }

    // Remount / HMR while server job still running → resume poll or restart.
    // `selecting` (R17) is the same server job later in its life, so it
    // resumes through the same poll.
    if (
      currentStep === 'analyzing' ||
      currentStep === 'transcribing' ||
      currentStep === 'selecting'
    ) {
      await resumeFromJobPoll(currentStep === 'analyzing' ? 'analyzing' : 'transcribing')
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
      if (currentMode === 'speech_highlights') {
        // The stored index has its render timelines stripped; the server copy
        // is the render input, so a resume re-fetches it whole.
        setProgressMsg('กำลังโหลดแผนไฮไลต์…')
        const index = await getLocalTimeline(session, remoteUid).catch(() => null)
        if (index) await runRenderHighlights(index as unknown as HighlightIndex, remoteUid)
        else await fail(new Error('ไม่พบแผนไฮไลต์บนเซิร์ฟเวอร์ — ลองถอดเสียงใหม่'))
        return
      }
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
      if (isSpeechMode(currentMode)) await runTalkingHead()
      else await runAnalyze()
    }
  }

  const ensurePipeline = useCallback((): void => {
    if (pipelineRef.current) return
    const currentStep = projectRef.current.step as ProjectStep
    if (isTerminal(currentStep)) return
    if (stoppingRef.current) return
    pipelineRef.current = bootstrapPipeline()
      // Belt over the try/catch inside: no future branch may regress into an
      // unobserved rejection.
      .catch((err) => void window.noey.log.write('useProjectPipeline', `bootstrap: ${String(err)}`))
      .finally(() => {
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
    // Also when the local copy HAS a script but no `alternates` in it.
    //
    // The stored script and the server's are not always the same document: one
    // written from the editor's cuts carries no alternates at all, and a
    // project.json that reached this browser from somewhere else can be a
    // degraded copy. The old condition only refilled a script that was
    // MISSING, so a script that was merely stripped stayed stripped — which is
    // how ปรับช็อต read "19 ช็อตมีตัวเลือกอื่น" in one browser and was absent
    // in another on the same project (2026-09-09).
    //
    // Verified against the live server: `getEditScript` does return
    // `alternates` (3 segments, 2 with backups), so the data was there to be
    // had the whole time.
    const localAlternates = countShotsWithAlternates(editScript)
    if (hasEditScript && localAlternates === 0 && (step === 'waiting_vo' || step === 'done')) {
      getEditScript(session, remoteUid)
        .then((script) => {
          // Never downgrade: adopt the server's copy only when it is missing
          // here, or when it actually carries more than what is held.
          if (!editScript) {
            applyEditScript(script)
            return
          }
          const remoteAlternates = countShotsWithAlternates(script)
          if (remoteAlternates > localAlternates) {
            void window.noey.log.write(
              'useProjectPipeline',
              `edit-script refilled from server: ${remoteAlternates} shot(s) with alternates`
            )
            applyEditScript(script)
          }
        })
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
  /**
   * "ลองใหม่" when the AI half already finished and the run died after it.
   *
   * `fail()` overwrites `step` with 'error', so the stage that broke is not
   * recoverable from the project — but the server plan is: if it is there, the
   * transcription and the selection both succeeded and re-running from the top
   * would pay Scribe and Gemini a second time for a result already sitting in
   * S3. That is the whole cost of a speech run. Observed live on a
   * speech_highlights project whose plan was complete and whose only failure
   * was the fetch of it (2026-08-22).
   *
   * Speech modes only. dub_first's plan (edit_script) is followed by TWO
   * renders, and with the failed step erased there is no way to tell a break
   * before the silent render from one after the voiceover — resuming would
   * re-render over finished work.
   *
   * Returns false when there is no usable plan; the caller then starts the run
   * properly.
   */
  const resumeFromServerPlan = async (): Promise<boolean> => {
    const current = projectRef.current
    const remoteUid = current.remote?.uid
    const currentMode: ProjectMode = current.mode ?? 'dub_first'
    if (!remoteUid || !isSpeechMode(currentMode)) return false

    setProgressMsg('กำลังตรวจว่ามีแผนเดิมบนเซิร์ฟเวอร์…')
    const plan = await getLocalTimeline(session, remoteUid).catch(() => null)
    void window.noey.log.write(
      'useProjectPipeline',
      `retry resume uid=${current.uid} mode=${currentMode} plan=${plan ? 'found' : 'none'}`
    )
    if (!plan) return false

    if (currentMode === 'speech_highlights') {
      await runRenderHighlights(plan as unknown as HighlightIndex, remoteUid)
    } else {
      await runRenderTimeline(plan as DubTimeline, remoteUid)
    }
    return true
  }

  const retry = async (): Promise<void> => {
    if (pipelineRef.current) return
    void window.noey.log.write('useProjectPipeline', `retry uid=${project.uid} step=${step}`)
    setError(null)
    const run = (async () => {
      // When the IMPORT is what failed (a dropped transcode download, a closed
      // tab mid-copy) the project has pendingSources and no clips — stamping
      // it 'imported' anyway sent the create call `clips: []`, the server
      // answered 422, and every further retry re-sent the same empty list
      // ("กดลองใหม่ก็ไม่ได้", live 2026-09-09). The sources are still staged in
      // OPFS, so the honest retry is to run the import again.
      const cur0 = projectRef.current
      const needsImport = (cur0.pendingSources?.length ?? 0) > 0 || (cur0.clips?.length ?? 0) === 0
      await patchProject({ step: needsImport ? 'importing' : 'imported', error: undefined })
      if (needsImport) {
        if (!(await runImport())) return
      }
      if (await resumeFromServerPlan()) return
      // Dub modes resume from what already exists before ever re-buying the
      // cut: a planned timeline + recorded voiceover re-renders the final for
      // free, and a stored edit script re-renders the silent cut for free.
      // retry() used to go straight to runAnalyze, which billed a second cut
      // and overwrote the approved script the voiceover was recorded against.
      if (!isSpeechMode(mode)) {
        const cur = projectRef.current
        const storedScript = cur.editScript as unknown as DubEditScript | undefined
        if (cur.voiceoverPath && cur.timeline && cur.remote?.uid) {
          await renderFinalFromPlannedTimeline(cur.timeline as unknown as DubTimeline)
          return
        }
        if (storedScript?.segments?.length && cur.remote?.uid) {
          await runRenderSilent(storedScript, cur.remote.uid)
          return
        }
      }
      if (isSpeechMode(mode)) await runTalkingHead()
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
    // Every speech mode cuts from the transcript — recut would re-run the
    // VIDEO analyze chain on them (happened live 2026-09-07 on a
    // speech_scenes project via the card menu, whose guard predated R17).
    if (!note || pipelineRef.current || isSpeechMode(mode)) return
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
      // A restored project has no render artifacts in this browser, so the
      // stash keeps NOTHING. Writing previousRender anyway offered a
      // "ย้อนกลับ" that restored no video while patching the script back --
      // video and script then permanently described different cuts.
      await patchProject({
        recutNotes: [...notes, { round, text: note, at: new Date().toISOString() }],
        previousRender:
          files.length === 0
            ? undefined
            : {
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
      // R18b taste log: the recut comment is taste data too — same file the
      // shot swaps land in, distilled later by R19 (never fed to a prompt now).
      void window.noey.taste.append({
        type: 'recut_note',
        projectUid: project.uid,
        mode,
        round,
        text: note
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
    setMediaKey((k) => k + 1)
    const restored = await patchProject({
      previousRender: undefined,
      editScript: kept.editScript,
      clipDurationsSec: kept.clipDurationsSec,
      timeline: kept.timeline,
      captionLines: kept.captionLines,
      error: undefined
    })
    if (kept.fromShotSwap) {
      void window.noey.taste.append({ type: 'shot_swap_revert', projectUid: project.uid, mode })
    }
    setEditScript((restored.editScript as unknown as DubEditScript | undefined) ?? null)
    setMediaKey((k) => k + 1)
    // The server still holds the render the user just discarded, and its
    // clips were already swept when the new cut synced. The size diff
    // re-uploads the restored files and sweeps the reverted ones.
    syncToServer('revert')
  }

  /**
   * Final (voiced) render straight from an existing planned timeline — no
   * planDub call. Used by R18b's locked swap regime: every durationSec is
   * unchanged there, so the stored plan stays valid and re-planning would
   * spend an AI call for nothing (the whole swap flow must stay at zero).
   */
  const renderFinalFromPlannedTimeline = async (timeline: DubTimeline): Promise<void> => {
    const voiceoverPath = live().voiceoverPath
    if (!voiceoverPath) throw new Error('ไม่พบไฟล์เสียงพากย์เดิม')
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
    }, projectDir)
    let finalClipDurations: number[] | undefined
    try {
      const doneFinal = await window.noey.sidecar.renderFinal.run({
        projectDir,
        timeline,
        voiceoverPath,
        ...captionJobFields(
          finalCaptionLinesFor(
            timeline,
            (live().editScript as unknown as DubEditScript | undefined) ?? editScript
          )
        ),
        ...(await musicJobFields())
      })
      finalClipDurations = (doneFinal as { clipDurationsSec?: number[] }).clipDurationsSec
    } finally {
      unsub()
    }
    const remoteUid = live().remote?.uid
    if (remoteUid) await patchLocalStatus(session, remoteUid, 'done').catch(() => undefined)
    await patchProject({
      step: 'done',
      lastRunSeconds: runSeconds(),
      ...(finalClipDurations?.length ? { clipDurationsSec: finalClipDurations } : {})
    })
    setMediaKey((k) => k + 1)
    dropServerFxBake()
    syncToServer('re-render')
    setProgressMsg('')
  }

  /**
   * R18b ปรับช็อต — apply a shot-swapped edit script and reassemble locally.
   *
   * Reuses R12's previousRender mechanism VERBATIM (whole snapshot, old stash
   * deleted first by stashRender) and the existing render paths; nothing here
   * calls a model. Free regime (no VO yet / highlight) re-runs the silent
   * render on the new windows; locked regime (VO recorded) additionally
   * re-points the planned timeline's cuts mechanically and re-renders the
   * voiced final with the SAME voiceover file — possible only because the
   * locked length rule kept every durationSec identical.
   */
  const applyShotSwap = async (
    patchedScript: DubEditScript,
    swapLog: ShotSwapLogEntry[] = []
  ): Promise<void> => {
    if (pipelineRef.current) return
    const run = (async () => {
      setError(null)
      setThinking('')
      markRunStarted()
      void window.noey.log.write(
        'useProjectPipeline',
        `applyShotSwap uid=${project.uid} swaps=${swapLog.length}`
      )
      try {
        const current = live()
        const remoteUid = current.remote?.uid
        if (!remoteUid) throw new Error('ไม่พบ remote project')
        const oldSegments = ((current.editScript as unknown as DubEditScript | undefined)
          ?.segments ??
          editScript?.segments ??
          []) as Record<string, unknown>[]
        const locked = mode === 'dub_first' && !!current.voiceoverPath && !!current.timeline

        // Keep this version the way recut does — one spare, old stash replaced.
        const files = await window.noey.projects.stashRender(project.uid)
        // The files the mounted <video> is streaming just moved to the stash —
        // re-key it now, not when the new render lands.
        setMediaKey((k) => k + 1)
        // Same guard as recut: no artifacts kept -> no undo offered.
        await patchProject({
          previousRender:
            files.length === 0
              ? undefined
              : {
                  round: current.recutNotes?.at(-1)?.round ?? 1,
                  at: current.updatedAt,
                  files,
                  editScript: current.editScript,
                  clipDurationsSec: current.clipDurationsSec,
                  timeline: current.timeline,
                  captionLines: current.captionLines,
                  fromShotSwap: true
                },
          // Free regime: durations moved, so saved caption lines describe the
          // old clock — clear them and let the render re-derive from the new
          // script (dubScenesFor reads editScript live; never cache old times).
          ...(locked ? {} : { captionLines: undefined }),
          error: undefined
        })

        applyEditScript(patchedScript)
        await putLocalEditScript(session, remoteUid, patchedScript)

        // Taste log at COMMIT only — exploratory clicks in the tray are not
        // taste; pressing ประกอบใหม่ is (HANDOFF-R18b §7).
        for (const entry of swapLog) {
          void window.noey.taste.append({
            type: 'shot_swap',
            projectUid: project.uid,
            mode,
            ...entry
          })
        }

        if (locked) {
          const patchedTimeline = retimeTimelineForSwap(
            oldSegments,
            patchedScript.segments,
            current.timeline as unknown as DubTimeline
          )
          await putLocalTimeline(session, remoteUid, patchedTimeline).catch(() => undefined)
          await runRenderSilent(patchedScript, remoteUid, { continueToFinal: true })
          await renderFinalFromPlannedTimeline(patchedTimeline) // → done, same VO
        } else {
          await runRenderSilent(patchedScript, remoteUid) // waiting_vo, or done (highlight)
        }
      } catch (exc) {
        await handlePipelineError(exc)
      }
    })()
    pipelineRef.current = run.finally(() => {
      pipelineRef.current = null
    })
    await pipelineRef.current
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
      // `captionLinesBase` marks the clock these lines are on. Lines written
      // before 2026-09-07 carry no marker and are on the SOURCE clock, which
      // the burn-in reads as output time — openEditor drops unmarked lines
      // rather than re-hydrating a mis-timed edit.
      ...(captionLines ? { captionLines, captionLinesBase: 'output' as const } : {})
    }
    await putLocalTimeline(session, remoteUid, timeline).catch(() => undefined)
    // A draft is only ever a fallback for work not yet rendered, so it must
    // never win over a render that started after it: pressing Save while a
    // debounced draft was mid-flight let the draft's post-round-trip write land
    // last and put the pre-render timeline back on the project.
    if (isBusy(projectRef.current.step as ProjectStep)) return
    await patchProject({ timeline })
  }

  const saveEditedCutsInner = async (
    cuts: SaveCutPayload[],
    target: 'edit_script' | 'timeline',
    captionLines?: CaptionLine[]
  ): Promise<void> => {
    const remoteUid = live().remote?.uid
    if (!remoteUid) throw new Error('ไม่พบ remote project')
    // Every other render entry point resets the run clock; without this the
    // ETA and the persisted "ใช้เวลาทำ" reported the PREVIOUS run's elapsed
    // time for a save re-render.
    markRunStarted()
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
        // `captionLinesBase` marks the clock these lines are on. Lines written
        // before 2026-09-07 carry no marker and are on the SOURCE clock, which
        // the burn-in reads as output time — openEditor drops unmarked lines
        // rather than re-hydrating a mis-timed edit.
        ...(captionLines ? { captionLines, captionLinesBase: 'output' as const } : {})
      }
      // Every mode that keeps the ORIGINAL audio renders through the timeline
      // path. This used to name talking_head alone, from before R17 added the
      // speech modes — so saving an edit on a speech_scenes project fell
      // through to the voiceover branch below and threw
      // "ไม่พบไฟล์เสียงพากย์เดิม" every single time, on a mode that has no
      // voiceover by definition. (speech_highlights cannot reach here: it
      // renders one file per highlight and the detail page refuses to open the
      // editor for it.)
      if (mode === 'talking_head' || mode === 'speech_scenes') {
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
      dropServerFxBake()
      syncToServer('reassemble')
      setProgressMsg('')
    }
  }

  /**
   * The editor's Save — the only render entry point that used to skip
   * `pipelineRef`.
   *
   * Every other one (`retry`, `recut`, `applyShotSwap`, `runFinalWithAudio`)
   * claims the ref for its whole duration, because `saveEditedCutsInner`
   * patches the project to a BUSY step and the effect that watches for a busy
   * step calls `ensurePipeline()` — which short-circuits on
   * `if (pipelineRef.current) return` and does nothing else to tell whether a
   * render is already running. With the ref left null, that effect fired
   * mid-save and started a SECOND pipeline on the same project:
   *
   *   post-VO dub  — bootstrapPipeline falls through to
   *                  `resumeStep('final_rendering')` = 'waiting_vo' and patches
   *                  the step BACKWARDS while renderFinal is still running. The
   *                  job host sees busy -> terminal and announces
   *                  "ตัดคลิปเสร็จแล้ว" before anything has been written.
   *   pre-VO / talking_head — bootstrapPipeline re-fetches the script and runs
   *                  the whole render a second time. `withProjectLock` in
   *                  main/sidecar.ts serializes them, so the duplicate lands
   *                  AFTER the first finished: it wipes clips/ and os.replace()s
   *                  the output under a <video> that is already playing it.
   *
   * Both read to the owner as one bug: "บันทึกแล้ววีดีโอไม่เปลี่ยน" and a clip
   * that only settles down "ต้องรอสักพักนึง" (2026-09-07).
   *
   * Throws rather than returning silently when something else is rendering:
   * `TimelineEditor.handleSave` treats a resolved promise as "rendered" and
   * closes the editor, so a swallowed save would look exactly like a
   * successful one.
   */
  const saveEditedCuts = async (
    cuts: SaveCutPayload[],
    target: 'edit_script' | 'timeline',
    captionLines?: CaptionLine[]
  ): Promise<void> => {
    if (pipelineRef.current) throw new Error('มีงานเรนเดอร์ค้างอยู่ รอให้เสร็จก่อนแล้วลองใหม่')
    const run = saveEditedCutsInner(cuts, target, captionLines)
    pipelineRef.current = run.finally(() => {
      pipelineRef.current = null
    })
    await pipelineRef.current
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
    //
    // talking_head's words are SOURCE timestamps, absolute across every clip
    // laid end to end, and they are remapped onto the output clock here before
    // they are grouped. They used to be grouped as-is and carried through the
    // editor on the source clock, but `build_ass_captions` documents its
    // `caption_lines` as output time and burns them verbatim — so on a 60 s
    // source cut down to 25 s of speech, a line at source 40–42 s was burned at
    // output 40–42 s, past the end of the clip, and simply never appeared. Any
    // save from the editor wrote that, a pure trim included, and the stored
    // lines then beat the correct auto-grouping on every later render
    // (2026-09-07). One clock now — the output one — end to end.
    const savedCaptionLines = timeline?.captionLines as CaptionLine[] | undefined
    // Lines saved BEFORE that fix are on the source clock and are unusable;
    // there is no marker on them, so the marker is what a good one carries.
    // Without it the lines are re-derived, which loses nothing: they were being
    // burned in the wrong place anyway.
    const savedLinesUsable =
      savedCaptionLines && (mode !== 'talking_head' || timeline?.captionLinesBase === 'output')
        ? savedCaptionLines
        : undefined
    const timelineCuts = ((timeline?.timeline ?? []) as { type?: string }[]).filter(
      (c) => c.type === 'cut'
    ) as unknown as EditCut[]
    const captionLines = !project.captionStyle
      ? undefined
      : mode === 'talking_head'
        ? (savedLinesUsable ??
          groupWordsIntoLines(
            remapWordsToOutput(
              (timeline?.words as TimedWord[] | undefined) ?? [],
              timelineCuts,
              clipAbsOffsets(project.clips.map((c) => c.durationSec))
            )
          ))
        : (savedLinesUsable ??
          (project.captionLines as CaptionLine[] | undefined) ??
          dubCaptionLines(dubScenesFor(editScript)))
    configureEditorApi({
      localUid: project.uid,
      clips: project.clips,
      editTarget: target,
      editScript,
      timeline,
      captionLines,
      // Both modes are on the OUTPUT clock now: dubCaptionLines always laid the
      // spoken lines along the cut, and talking_head's words are remapped above
      // instead of being grouped on the source clock.
      captionTimeBase: 'output',
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
    applyShotSwap,
    // For screens that change files OUTSIDE a render -- the voiceover page's
    // takes above all. waiting_vo is terminal, so without an explicit sync an
    // evening of recording existed in exactly one browser.
    syncFiles: (why: string) => syncToServer(why),
    updateScriptLine: async (lineId, text) => {
      // Text only: the cut, the timing and the render are untouched, so this
      // never queues a job — it rewrites the line in the edit script, persists
      // it, and pushes the server's copy so every other browser reads the same
      // words. A line's text lives on EVERY segment cut for that line.
      const current =
        (projectRef.current.editScript as unknown as DubEditScript | undefined) ??
        editScript ??
        null
      if (!current?.segments) return
      const next: DubEditScript = {
        ...current,
        segments: current.segments.map((s) => {
          const seg = s as Record<string, unknown>
          const sid = Number(seg.voiceoverLineId ?? seg.order)
          return sid === lineId ? { ...seg, voiceoverScript: text } : s
        })
      }
      applyEditScript(next)
      const remoteUid = projectRef.current.remote?.uid
      if (remoteUid) {
        await putLocalEditScript(session, remoteUid, next).catch((err) =>
          window.noey.log.write('useProjectPipeline', `script edit push failed: ${String(err)}`)
        )
      }
    },
    stop,
    stopping,
    openEditor
  }
}
