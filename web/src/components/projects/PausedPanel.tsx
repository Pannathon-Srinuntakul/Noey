import { useEffect, useState } from 'react'
import { PauseCircle } from 'lucide-react'
import { useRouter } from '../../lib/router'
import type { ProjectPipeline } from '../../lib/useProjectPipeline'
import { probeRenderedFile } from '../../lib/usePreviewFile'
import {
  balanceLine,
  localFootageWarning,
  needsWalletConsent,
  nextStageLine,
  pausedHeadline,
  resumeActionLabel,
  resumeBlockLine,
  resumeCostLine,
  windowResetLine
} from '../../lib/resume'
import { Button } from '../ui/Button'

/**
 * A project the server stopped because the plan's quota ran out.
 *
 * Everything on this panel comes from `GET /videos/{uid}/resume`, recomputed
 * server-side each time it is read — which is the only way the window, its
 * reset time and "can the balance pay for it" can still be true after a
 * reload, in a second tab, or after logging out and back in. The pipeline
 * refreshes it whenever the project's step lands on `paused`.
 *
 * It is deliberately NOT an error card. Nothing failed: every boundary that
 * finished is kept, the frames and proxies are still on the server, and
 * continuing re-runs only the one stage that was interrupted.
 */
export function PausedPanel({ job }: { job: ProjectPipeline }): React.JSX.Element {
  const { navigate } = useRouter()
  const state = job.resumeState

  /**
   * Is this project's footage reachable from here at all?
   *
   * Project files live in this browser's own storage; the server holds a
   * synced copy, so opening the project elsewhere usually works. When neither
   * has the footage and the next stage runs on this machine, continuing is
   * impossible — and without this probe the only symptom would be a button
   * that fails a minute after it is pressed. Null while unchecked, which makes
   * no claim either way.
   */
  const [footageReachable, setFootageReachable] = useState<boolean | null>(null)
  const firstClip = job.project.clips?.[0]?.file
  const runsOnClient = state?.runsOn === 'client'
  useEffect(() => {
    if (!runsOnClient) return
    let cancelled = false
    // No clip on record is itself an answer: there is nothing here to work on.
    const check = firstClip ? probeRenderedFile(job.project.uid, firstClip) : Promise.resolve(false)
    void check.then((there) => {
      if (!cancelled) setFootageReachable(there)
    })
    return () => {
      cancelled = true
    }
  }, [job.project.uid, firstClip, runsOnClient])

  if (!state) {
    return (
      <div className="rounded-md border border-divider px-5 py-4">
        <p className="text-sm text-muted">กำลังอ่านสถานะจากเซิร์ฟเวอร์…</p>
      </div>
    )
  }

  const reset = windowResetLine(state)
  const cost = resumeCostLine(state)
  const block = resumeBlockLine(state)
  const footage = localFootageWarning(state, footageReachable)
  const wallet = needsWalletConsent(state)
  const canResume = state.resumable && !!state.nextStage

  return (
    <div className="rounded-md border border-accent bg-accent-tint px-5 py-4">
      <div className="flex items-center gap-[7px] text-sm font-semibold text-accent">
        <PauseCircle size={15} />
        {pausedHeadline(state) || 'หยุดไว้ชั่วคราว'}
      </div>

      {/* The server's own sentence first — it knows things a client cannot,
          like which plan and which run. The reset time is written HERE though,
          because only this side knows the viewer's timezone. */}
      {state.message ? (
        <p className="mt-2 text-[13.5px] leading-[1.6] text-ink-2">{state.message}</p>
      ) : null}
      <p className="mt-1.5 text-[13.5px] leading-[1.6] text-muted">
        งานที่ทำไปแล้วยังอยู่ครบ — กดทำต่อแล้วระบบจะทำเฉพาะขั้นที่ค้างไว้ ไม่เริ่มใหม่ทั้งหมด
      </p>

      <div className="mt-3 flex flex-col gap-1 text-[13px] text-muted">
        <span>{nextStageLine(state)}</span>
        {reset ? <span>{reset}</span> : null}
        {cost ? <span>{cost}</span> : null}
        {block ? <span className="text-ink-2">{block}</span> : null}
        {wallet ? <span>{balanceLine(state)}</span> : null}
      </div>

      {footage ? (
        <p className="mt-3 rounded-sm border border-divider px-3 py-2 text-[13px] leading-[1.6] text-ink-2">
          {footage}
        </p>
      ) : null}

      {/* A resume that could not even be sent (offline, a refused start). The
          pause itself is untouched, so this belongs here rather than on an
          error card that would replace the way back. */}
      {job.error ? <p className="mt-3 text-[13px] leading-[1.6] text-error">{job.error}</p> : null}

      <div className="mt-3.5 flex flex-wrap items-center gap-2.5">
        {canResume ? (
          <Button
            variant="primary"
            loading={job.resumeBusy}
            onClick={() => void job.resumeRun({ allowWallet: wallet })}
          >
            {resumeActionLabel(state)}
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled
            disabledReason={
              state.status === 'processing' ? 'งานนี้กำลังทำอยู่' : 'ไม่มีขั้นตอนค้างอยู่'
            }
          >
            ทำต่อ
          </Button>
        )}
        {/* Offered whenever the plan cannot pay, wallet consent or not: with a
            balance the press above spends it, without one this is the only
            way forward before the window rolls. */}
        {state.quota.fits !== 'plan' ? (
          <Button variant="secondary" onClick={() => navigate({ name: 'settings' })}>
            เพิ่มโควตา
          </Button>
        ) : null}
        <button
          type="button"
          onClick={() => void job.refreshResume()}
          className="text-[13px] text-accent transition-colors duration-state ease-out hover:text-accent-hover-text"
        >
          อัปเดตสถานะ
        </button>
      </div>
    </div>
  )
}
