import { useEffect, useRef, useState } from 'react'
import type { LocalProject, SidecarEvent } from '../../../preload'
import { ApiError } from './api'
import {
  analyzeVideo,
  createLocalProject,
  getEditScript,
  getLocalTimeline,
  patchLocalStatus,
  planDub,
  pollJob,
  putLocalEditScript,
  putLocalTimeline,
  uploadAudio,
  type ApiSession,
  type DubEditScript,
  type DubTimeline,
  type ProxyManifestEntry
} from './videosLocalApi'
import { configureEditorApi, editScriptFromCuts, type SaveCutPayload } from './editorApi'
import { pickFile } from './pickFile'
import type { ProjectMode, ProjectStep } from './projectFlow'

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
  retry: () => Promise<void>
  openEditor: () => void
}

export function useProjectPipeline(initial: LocalProject, session: ApiSession): ProjectPipeline {
  const [project, setProject] = useState<LocalProject>(initial)
  const [progressMsg, setProgressMsg] = useState('')
  const [thinking, setThinking] = useState('')
  const [editScript, setEditScript] = useState<DubEditScript | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mediaKey, setMediaKey] = useState(0)
  const [showEditor, setShowEditor] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const step = project.step as ProjectStep
  const mode: ProjectMode = project.mode ?? 'dub_first'

  const patchProject = async (patch: Partial<LocalProject>): Promise<LocalProject> => {
    const updated = await window.noey.projects.update(project.uid, patch)
    setProject(updated)
    return updated
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

  // ── stage: analyze (frames → upload → LLM → edit script → silent render) ──
  const runAnalyze = async (): Promise<void> => {
    setError(null)
    setThinking('')
    try {
      let current = await patchProject({ step: 'analyzing', error: undefined })

      let remoteUid = current.remote?.uid
      if (!remoteUid) {
        const created = await createLocalProject(session, {
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
        },
        { signal: abortRef.current.signal }
      )

      const script = await getEditScript(session, remoteUid)
      setEditScript(script)
      await runRenderSilent(script, remoteUid)
    } catch (exc) {
      await fail(exc)
    }
  }

  // ── stage: silent render ──────────────────────────────────────────────────
  const runRenderSilent = async (script: DubEditScript, remoteUid: string): Promise<void> => {
    await patchProject({ step: 'silent_rendering' })
    const projectDir = await window.noey.projects.dir(project.uid)
    const unsub = window.noey.sidecar.renderSilent.onProgress((evt: SidecarEvent) => {
      setProgressMsg(
        evt.stage === 'cut'
          ? `กำลังตัดซีนที่ ${evt.step}/${evt.total}…`
          : evt.stage === 'concat'
            ? 'กำลังรวมคลิป…'
            : 'กำลังสร้าง bundle…'
      )
    })
    try {
      await window.noey.sidecar.renderSilent.run({
        projectDir,
        editScript: script,
        brief: project.brief || null
      })
    } finally {
      unsub()
    }
    await patchLocalStatus(session, remoteUid, 'waiting_vo')
    await patchProject({ step: 'waiting_vo' })
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
              ? 'กำลังใส่เสียงพากย์…'
              : 'กำลังรวมคลิป…'
        )
      })
      try {
        await window.noey.sidecar.renderFinal.run({
          projectDir,
          timeline,
          voiceoverPath: picked.path
        })
      } finally {
        unsub()
      }

      await patchLocalStatus(session, remoteUid, 'done')
      await patchProject({ step: 'done' })
      setMediaKey((k) => k + 1)
      setProgressMsg('')
    } catch (exc) {
      await fail(exc)
    }
  }

  // ── stage: talking_head (extract audio → server transcribe+plan → local render) ──
  const runTalkingHead = async (): Promise<void> => {
    setError(null)
    setThinking('')
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
          }))
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

      // Downscaled proxy clips (WITH audio) so Gemini can watch+listen to each
      // clip during review — only the small proxy ever leaves the device, never
      // the original footage. Best-effort: an encode failure here shouldn't block
      // transcription, it just falls back to code-only cuts for that clip.
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
        },
        { signal: abortRef.current.signal }
      )

      const timeline = await getLocalTimeline(session, remoteUid)
      await runRenderTimeline(timeline, remoteUid)
    } catch (exc) {
      await fail(exc)
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

  // Resume: reload edit script / timeline when reopening at review steps.
  useEffect(() => {
    const remoteUid = project.remote?.uid
    if (!remoteUid) return
    if (mode === 'dub_first' && !editScript && (step === 'waiting_vo' || step === 'done')) {
      getEditScript(session, remoteUid)
        .then(setEditScript)
        .catch(() => undefined)
    }
    if (mode === 'talking_head' && !project.timeline && (step === 'rendering' || step === 'done')) {
      getLocalTimeline(session, remoteUid)
        .then((tl) => patchProject({ timeline: tl }))
        .catch(() => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  const retry = async (): Promise<void> => {
    setError(null)
    await patchProject({ step: 'imported', error: undefined })
    if (mode === 'talking_head') await runTalkingHead()
    else await runAnalyze()
  }

  const saveEditedCuts = async (
    cuts: SaveCutPayload[],
    target: 'edit_script' | 'timeline'
  ): Promise<void> => {
    const remoteUid = project.remote?.uid
    if (!remoteUid) throw new Error('ไม่พบ remote project')
    if (target === 'edit_script') {
      const es = editScriptFromCuts(cuts)
      setEditScript(es)
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
        }))
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
          evt.stage === 'cut' ? `กำลังตัดช่วงที่ ${evt.step}/${evt.total}…` : 'กำลังประกอบวิดีโอ…'
        )
      })
      try {
        await window.noey.sidecar.renderFinal.run({
          projectDir,
          timeline,
          voiceoverPath: project.voiceoverPath
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

  const openEditor = (): void => {
    // talking_head always edits the render timeline. dub_first: post-VO
    // (done + planned timeline) edits the timeline; otherwise the edit script.
    const target: 'edit_script' | 'timeline' =
      mode === 'talking_head' || (step === 'done' && project.timeline) ? 'timeline' : 'edit_script'
    configureEditorApi({
      localUid: project.uid,
      clips: project.clips,
      editTarget: target,
      editScript,
      timeline: (project.timeline as DubTimeline | undefined) ?? null,
      onSave: (cuts) => saveEditedCuts(cuts, target)
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
    retry,
    openEditor
  }
}
