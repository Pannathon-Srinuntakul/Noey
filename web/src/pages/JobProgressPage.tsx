import { useEffect, useRef, useState } from 'react'
import { Square } from 'lucide-react'
import { useJobs } from '../lib/jobs'
import {
  etaMinutes,
  progressPercent,
  progressStagesFor,
  SHORT_STEP_LABELS,
  isBusy,
  type ProjectStep
} from '../lib/projectFlow'
import { useRouter } from '../lib/router'
import { Button } from '../components/ui/Button'
import { Progress } from '../components/ui/Progress'
import { PageHeader } from '../components/shell/PageHeader'
import { MODE_LABEL } from '../lib/modeLabel'
import { canUseZoomEffects } from '../lib/platformFeatures'

function formatDuration(totalSec: number): string {
  const m = Math.floor(totalSec / 60)
  const s = Math.round(totalSec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * Where "ดูรายละเอียด" on a running job lands — never the editor, which stays
 * unreachable until the job finishes (HANDOFF §5 item 6, §6 item 7).
 *
 * This is also the only place the AI thinking log is shown, and it is
 * collapsed by default.
 */
export default function JobProgressPage({ uid }: { uid: string }): React.JSX.Element {
  const { jobFor } = useJobs()
  const { navigate } = useRouter()
  const job = jobFor(uid)
  const [logOpen, setLogOpen] = useState(false)
  const logRef = useRef<HTMLPreElement>(null)

  const step = job?.step as ProjectStep | undefined
  const busy = step ? isBusy(step) : false

  // Follow the tail as new thinking arrives, but only while the user is
  // already at the bottom — otherwise scrolling back to read is fought.
  useEffect(() => {
    const el = logRef.current
    if (!el || !logOpen) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [job?.thinking, logOpen])

  /**
   * A job that FINISHES while this page is open has nothing left to show — send
   * the user on rather than leaving a dead 100% bar.
   *
   * The trigger is the transition, not the state. As a plain predicate it also
   * fired on arrival: the voiceover screen navigates here and only then awaits
   * an ffprobe IPC round-trip before the step leaves `waiting_vo` (which is not
   * busy), so pressing "เรนเดอร์วิดีโอ" flashed this screen and dumped the user
   * back on the projects list while the render was starting (2026-08-14).
   */
  const wasBusy = useRef(false)
  useEffect(() => {
    if (busy) {
      wasBusy.current = true
      return
    }
    if (job && step && wasBusy.current) navigate({ name: 'projects' })
  }, [job, step, busy, navigate])

  if (!job) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted">ไม่พบโปรเจกต์นี้</p>
      </div>
    )
  }

  const mode = job.mode
  // The voiceover tail only exists while it is actually running — without the
  // flag `indexOf` is -1 for these two steps and the bar reads zero for the
  // whole voiced render.
  const voiced = step === 'planning' || step === 'final_rendering'
  const stages = progressStagesFor(mode, { withVoiceover: voiced })
  const currentIndex = stages.indexOf(step as ProjectStep)
  const percent = progressPercent(step as ProjectStep, mode)
  const clips = job.project.clips ?? []
  const pending = job.project.pendingSources ?? []
  const totalSec = clips.reduce((sum, c) => sum + (c.durationSec ?? 0), 0)

  return (
    <>
      <PageHeader
        title={job.project.name}
        backLabel="โปรเจกต์ทั้งหมด"
        onBack={() => navigate({ name: 'projects' })}
        subtitle={`${MODE_LABEL[mode]} · กำลังทำงาน — แก้ไขได้เมื่อเรนเดอร์เสร็จ`}
        actions={
          <Button
            variant="danger"
            icon={<Square size={15} fill="currentColor" />}
            loading={job.stopping}
            onClick={() => void job.stop()}
          >
            {job.stopping ? 'กำลังหยุด…' : 'หยุดงาน'}
          </Button>
        }
      />

      {/* Stacks below `lg`. A 300px `shrink-0` panel in an unprefixed row left
          the progress column ~2px at 390 — the thing the screen exists to
          show. */}
      <div className="scroll-ghost flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 pb-8 pt-6 lg:flex-row lg:px-8">
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <div className="rounded-md border border-accent p-5">
            <Progress
              steps={stages.map((s) => SHORT_STEP_LABELS[s])}
              currentIndex={currentIndex}
              percent={percent}
              etaMinutes={etaMinutes(job.runStartedAt, percent) ?? undefined}
            />
          </div>

          <div className="rounded-md border border-divider px-5 py-[18px]">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[15px] font-semibold text-ink">สิ่งที่ AI กำลังทำ</p>
              <button
                type="button"
                onClick={() => setLogOpen((v) => !v)}
                className="text-sm text-accent hover:text-accent-hover-text"
              >
                {logOpen ? 'ซ่อนรายละเอียด' : 'ดูรายละเอียด'}
              </button>
            </div>
            {logOpen ? (
              <pre
                ref={logRef}
                className="scroll-ghost mt-3 max-h-64 overflow-y-auto whitespace-pre-wrap font-mono text-[13px] leading-[1.7] text-muted"
                style={{ userSelect: 'text' }}
              >
                {job.thinking || 'ยังไม่มีรายละเอียดจาก AI'}
              </pre>
            ) : (
              <p className="mt-2.5 text-sm text-muted">
                {job.progressMsg || SHORT_STEP_LABELS[step as ProjectStep]}
              </p>
            )}
          </div>
        </div>

        <div className="w-full shrink-0 rounded-md border border-divider px-5 py-[18px] lg:w-[300px]">
          <p className="mb-3 text-[15px] font-semibold text-ink">ไฟล์ต้นฉบับ</p>
          <div className="flex flex-col gap-2.5 text-sm text-muted">
            {clips.length === 0 ? (
              // During the import stage the clips do not exist yet — name the
              // files being copied instead of claiming there is no data.
              pending.length > 0 ? (
                pending.map((src) => (
                  <span key={src} className="min-w-0 truncate" style={{ userSelect: 'text' }}>
                    {src.split(/[\\/]/).pop()}
                  </span>
                ))
              ) : (
                <span>ไม่มีข้อมูลไฟล์</span>
              )
            ) : (
              <>
                {clips.map((clip) => (
                  <span key={clip.id} className="flex justify-between gap-2 tabular-nums">
                    <span className="min-w-0 truncate" style={{ userSelect: 'text' }}>
                      {clip.file.split(/[\\/]/).pop()}
                    </span>
                    <span className="shrink-0 text-ink">
                      {formatDuration(clip.durationSec ?? 0)}
                    </span>
                  </span>
                ))}
                <span className="flex justify-between tabular-nums">
                  รวม <span className="text-ink">{formatDuration(totalSec)}</span>
                </span>
              </>
            )}
          </div>
          <p className="mt-3.5 border-t border-divider pt-3 text-[13px] leading-[1.6] text-muted">
            {canUseZoomEffects ? 'แก้ไขวิดีโอ ใส่การซูม และส่งออก' : 'แก้ไขวิดีโอ และส่งออก'}{' '}
            จะเปิดได้เมื่องานนี้เสร็จ
          </p>
        </div>
      </div>
    </>
  )
}
