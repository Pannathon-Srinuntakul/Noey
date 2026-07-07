import { useEffect, useRef, useState } from 'react'
import type { LocalProject, SidecarEvent } from '../../../preload'
import { ApiError } from '../lib/api'
import {
  analyzeFrames,
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
  type FrameManifestEntry
} from '../lib/videosLocalApi'
import {
  STEP_LABELS,
  isBusy,
  stepIndex,
  stepOrderFor,
  type ProjectMode,
  type ProjectStep
} from '../lib/projectFlow'
import { groupScriptLines } from '../lib/dubScript'
import { configureEditorApi, editScriptFromCuts, type SaveCutPayload } from '../lib/editorApi'
import { VideoTimelineEditor } from '../components/TimelineEditor'

interface Props {
  project: LocalProject
  session: ApiSession
  onBack: () => void
}

function pickFile(accept: string): Promise<{ path: string; name: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.onchange = () => {
      const f = input.files?.[0]
      if (!f) return resolve(null)
      const path =
        window.electron.webUtils?.getPathForFile?.(f) ?? (f as unknown as { path?: string }).path
      resolve(path ? { path, name: f.name } : null)
    }
    input.oncancel = () => resolve(null)
    input.click()
  })
}

export default function DubWizard({ project: initial, session, onBack }: Props): React.JSX.Element {
  const [project, setProject] = useState<LocalProject>(initial)
  const [brief, setBrief] = useState(initial.brief ?? '')
  const [userScript, setUserScript] = useState(initial.userScript ?? '')
  const [progressMsg, setProgressMsg] = useState<string>('')
  const [thinking, setThinking] = useState<string>('')
  const [editScript, setEditScript] = useState<DubEditScript | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mediaKey, setMediaKey] = useState(0) // cache-bust <video> after re-render
  const [durationMode, setDurationMode] = useState<'full' | 'custom'>(
    initial.targetDurationSec ? 'custom' : 'full'
  )
  const [targetSec, setTargetSec] = useState<number>(initial.targetDurationSec ?? 60)
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
      let current = await patchProject({
        step: 'analyzing',
        brief,
        userScript,
        targetDurationSec: durationMode === 'custom' ? targetSec : undefined,
        error: undefined
      })

      let remoteUid = current.remote?.uid
      if (!remoteUid) {
        const created = await createLocalProject(session, {
          brief: brief || null,
          user_script: userScript || null,
          target_duration_sec: durationMode === 'custom' ? targetSec : null,
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

      setProgressMsg('กำลังหาซีนในคลิป…')
      const projectDir = await window.noey.projects.dir(project.uid)
      const unsub = window.noey.sidecar.extractFrames.onProgress((evt: SidecarEvent) => {
        setProgressMsg(`กำลังหาซีนในคลิป ${evt.step}/${evt.total}…`)
      })
      try {
        await window.noey.sidecar.extractFrames.run({ projectDir })
      } finally {
        unsub()
      }

      setProgressMsg('กำลังอัพโหลด frames ให้ AI…')
      const manifestUrl = window.noey.media.urlFor(project.uid, 'frames/frames_manifest.json')
      const entries = (await (await fetch(manifestUrl)).json()) as FrameManifestEntry[]
      const { job_id } = await analyzeFrames(session, remoteUid, project.uid, entries)
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
        brief: brief || null
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
        targetDurationSec: durationMode === 'custom' ? targetSec : undefined,
        error: undefined
      })

      let remoteUid = current.remote?.uid
      if (!remoteUid) {
        const created = await createLocalProject(session, {
          mode: 'talking_head',
          target_duration_sec: durationMode === 'custom' ? targetSec : null,
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
  }

  // ── manual timeline editor ────────────────────────────────────────────────
  const [showEditor, setShowEditor] = useState(false)

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

  if (showEditor) {
    return (
      <VideoTimelineEditor
        uid={project.uid}
        mode={mode}
        onClose={() => setShowEditor(false)}
        onSaved={() => setShowEditor(false)}
      />
    )
  }

  return (
    <div className="wizard">
      <header>
        <button onClick={onBack}>← กลับ</button>
        <h1>{project.name}</h1>
      </header>

      <ol className="stepbar">
        {stepOrderFor(mode).map((s) => (
          <li key={s} className={stepIndex(step, mode) >= stepIndex(s, mode) ? 'active' : ''}>
            {STEP_LABELS[s]}
          </li>
        ))}
      </ol>

      {error && (
        <div className="wizard-error">
          {error}
          <button onClick={retry}>ลองใหม่</button>
        </div>
      )}

      {step === 'imported' && (
        <section>
          <h2>คลิปที่นำเข้า ({project.clips.length})</h2>
          <ul>
            {project.clips.map((c) => (
              <li key={c.id}>
                {c.file} · {c.durationSec.toFixed(1)}s · {c.width}x{c.height}
              </li>
            ))}
          </ul>
          <div className="mode-picker">
            <label>
              <input
                type="radio"
                name="videoMode"
                checked={mode === 'dub_first'}
                onChange={() => patchProject({ mode: 'dub_first' })}
              />
              Dub First — AI เขียนสคริปต์ + ตัดซีน แล้วคุณพากย์ทับ
            </label>
            <label>
              <input
                type="radio"
                name="videoMode"
                checked={mode === 'talking_head'}
                onChange={() => patchProject({ mode: 'talking_head' })}
              />
              Talking Head — ตัดช่วงเงียบ/คำซ้ำจากคลิปพูดหน้ากล้อง (ใช้เสียงเดิม)
            </label>
          </div>

          {mode === 'dub_first' && (
            <>
              <label>
                Brief (สินค้า/จุดขาย)
                <textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={3} />
              </label>
              <label>
                สคริปต์ของคุณเอง (ถ้ามี — เว้นว่างให้ AI เขียน)
                <textarea
                  value={userScript}
                  onChange={(e) => setUserScript(e.target.value)}
                  rows={3}
                />
              </label>
              <div className="mode-picker">
                <label>
                  <input
                    type="radio"
                    name="dubDuration"
                    checked={durationMode === 'full'}
                    onChange={() => setDurationMode('full')}
                  />
                  ให้ AI กำหนดความยาวเอง (~50–60 วิ)
                </label>
                <label>
                  <input
                    type="radio"
                    name="dubDuration"
                    checked={durationMode === 'custom'}
                    onChange={() => setDurationMode('custom')}
                  />
                  กำหนดความยาว ~
                  <input
                    type="number"
                    min={15}
                    max={600}
                    value={targetSec}
                    disabled={durationMode !== 'custom'}
                    onChange={(e) => setTargetSec(Number(e.target.value))}
                    style={{ width: 70, margin: '0 6px' }}
                  />
                  วินาที
                </label>
              </div>
              <button className="primary" onClick={runAnalyze}>
                เริ่มวิเคราะห์ด้วย AI
              </button>
            </>
          )}

          {mode === 'talking_head' && (
            <>
              <div className="mode-picker">
                <label>
                  <input
                    type="radio"
                    name="thDuration"
                    checked={durationMode === 'full'}
                    onChange={() => setDurationMode('full')}
                  />
                  เก็บทุกช่วงพูด (ตัดแค่ช่วงเงียบ/คำซ้ำ)
                </label>
                <label>
                  <input
                    type="radio"
                    name="thDuration"
                    checked={durationMode === 'custom'}
                    onChange={() => setDurationMode('custom')}
                  />
                  ให้ AI เลือก highlight ~
                  <input
                    type="number"
                    min={15}
                    max={600}
                    value={targetSec}
                    disabled={durationMode !== 'custom'}
                    onChange={(e) => setTargetSec(Number(e.target.value))}
                    style={{ width: 70, margin: '0 6px' }}
                  />
                  วินาที
                </label>
              </div>
              <button className="primary" onClick={runTalkingHead}>
                เริ่มถอดเสียง + ตัดต่อด้วย AI
              </button>
            </>
          )}
        </section>
      )}

      {isBusy(step) && (
        <section>
          <p className="progress-msg">{progressMsg || STEP_LABELS[step]}</p>
          {(step === 'analyzing' || step === 'transcribing') && thinking && (
            <pre className="thinking">{thinking}</pre>
          )}
        </section>
      )}

      {mode === 'talking_head' && step === 'done' && (
        <section className="review">
          <div className="player">
            <video
              key={`th-${mediaKey}`}
              controls
              src={window.noey.media.urlFor(project.uid, 'final.mp4')}
            />
          </div>
          <div className="script-panel">
            <h2>วิดีโอพร้อมแล้ว</h2>
            <p>
              ตัดช่วงเงียบ/คำซ้ำเสร็จแล้ว — ไฟล์ final.mp4 + ซับ SRT + CapCut bundle
              อยู่ในโฟลเดอร์โปรเจกต์
            </p>
            <button onClick={() => window.noey.projects.reveal(project.uid, 'final.mp4')}>
              เปิดโฟลเดอร์ไฟล์วิดีโอ
            </button>
            <button onClick={() => window.noey.projects.reveal(project.uid, 'capcut_bundle.zip')}>
              เปิด CapCut bundle
            </button>
            <button onClick={openEditor} disabled={!project.timeline}>
              แก้ไขวิดีโอ (timeline editor)
            </button>
          </div>
        </section>
      )}

      {mode === 'dub_first' && (step === 'waiting_vo' || step === 'done') && (
        <section className="review">
          <div className="player">
            <video
              key={`${step}-${mediaKey}`}
              controls
              src={window.noey.media.urlFor(
                project.uid,
                step === 'done' ? 'final.mp4' : 'final_silent.mp4'
              )}
            />
          </div>
          <div className="script-panel">
            <h2>สคริปต์พากย์</h2>
            {editScript ? (
              <ol>
                {groupScriptLines(editScript).map((line) => (
                  <li key={line.lineId}>
                    {line.script}
                    {line.cutCount > 1 && <span className="cuts"> ({line.cutCount} cuts)</span>}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="placeholder">กำลังโหลดสคริปต์…</p>
            )}
            {step === 'waiting_vo' && (
              <>
                <p>ดูวิดีโอเงียบ + อ่านสคริปต์ แล้วอัดเสียงพากย์ของคุณ จากนั้นเลือกไฟล์เสียง</p>
                <button className="primary" onClick={runFinal}>
                  เลือกไฟล์เสียงพากย์ → render วิดีโอสุดท้าย
                </button>
                <button onClick={openEditor} disabled={!editScript}>
                  แก้ไขวิดีโอ (timeline editor)
                </button>
              </>
            )}
            {step === 'done' && (
              <>
                <button onClick={() => window.noey.projects.reveal(project.uid, 'final.mp4')}>
                  เปิดโฟลเดอร์ไฟล์วิดีโอ
                </button>
                <button onClick={openEditor}>แก้ไขวิดีโอ (timeline editor)</button>
              </>
            )}
          </div>
        </section>
      )}
    </div>
  )
}
