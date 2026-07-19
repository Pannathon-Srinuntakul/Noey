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
import { groupWordsIntoLines } from './captionLines'
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
  pickMusic: () => Promise<LocalProject['music'] | undefined>
  updateMusic: (patch: Partial<NonNullable<LocalProject['music']>>) => Promise<void>
  removeMusic: () => Promise<void>
  retry: () => Promise<void>
  stop: () => Promise<void>
  stopping: boolean
  openEditor: () => void
}

export function useProjectPipeline(initial: LocalProject, session: ApiSession): ProjectPipeline {
  const [project, setProject] = useState<LocalProject>(initial)
  const [progressMsg, setProgressMsg] = useState('')
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
  const stoppingRef = useRef(false)
  const disposedRef = useRef(false)
  const pipelineRef = useRef<Promise<void> | null>(null)
  const projectRef = useRef(initial)

  const step = project.step as ProjectStep
  const mode: ProjectMode = project.mode ?? 'dub_first'

  projectRef.current = project
  stoppingRef.current = stopping

  // Merge disk state when the registry is newer — never roll back a step the
  // in-memory pipeline has already advanced (parent list is not patched on
  // every patchProject).
  useEffect(() => {
    setProject((prev) => {
      if (initial.uid !== prev.uid) return initial
      if (initial.updatedAt >= prev.updatedAt) return { ...prev, ...initial }
      return prev
    })
  }, [initial.uid, initial.updatedAt, initial])

  useEffect(() => {
    return () => {
      disposedRef.current = true
      abortRef.current?.abort()
    }
  }, [])

  // dub_first final render only: extra sidecar job fields for the attached
  // background music track (see TimelineEditor's audio track for editing).
  // Omitted entirely when no music is attached — old VO-only mux, unchanged.
  // The sidecar is a plain local process, so it gets the resolved absolute
  // path (project.music.path itself is project-relative, for media:// use).
  const musicJobFields = async (
    p: LocalProject
  ): Promise<{ musicPath?: string; musicVolume?: number; musicOffsetSec?: number; musicTrimInSec?: number }> => {
    if (!p.music) return {}
    const musicPath = await window.noey.projects.resolvePath(p.uid, p.music.path)
    return {
      musicPath,
      musicVolume: p.music.muted ? 0 : p.music.volume,
      musicOffsetSec: p.music.offsetSec,
      musicTrimInSec: p.music.trimInSec
    }
  }

  const patchProject = async (patch: Partial<LocalProject>): Promise<LocalProject> => {
    const updated = await window.noey.projects.update(project.uid, patch)
    setProject(updated)
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
    setProgressMsg('')
    setThinking('')
    setStopping(false)
    stoppedRef.current = false
    abortRef.current = null
    await patchProject({
      step: 'imported',
      error: undefined,
      remote: remoteUid ? { uid: remoteUid } : undefined
    })
  }

  const isStopError = (exc: unknown): boolean =>
    stoppedRef.current ||
    (exc instanceof ApiError &&
      (exc.detail === 'ยกเลิกแล้ว' || /cancel/i.test(exc.detail)))

  const handlePipelineError = async (exc: unknown): Promise<void> => {
    if (disposedRef.current) return
    if (isStopError(exc)) {
      await resetAfterStop()
      return
    }
    setStopping(false)
    stoppedRef.current = false
    await fail(exc)
  }

  const stop = async (): Promise<void> => {
    if (stopping || !isBusy(step)) return
    void window.noey.log.write('useProjectPipeline', `stop: start uid=${project.uid} step=${step}`)
    setStopping(true)
    stoppedRef.current = true
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
      void window.noey.log.write('useProjectPipeline', `stop: cancel step failed/timed out: ${String(err)}`)
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
    setError(message)
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
    const unsub = window.noey.sidecar.mixMusic.onProgress((evt: SidecarEvent) => {
      setProgressMsg(evt.stage === 'music' ? 'กำลังใส่เพลงประกอบ…' : 'กำลังอัพเดต bundle…')
      void window.noey.log.write('useProjectPipeline', `mixMusic progress: ${JSON.stringify(evt)}`)
    })
    try {
      const projectDir = await window.noey.projects.dir(project.uid)
      const musicPath = music ? await window.noey.projects.resolvePath(project.uid, music.path) : null
      const done = await window.noey.sidecar.mixMusic.run({
        projectDir,
        musicPath,
        musicVolume: music ? (music.muted ? 0 : music.volume) : 0.25,
        musicOffsetSec: music?.offsetSec ?? 0,
        musicTrimInSec: music?.trimInSec ?? 0
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
    if (!picked) return project.music
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

  const updateMusic = async (patch: Partial<NonNullable<LocalProject['music']>>): Promise<void> => {
    if (!project.music) return
    const music = { ...project.music, ...patch }
    await patchProject({ music })
    await remixMusicOntoSilent(music)
  }

  const removeMusic = async (): Promise<void> => {
    await patchProject({ music: undefined })
    await remixMusicOntoSilent(undefined)
    const remoteUid = project.remote?.uid
    if (remoteUid) deleteMusic(session, remoteUid).catch(() => undefined)
  }

  // ── stage: analyze (frames → upload → LLM → edit script → silent render) ──
  const runAnalyze = async (): Promise<void> => {
    setError(null)
    setThinking('')
    stoppedRef.current = false
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

      if (current.music?.path) {
        setProgressMsg('กำลังวิเคราะห์จังหวะเพลง…')
        try {
          const absMusicPath = await window.noey.projects.resolvePath(project.uid, current.music.path)
          const beats = await uploadMusic(session, remoteUid, absMusicPath)
          current = await patchProject({
            music: current.music ? { ...current.music, beats: beats.beats } : current.music
          })
        } catch (err) {
          // Non-fatal: cut analysis still works without beat data.
          void window.noey.log.write('useProjectPipeline', `uploadMusic failed: ${String(err)}`)
        }
        if (stoppedRef.current) return
      }

      setProgressMsg('กำลังย่อวิดีโอให้ AI…')
      const projectDir = await window.noey.projects.dir(project.uid)
      const unsub = window.noey.sidecar.extractProxy.onProgress((evt: SidecarEvent) => {
        setProgressMsg(`กำลังย่อวิดีโอให้ AI ${evt.step}/${evt.total}…`)
      })
      try {
        await window.noey.sidecar.extractProxy.run({ projectDir })
      } finally {
        unsub()
      }
      if (stoppedRef.current) return

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
      const { job_id } = await analyzeVideo(session, remoteUid, project.uid, proxies)
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
              : evt.stage === 'bundle'
                ? 'กำลังสร้าง bundle…'
                : `กำลังทำ (${String(evt.stage)})…`
      setProgressMsg(msg)
      void window.noey.log.write('useProjectPipeline', `renderSilent progress: ${JSON.stringify(evt)}`)
    })
    let clipDurationsSec: number[] | undefined
    try {
      const done = await window.noey.sidecar.renderSilent.run({
        projectDir,
        editScript: script,
        brief: project.brief || null,
        ...(await musicJobFields(project))
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
    if (mode === 'highlight') {
      // No voiceover step at all — the silent cut IS the final output,
      // mirrors talking_head's runRenderTimeline going straight to done.
      await patchLocalStatus(session, remoteUid, 'done')
      await patchProject({ step: 'done', clipDurationsSec })
    } else {
      await patchLocalStatus(session, remoteUid, 'waiting_vo')
      await patchProject({ step: 'waiting_vo', clipDurationsSec })
    }
    setMediaKey((k) => k + 1)
    setProgressMsg('')
  }

  // ── stage: voiceover → plan → final render ───────────────────────────────
  const runFinal = async (): Promise<void> => {
    setError(null)
    const picked = await pickFile('audio/*')
    if (!picked) return
    try {
      const remoteUid = project.remote?.uid
      if (!remoteUid) throw new Error('ไม่พบ remote project')

      const probe = await window.noey.sidecar.probe(picked.path)
      const voDuration = Number(probe.duration)
      if (!voDuration || voDuration <= 0) throw new Error('อ่านความยาวไฟล์เสียงไม่ได้')

      await patchProject({ step: 'planning', voiceoverPath: picked.path })
      setProgressMsg('AI กำลังวางแผน timeline ตามเสียงพากย์…')
      const timeline = await planDub(
        session,
        remoteUid,
        voDuration,
        project.clips.map((c) => c.durationSec)
      )

      await patchProject({ step: 'final_rendering', timeline })
      const projectDir = await window.noey.projects.dir(project.uid)
      const unsub = window.noey.sidecar.renderFinal.onProgress((evt: SidecarEvent) => {
        setProgressMsg(
          evt.stage === 'cut'
            ? `กำลังตัดช่วงที่ ${evt.step}/${evt.total}…`
            : evt.stage === 'mux'
              ? project.music
                ? 'กำลังใส่เสียงพากย์ + เพลงประกอบ…'
                : 'กำลังใส่เสียงพากย์…'
              : evt.stage === 'concat'
                ? 'กำลังรวมคลิป…'
                : evt.stage === 'bundle'
                  ? 'กำลังสร้าง bundle…'
                  : `กำลังทำ (${String(evt.stage)})…`
        )
        void window.noey.log.write('useProjectPipeline', `renderFinal progress: ${JSON.stringify(evt)}`)
      })
      try {
        await window.noey.sidecar.renderFinal.run({
          projectDir,
          timeline,
          voiceoverPath: picked.path,
          ...(await musicJobFields(project))
        })
      } finally {
        unsub()
      }

      // Effects placed while waiting for the VO (on final_silent.mp4) carry
      // over: same cuts → same timing, so re-composite the stored effects.json
      // onto the voiced final.mp4 automatically.
      try {
        const { getEffectsDoc } = await import('./effectsLocalApi')
        const { renderEffectsDoc } = await import('./effectsPipeline')
        const fxDoc = await getEffectsDoc(session, remoteUid)
        if (fxDoc.instances.length > 0) {
          setProgressMsg('กำลังใส่เอฟเฟกต์เดิมลงวิดีโอที่มีเสียง…')
          await renderEffectsDoc(
            {
              session,
              localUid: project.uid,
              remoteUid,
              baseFile: 'final.mp4',
              project,
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
      await patchProject({ step: 'done' })
      setMediaKey((k) => k + 1)
      setProgressMsg('')
    } catch (exc) {
      await handlePipelineError(exc)
    }
  }

  // ── stage: talking_head (extract audio → server transcribe+plan → local render) ──
  const runTalkingHead = async (): Promise<void> => {
    setError(null)
    setThinking('')
    stoppedRef.current = false
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
      })
      let wavs: { file: string; name: string }[]
      try {
        const done = await window.noey.sidecar.extractAudio.run({ projectDir })
        wavs = done.wavs as { file: string; name: string }[]
      } finally {
        unsubAudio()
      }
      if (stoppedRef.current) return

      // Downscaled proxy clips
      let proxyVideos: { file: string; name: string }[] | undefined
      try {
        setProgressMsg('กำลังย่อวิดีโอให้ AI ตรวจสอบ…')
        const unsubProxy = window.noey.sidecar.extractProxy.onProgress((evt: SidecarEvent) => {
          setProgressMsg(`กำลังย่อวิดีโอให้ AI ตรวจสอบ ${evt.step}/${evt.total}…`)
        })
        try {
          await window.noey.sidecar.extractProxy.run({ projectDir, keepAudio: true })
        } finally {
          unsubProxy()
        }
        const manifestUrl = window.noey.media.urlFor(project.uid, 'proxy/proxy_manifest.json')
        const proxies = (await (await fetch(manifestUrl)).json()) as ProxyManifestEntry[]
        proxyVideos = proxies.map((e) => ({ file: `proxy/${e.file}`, name: e.file }))
      } catch (err) {
        void window.noey.log.write('useProjectPipeline', `proxy extract failed: ${String(err)}`)
      }
      if (stoppedRef.current) return

      await patchProject({ step: 'transcribing' })
      setProgressMsg('กำลังอัพโหลดไฟล์เสียง…')
      const { job_id } = await uploadAudio(session, remoteUid, project.uid, wavs, proxyVideos)
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
            : 'กำลังสร้าง CapCut bundle…'
      )
    })
    try {
      await window.noey.sidecar.renderTimeline.run({ projectDir, timeline })
    } finally {
      unsub()
    }
    await patchLocalStatus(session, remoteUid, 'done')
    await patchProject({ step: 'done' })
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

    setProgressMsg(kind === 'analyzing' ? 'กำลังเชื่อมต่อ job วิเคราะห์…' : 'กำลังเชื่อมต่อ job ถอดเสียง…')
    setError(null)
    setThinking('')
    stoppedRef.current = false
    abortRef.current = new AbortController()
    try {
      await pollJob(
        session,
        jobId,
        (status) => {
          const result = status.result ?? {}
          setProgressMsg(
            String(
              result.message ??
                (kind === 'analyzing' ? 'กำลังวิเคราะห์…' : 'กำลังถอดเสียง…')
            )
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

    if (isTerminal(currentStep)) return

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

  const retry = async (): Promise<void> => {
    setError(null)
    await patchProject({ step: 'imported', error: undefined })
    if (mode === 'talking_head') await runTalkingHead()
    else await runAnalyze()
  }

  const saveEditedCuts = async (
    cuts: SaveCutPayload[],
    target: 'edit_script' | 'timeline',
    captionLines?: CaptionLine[]
  ): Promise<void> => {
    const remoteUid = project.remote?.uid
    if (!remoteUid) throw new Error('ไม่พบ remote project')
    if (target === 'edit_script') {
      const es = editScriptFromCuts(cuts)
      applyEditScript(es)
      await putLocalEditScript(session, remoteUid, es)
      await runRenderSilent(es, remoteUid)
    } else {
      const base = (project.timeline ?? {}) as DubTimeline
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
      if (mode === 'talking_head') {
        await putLocalTimeline(session, remoteUid, timeline).catch(() => undefined)
        await runRenderTimeline(timeline, remoteUid)
        return
      }
      if (!project.voiceoverPath) throw new Error('ไม่พบไฟล์เสียงพากย์เดิม')
      await patchProject({ step: 'final_rendering', timeline })
      const projectDir = await window.noey.projects.dir(project.uid)
      const unsub = window.noey.sidecar.renderFinal.onProgress((evt: SidecarEvent) => {
        setProgressMsg(
          evt.stage === 'cut'
            ? `กำลังตัดช่วงที่ ${evt.step}/${evt.total}…`
            : evt.stage === 'mux'
              ? project.music
                ? 'กำลังใส่เสียงพากย์ + เพลงประกอบ…'
                : 'กำลังใส่เสียงพากย์…'
              : 'กำลังประกอบวิดีโอ…'
        )
        void window.noey.log.write('useProjectPipeline', `renderFinal progress: ${JSON.stringify(evt)}`)
      })
      try {
        await window.noey.sidecar.renderFinal.run({
          projectDir,
          timeline,
          voiceoverPath: project.voiceoverPath,
          ...(await musicJobFields(project))
        })
      } finally {
        unsub()
      }
      await patchLocalStatus(session, remoteUid, 'done')
      await patchProject({ step: 'done' })
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
    const { job_id } = await reeditDubScenes(session, remoteUid, previewPath, {
      selectedLineIds,
      instruction
    })
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
    // Captions only apply to talking_head. Prefer a previously-saved edit
    // (`captionLines`); otherwise derive an initial line grouping from the
    // raw AI word timestamps so there's something to edit on first open.
    const captionLines =
      mode === 'talking_head' && timeline?.captionStyle
        ? ((timeline.captionLines as CaptionLine[] | undefined) ??
          groupWordsIntoLines(
            (timeline.words as { word: string; start: number; end: number }[]) ?? []
          ))
        : undefined
    configureEditorApi({
      localUid: project.uid,
      clips: project.clips,
      editTarget: target,
      editScript,
      timeline,
      captionLines,
      music: mode === 'dub_first' || mode === 'highlight' ? project.music : undefined,
      onMusicChange: mode === 'dub_first' || mode === 'highlight' ? updateMusic : undefined,
      onPickMusic: mode === 'dub_first' || mode === 'highlight' ? pickMusic : undefined,
      onRemoveMusic: mode === 'dub_first' || mode === 'highlight' ? removeMusic : undefined,
      onSave: (cuts, lines) => saveEditedCuts(cuts, target, lines),
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
    pickMusic,
    updateMusic,
    removeMusic,
    retry,
    stop,
    stopping,
    openEditor
  }
}
