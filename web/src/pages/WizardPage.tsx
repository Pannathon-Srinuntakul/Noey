import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, Sparkles } from 'lucide-react'
import type { LocalProject } from '@renderer/platform/types'
import { cn } from '../lib/cn'
import { useConfirm } from '../lib/confirm'
import { useJobs } from '../lib/jobs'
import { usePrefs } from '../lib/prefs'
import { probeClipDeep } from '../lib/probeClip'
import { stageAll, stageIntoStore } from '../platform/picked'
import { useRouter } from '../lib/router'
import { listStyles, type StyleSummary } from '../lib/stylesApi'
import { useToast } from '../lib/toast'
import {
  WIZARD_INITIAL,
  buildSubmission,
  fileStepGate,
  fmtClock,
  outcomeStepGate,
  resolvedProjectName,
  toWizardFile,
  totalDurationSec,
  type WizardFile,
  type WizardState
} from '../lib/wizardState'
import { Button } from '../components/ui/Button'
import MusicRangePicker from '../components/MusicRangePicker'
import { WizardStepFiles } from '../components/wizard/WizardStepFiles'
import { WizardStepOutcome } from '../components/wizard/WizardStepOutcome'
import { WizardStepReview } from '../components/wizard/WizardStepReview'

type StepNo = 1 | 2 | 3

const STEP_TITLES: Record<StepNo, string> = {
  1: 'เอาคลิปดิบมาจากไหน',
  2: 'อยากได้วิดีโอแบบไหน',
  3: 'ตรวจอีกครั้งแล้วเริ่มเลย'
}

const STEP_NAMES: Record<StepNo, string> = {
  1: 'เลือกไฟล์',
  2: 'เลือกผลลัพธ์',
  3: 'ตรวจแล้วเริ่ม'
}

function StepRail({ current }: { current: StepNo }): React.JSX.Element {
  const steps: StepNo[] = [1, 2, 3]
  return (
    <div className="flex items-center gap-3.5 text-sm">
      {steps.map((n, i) => (
        <span key={n} className="flex items-center gap-3.5">
          {i > 0 ? (
            <span
              className={cn(
                'h-px w-10',
                n <= current ? 'bg-accent' : 'bg-[rgb(243_242_242_/_0.18)]'
              )}
            />
          ) : null}
          <span
            className={cn(
              'inline-flex items-center gap-[7px]',
              n === current ? 'font-semibold text-ink' : 'text-muted'
            )}
          >
            {n < current ? <Check size={14} className="text-accent" strokeWidth={2.2} /> : null}
            {n} · {STEP_NAMES[n]}
          </span>
        </span>
      ))}
    </div>
  )
}

/**
 * Create-job flow — the three-step full-window replacement for the old 384px
 * `NewProjectSidebar` (PLAN.md chunk 5).
 *
 * All wizard state lives here; the step components are presentational and
 * receive a `patch`. Submission is derived through `buildSubmission` so step 3
 * cannot drift from what is actually sent.
 */
