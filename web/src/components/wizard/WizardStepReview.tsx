import { Pencil } from 'lucide-react'
import { SHORT_STEP_LABELS, progressStagesFor } from '../../lib/projectFlow'
import {
  backendMode,
  buildSubmission,
  projectCount,
  summaryRows,
  type WizardState
} from '../../lib/wizardState'
import { ProjectNameCard } from './ProjectNameCard'

/**
 * Last stop before the job starts. Everything here is derived from the same
 * `buildSubmission` / `summaryRows` the submit path uses, so what is shown is
 * what gets sent.
 *
 * The design's credit box is deliberately absent — HANDOFF §6 forbids credit
 * and minute figures anywhere in the UI, and there is no such number in the
 * API to show even if it were allowed.
 */
export function WizardStepReview({
  state,
  cutStyleName,
  onEditStep,
  onChangeName,
  onChangeFileName,
  actions
}: {
  state: WizardState
  cutStyleName: string | null
  onEditStep: (step: 1 | 2) => void
  onChangeName: (value: string) => void
  onChangeFileName: (id: string, value: string) => void
  /** Step 3's เริ่มตัดต่อ / ย้อนกลับ, pinned to the bottom of the right rail —
   * R2 screen 4 has no footer bar, the commit sits under what it commits. */
  actions?: React.ReactNode
}): React.JSX.Element {
  const rows = summaryRows(state, cutStyleName)
  const mode = backendMode(state.uiMode, state.voiceover)
  const stages = progressStagesFor(mode)
  const submission = buildSubmission(state)
  const count = projectCount(state)

  const scriptTitle = state.voiceover === 'own' ? 'สคริปต์ที่จะพากย์' : 'สิ่งที่บอก AI ไว้'
  const scriptBody =
    state.voiceover === 'own' && state.uiMode === 'highlight'
      ? submission.userScript
      : submission.brief

  return (
    <div className="scroll-ghost flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 py-6 lg:flex-row lg:overflow-hidden lg:px-10">
      {/* Scrolls as a column: the cards above the brief are fixed-height, so on
          a short window the brief was the only thing that could shrink — and it
          collapsed to a single clipped line with nowhere to scroll to. */}
      <div className="scroll-ghost flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto">
        <ProjectNameCard
          state={state}
          onChangeName={onChangeName}
          onChangeFileName={onChangeFileName}
        />

        <div className="shrink-0 rounded-md border border-divider">
          {rows.map((row, i) => (
            <div
              key={row.key}
              className={`flex items-center justify-between gap-4 px-5 py-3.5 ${
                i < rows.length - 1 ? 'border-b border-divider' : ''
              }`}
            >
              <span className="shrink-0 text-sm text-muted">{row.label}</span>
              <span className="flex min-w-0 items-center gap-3">
                {/* Only the source row is a count + clock; the rest is prose. */}
                <span
                  className={`truncate text-[15px] text-ink ${
                    row.key === 'sources' ? 'tabular-nums' : ''
                  }`}
                >
                  {row.value}
                </span>
                <button
                  type="button"
                  onClick={() => onEditStep(row.step)}
                  className="shrink-0 text-sm text-accent underline transition-colors duration-state ease-out hover:text-accent-hover-text"
                >
                  แก้
                </button>
              </span>
            </div>
          ))}
        </div>

        {/* Hidden in separate mode: the naming list already fills the column,
            and the brief is identical for every project it would describe. */}
        <div
          className={`flex min-h-[200px] flex-1 flex-col overflow-hidden rounded-md border border-divider px-5 py-[18px] ${
            count > 1 ? 'hidden' : ''
          }`}
        >
          <div className="flex shrink-0 items-center justify-between gap-3">
            <p className="text-[15px] font-semibold text-ink">{scriptTitle}</p>
            <button
              type="button"
              onClick={() => onEditStep(2)}
              className="inline-flex shrink-0 items-center gap-1.5 text-sm text-accent transition-colors duration-state ease-out hover:text-accent-hover-text"
            >
              <Pencil size={14} /> แก้ก่อนเริ่ม
            </button>
          </div>
          <p
            className="scroll-ghost mt-3 min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap text-[15px] leading-[1.75] text-ink-2"
            style={{ userSelect: 'text' }}
          >
            {scriptBody || 'ไม่ได้ใส่ไว้ — AI จะตัดสินใจเองทั้งหมด'}
          </p>
          <p className="mt-auto shrink-0 border-t border-divider pt-3.5 text-sm text-muted">
            แก้ทีหลังได้เสมอ — ข้อความนี้เป็นแนวให้ AI ไม่ใช่คำสั่งสุดท้าย
          </p>
        </div>
      </div>

      <div className="flex w-full shrink-0 flex-col gap-4 lg:w-[320px]">
        <div className="rounded-md border border-divider px-5 py-[18px]">
          <p className="mb-3 text-[15px] font-semibold text-ink">จะเกิดอะไรขึ้นต่อ</p>
          <div className="flex flex-col gap-2.5 text-sm text-ink-2">
            {/* Never a hardcoded four — the stage count differs per mode. */}
            {stages.map((step, i) => (
              <span key={step} className="flex gap-2.5">
                <span className="tabular-nums text-muted">{i + 1}</span>
                {SHORT_STEP_LABELS[step]}
              </span>
            ))}
          </div>
        </div>

        {count > 1 ? (
          <div className="rounded-md border border-divider px-5 py-[18px]">
            <p className="text-[15px] font-semibold text-ink">จะสร้าง {count} โปรเจกต์</p>
            <p className="mt-1.5 text-sm leading-[1.6] text-muted">
              คลิปละหนึ่งงาน ทั้งหมดใช้ค่าที่ตั้งไว้ชุดเดียวกัน
            </p>
          </div>
        ) : null}

        {actions ? <div className="mt-auto flex flex-col gap-2.5">{actions}</div> : null}
      </div>
    </div>
  )
}
