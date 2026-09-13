import { useState } from 'react'
import { Smartphone, Upload } from 'lucide-react'
import { cn } from '../../lib/cn'
import { pickVideoFiles, toPickedVideoFiles, type PickedVideoFile } from '../../lib/pickVideoFiles'
import {
  SOFT_CAP_SEC,
  capSecFor,
  fmtClock,
  toWizardFile,
  totalDurationSec,
  type WizardFile,
  type WizardState
} from '../../lib/wizardState'
import { ClipList } from './ClipList'
import { ReceiveFromPhoneModal } from './ReceiveFromPhoneModal'
import { useJobs } from '../../lib/jobs'

export function WizardStepFiles({
  state,
  setFiles
}: {
  state: WizardState
  /** Updater form, not a plain value: the phone-receive modal keeps the
   * callback it was mounted with, so appending against the `files` captured in
   * that render would make every arriving file overwrite the previous one. */
  setFiles: (update: (prev: WizardFile[]) => WizardFile[]) => void
}): React.JSX.Element {
  const [dragOver, setDragOver] = useState(false)
  const [receiveOpen, setReceiveOpen] = useState(false)
  const { session } = useJobs()
  const { files } = state

  const add = (picked: PickedVideoFile[]): void => {
    if (picked.length > 0) setFiles((prev) => [...prev, ...picked.map(toWizardFile)])
  }

  const total = totalDurationSec(files)
  const cap = capSecFor(state.uiMode)
  const overCap = total !== null && total > cap
  // Long ตัดฉากเด่น sources are allowed but not free: every second of footage is
  // uploaded and read by the model, so the run gets slower and dearer in a way
  // the user cannot see from the file list.
  const heavy =
    state.uiMode === 'highlight' && total !== null && total > SOFT_CAP_SEC && total <= cap

  return (
    <div className="scroll-ghost flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 py-6 lg:flex-row lg:overflow-hidden lg:px-10">
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <button
          type="button"
          onClick={() => void pickVideoFiles().then(add)}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            add(toPickedVideoFiles(Array.from(e.dataTransfer.files)))
          }}
          className={cn(
            'flex h-[200px] shrink-0 flex-col items-center justify-center gap-3 rounded-md border border-dashed transition-colors duration-state ease-out',
            dragOver
              ? 'border-accent bg-accent-tint'
              : 'border-[rgb(217_164_65_/_0.5)] bg-[rgb(217_164_65_/_0.05)] hover:border-accent'
          )}
        >
          <Upload size={30} className="text-accent" strokeWidth={1.6} />
          <span className="text-[17px] font-semibold text-ink">ลากไฟล์มาวางที่นี่</span>
          <span className="inline-flex h-10 items-center rounded-md border border-border px-4 text-[15px] font-semibold text-ink">
            เลือกไฟล์จากเครื่อง
          </span>
        </button>

        {/* The web's รับจากมือถือ — the desktop does this over LAN; here the
            backend couriers the bytes and keeps nothing (transfer.py). */}
        <button
          type="button"
          onClick={() => setReceiveOpen(true)}
          className="flex h-12 shrink-0 items-center justify-center gap-2.5 rounded-md border border-border text-[15px] font-semibold text-ink transition-colors duration-state ease-out hover:border-border-strong"
        >
          <Smartphone size={17} className="text-accent" />
          รับวิดีโอจากมือถือ
        </button>
      </div>

      {receiveOpen ? (
        <ReceiveFromPhoneModal
          session={session}
          onClose={() => setReceiveOpen(false)}
          onReceived={(received) => add(toPickedVideoFiles(received))}
        />
      ) : null}

      <div className="flex w-full shrink-0 flex-col overflow-hidden rounded-md border border-divider lg:w-[440px]">
        <div className="flex shrink-0 items-baseline justify-between gap-3 border-b border-divider px-5 py-4">
          <p className="text-[15px] font-semibold text-ink">ไฟล์ที่เลือกไว้</p>
          <span className={cn('text-sm tabular-nums', overCap ? 'text-error' : 'text-muted')}>
            {files.length} ไฟล์
            {total === null ? '' : ` · รวม ${fmtClock(total)} / ${fmtClock(cap)}`}
          </span>
        </div>

        {heavy ? (
          <p className="shrink-0 border-b border-divider px-5 py-3 text-sm leading-[1.6] text-accent">
            คลิปยาวรวมกันเกิน {Math.round(SOFT_CAP_SEC / 60)} นาที — AI ต้องดูทั้งหมด
            จะใช้เวลาและเครดิตมากกว่าปกติหลายเท่า
          </p>
        ) : null}

        <div className="scroll-ghost flex min-h-0 flex-1 flex-col overflow-y-auto">
          {files.length > 0 ? (
            <ClipList files={files} onChange={(next) => setFiles(() => next)} />
          ) : null}
          <div className="flex flex-1 items-center justify-center p-5">
            <p className="text-center text-sm leading-[1.6] text-muted">
              {files.length === 0
                ? 'ยังไม่ได้เลือกไฟล์ — ลากมาวางทางซ้าย'
                : 'ลากที่จุดหกจุดเพื่อเรียงลำดับ · แตะป้ายเพื่อกำหนดคลิปเปิด–คลิปปิด'}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