export default function WizardPage({
  /** Clips another screen already received (see `Route.wizard`). Read once,
   * as the wizard's opening state — later edits belong to the wizard. */
  initialFiles
}: {
  initialFiles?: { path: string; name: string }[]
}): React.JSX.Element {
  const { session, addProject } = useJobs()
  const { navigate } = useRouter()
  const { showToast } = useToast()
  const confirm = useConfirm()

  const { prefs } = usePrefs()
  const [step, setStep] = useState<StepNo>(1)
  // Saved defaults (settings → ค่าเริ่มต้นของงานใหม่) seed the form. Read once
  // via the initializer: changing a default mid-wizard must not reach in and
  // rewrite what the user has already picked.
  const [state, setState] = useState<WizardState>(() => ({
    ...WIZARD_INITIAL,
    ...(prefs
      ? {
          uiMode: prefs.defaultMode,
          duration: prefs.defaultDuration,
          captionEnabled: prefs.defaultCaptions
        }
      : {}),
    files: initialFiles?.length ? initialFiles.map(toWizardFile) : []
  }))
  const [cutStyles, setCutStyles] = useState<StyleSummary[]>([])
  const [capturedThumb, setCapturedThumb] = useState<{ key: File; url: string } | null>(null)
  const [pendingMusicFile, setPendingMusicFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Kept so re-opening the range picker on the same track does not force the
  // user back through the native file dialog.
  const musicFileRef = useRef<File | null>(null)

  const patch = useCallback(
    (p: Partial<WizardState>) => setState((prev) => ({ ...prev, ...p })),
    []
  )

  // Mount-only: `session` is recreated by its provider on every render, so
  // depending on it here would refetch the list forever.
  useEffect(() => {
    // Cut style only. Zoom is NOT chosen at creation any more (2026-08-13): it
    // is placed later in the zoom-effects editor, where the cut already exists
    // and the choice can be judged against real footage.
    listStyles(session, 'cut')
      .then((s) => setCutStyles(s.filter((x) => x.status === 'ready')))
      .catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Fill in duration/dimensions/size for clips that do not have them yet.
  //
  // The exit condition is "we have TRIED", not "we got numbers": a clip that
  // arrived over LAN has no File, so the sidecar probe path leaves sizeBytes
  // null by construction — the old predicate stayed true after a perfectly
  // successful probe, the map allocated a new array, this effect re-fired on
  // its own output, and it spawned a sidecar process per round for as long as
  // the wizard was open.
  useEffect(() => {
    const pending = state.files.filter(
      (f) => !f.probed && f.durationSec === null && f.sizeBytes === null
    )
    if (pending.length === 0) return
    let cancelled = false
    void Promise.all(
      pending.map(async (clip) => ({ id: clip.id, meta: await probeClipDeep(clip) }))
    ).then((results) => {
      if (cancelled) return
      setState((prev) => ({
        ...prev,
        files: prev.files.map((f) => {
          const hit = results.find((r) => r.id === f.id)
          return hit ? { ...f, ...hit.meta, probed: true } : f
        })
      }))
    })
    return () => {
      cancelled = true
    }
  }, [state.files])

  // Real footage behind the caption-size preview — first clip, 9:16 crop.
  // Stored against the File it came from and read back through that key, so
  // removing the clip drops the thumbnail without an effect having to clear
  // it (a synchronous setState in an effect body).
  const firstFile = state.files[0]?.file
  const previewThumb = firstFile && capturedThumb?.key === firstFile ? capturedThumb.url : null

  useEffect(() => {
    if (!firstFile) return
    let cancelled = false
    const url = URL.createObjectURL(firstFile)
    const video = document.createElement('video')
    video.preload = 'auto'
    video.muted = true
    video.src = url

    const capture = (): void => {
      if (cancelled) return
      const w = video.videoWidth
      const h = video.videoHeight
      if (!w || !h) return
      const canvas = document.createElement('canvas')
      canvas.height = 320
      canvas.width = Math.max(1, Math.round(w * (320 / h)))
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      setCapturedThumb({ key: firstFile, url: canvas.toDataURL('image/jpeg', 0.82) })
    }

    video.addEventListener(
      'loadeddata',
      () => {
        const t = Number.isFinite(video.duration) ? Math.min(0.5, video.duration * 0.1) : 0
        if (t === 0) capture()
        else video.currentTime = t
      },
      { once: true }
    )
    video.addEventListener('seeked', capture, { once: true })

    return () => {
      cancelled = true
      video.src = ''
      URL.revokeObjectURL(url)
    }
  }, [firstFile])

  const cancel = useCallback(async (): Promise<void> => {
    if (state.files.length > 0) {
      const ok = await confirm({
        title: 'ทิ้งงานที่ตั้งค่าไว้?',
        body: `เลือกไฟล์ไว้ ${state.files.length} ไฟล์ และค่าที่ตั้งไว้ทั้งหมดจะหายไป ไฟล์ต้นฉบับบนเครื่องไม่ถูกลบ`,
        confirmLabel: 'ทิ้งเลย',
        cancelLabel: 'ตั้งค่าต่อ',
        destructive: true
      })
      if (!ok) return
    }
    navigate({ name: 'projects' })
  }, [confirm, navigate, state.files.length])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) void cancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cancel, busy])

  const pickMusicFile = (): void => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'video/*,audio/*'
    input.onchange = () => {
      const f = input.files?.[0]
      if (f) {
        musicFileRef.current = f
        setPendingMusicFile(f)
      }
    }
    input.click()
  }

  const confirmMusicRange = (range: { trimInSec: number; trimOutSec: number }): void => {
    const f = pendingMusicFile
    setPendingMusicFile(null)
    if (!f) return
    const path =
      window.electron?.webUtils?.getPathForFile?.(f) ??
      (f as unknown as { path?: string }).path ??
      window.noey.pick.register(f)
    if (!path) {
      setError('อ่านตำแหน่งไฟล์เพลงไม่ได้')
      return
    }
    patch({ music: { path, name: f.name, ...range } })
  }

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const s = buildSubmission(state)
      const groups: WizardFile[][] =
        state.uploadMode === 'separate' && state.files.length > 1
          ? state.files.map((f) => [f])
          : [state.files]

      // Create every project row and hand the SLOW part (copy + transcode of
      // the sources) to each project's own pipeline, which already owns every
      // other stage's progress and error reporting. A phone HEVC export takes
      // minutes to normalise; awaiting it here left a spinner on the button
      // with nothing watchable anywhere else.
      const created: LocalProject[] = []
      for (const group of groups) {
        const name = resolvedProjectName(state, group)
        const project = await window.noey.projects.create({ name, mode: s.mode })

        // Into the store BEFORE anything is written down. A picked file is a
        // `picked://` id backed by an in-memory Map, and persisting one into
        // project.json meant a reload before ingest finished — minutes, for a
        // phone clip that goes through a server conversion — left a project
        // pointing at a file that no longer existed anywhere, unimportable and
        // unretryable. `stageAll` returns `noeyfs://` paths a reload survives,
        // and passes through anything already in the store.
        const stagedSources = await stageAll(
          group.map((f) => f.path),
          project.uid
        )
        const stagedMusic =
          s.mode !== 'talking_head' && state.music
            ? await stageIntoStore(state.music.path, project.uid)
            : null

        const withSettings = await window.noey.projects.update(project.uid, {
          step: 'importing',
          pendingSources: stagedSources,
          pendingMusic:
            stagedMusic && state.music
              ? {
                  path: stagedMusic,
                  trimInSec: state.music.trimInSec,
                  trimOutSec: state.music.trimOutSec
                }
              : undefined,
          brief: s.brief,
          userScript: s.userScript,
          scriptStyles: s.scriptStyles,
          targetDurationSec: s.targetDurationSec,
          cutStyleUid: s.cutStyleUid,
          engine: state.engine,
          precision: state.precision,
          captionStyle: s.captionStyle,
          beatSync: s.beatSync
        })
        created.push(withSettings)
      }

      // Navigate before publishing the projects: the hosts start their jobs on
      // mount, and landing on the progress screen first avoids a frame of the
      // grid with a half-started card.
      if (created.length === 1) navigate({ name: 'progress', uid: created[0].uid })
      else {
        navigate({ name: 'projects' })
        showToast({ text: `เริ่ม ${created.length} งานแล้ว` })
      }
      created.forEach(addProject)
    } catch (err) {
      setError(String((err as Error).message ?? err))
    } finally {
      setBusy(false)
    }
  }

  const gate = step === 1 ? fileStepGate(state) : step === 2 ? outcomeStepGate(state) : { ok: true }
  const cutStyleName = cutStyles.find((s) => s.uid === state.cutStyleUid)?.name ?? null
  const sourceTotal = totalDurationSec(state.files)
  const sourceSummary =
    state.files.length === 0
      ? null
      : `${state.files.length} ไฟล์${sourceTotal === null ? '' : ` · รวม ${fmtClock(sourceTotal)}`}`

  return (
    <>
      <div className="flex shrink-0 flex-col gap-3.5 border-b border-divider px-5 pb-5 pt-8 md:px-10">
        <StepRail current={step} />
        <div>
          <h1 className="text-2xl font-semibold leading-[1.2] text-ink">{STEP_TITLES[step]}</h1>
          {step > 1 && sourceSummary ? (
            <p className="mt-1 text-sm tabular-nums text-muted">{sourceSummary}</p>
          ) : null}
        </div>
      </div>

      {step === 1 ? (
        <WizardStepFiles
          state={state}
          setFiles={(update) => setState((prev) => ({ ...prev, files: update(prev.files) }))}
        />
      ) : step === 2 ? (
        <WizardStepOutcome
          state={state}
          patch={patch}
          cutStyles={cutStyles}
          previewThumb={previewThumb}
          onPickMusic={pickMusicFile}
          onEditMusicRange={() => {
            if (musicFileRef.current) setPendingMusicFile(musicFileRef.current)
            else pickMusicFile()
          }}
        />
      ) : (
        <WizardStepReview
          state={state}
          cutStyleName={cutStyleName}
          onEditStep={(s) => setStep(s)}
          onChangeName={(projectName) => patch({ projectName, projectNameTouched: true })}
          onChangeFileName={(id, projectName) =>
            setState((prev) => ({
              ...prev,
              files: prev.files.map((f) => (f.id === id ? { ...f, projectName } : f))
            }))
          }
          actions={
            <>
              {error ? (
                // The footer that used to carry this is gone on step 3, and a
                // failed submit must not be silent.
                <p
                  className="rounded-md border border-error bg-error-tint px-3 py-2 text-sm text-error"
                  style={{ userSelect: 'text' }}
                >
                  {error}
                </p>
              ) : null}
              <Button
                variant="primary"
                className="h-12 w-full text-base"
                icon={<Sparkles size={17} />}
                loading={busy}
                onClick={() => void submit()}
              >
                เริ่มตัดต่อ
              </Button>
              <Button className="w-full" icon={<ArrowLeft size={16} />} onClick={() => setStep(2)}>
                ย้อนกลับ
              </Button>
            </>
          }
        />
      )}

      {pendingMusicFile ? (
        <MusicRangePicker
          file={pendingMusicFile}
          initialTrimInSec={state.music?.trimInSec}
          initialTrimOutSec={state.music?.trimOutSec}
          onConfirm={confirmMusicRange}
          onCancel={() => setPendingMusicFile(null)}
        />
      ) : null}

      {/* Steps 1-2 keep the footer bar. Step 3 has none (R2 screen 4): its two
          actions live at the bottom of the summary's right rail, directly under
          what they commit — only the error line still needs somewhere to go. */}
      <div
        className={`flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-divider px-5 py-[18px] md:flex-nowrap md:gap-4 md:px-10 ${
          step === 3 ? 'hidden' : ''
        }`}
      >
        {error ? (
          <span className="min-w-0 truncate text-sm text-error" style={{ userSelect: 'text' }}>
            {error}
          </span>
        ) : (
          <span className="min-w-0 truncate text-sm text-muted">
            {step === 1
              ? 'คลิปจะถูกเก็บไว้ในบัญชีของคุณ เปิดต่อจากเครื่องไหนก็ได้ · กด Esc เพื่อยกเลิก'
              : 'กด Esc เพื่อยกเลิก'}
          </span>
        )}
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-2">
          {step === 1 ? (
            <Button variant="ghost" onClick={() => void cancel()}>
              ยกเลิก
            </Button>
          ) : (
            <Button
              icon={<ArrowLeft size={16} />}
              onClick={() => setStep((s) => (s - 1) as StepNo)}
            >
              ย้อนกลับ
            </Button>
          )}
          {step === 3 ? (
            <Button
              variant="primary"
              icon={<Sparkles size={17} />}
              loading={busy}
              onClick={() => void submit()}
            >
              เริ่มตัดต่อ
            </Button>
          ) : gate.ok ? (
            <Button
              variant="primary"
              icon={<ArrowRight size={16} />}
              onClick={() => setStep((s) => (s + 1) as StepNo)}
            >
              ถัดไป
            </Button>
          ) : (
            <Button
              variant="primary"
              icon={<ArrowRight size={16} />}
              disabled
              disabledReason={gate.reason ?? ''}
            >
              ถัดไป
            </Button>
          )}
        </div>
      </div>
    </>
  )
}
