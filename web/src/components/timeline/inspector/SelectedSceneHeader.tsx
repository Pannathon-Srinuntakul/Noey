import { memo } from 'react'
import { fmtTimeTenths } from '../../../lib/timelineMath'
import type { WorkingCut } from '../types'

/** The inspector's first row: which scene is selected, its place in the play
 * order, its length and where it comes from — 'ยาว 2.10 วิ · เริ่มที่ 0:12.4
 * ในคลิป B', plus a 'ข้ามอยู่' chip and the 'เลือก N ฉาก' count. */
export const SelectedSceneHeader = memo(function SelectedSceneHeader({
  selectedCut,
  playOrder,
  cutCount,
  sourceLabel,
  skipped = false,
  selectionCount = selectedCut ? 1 : 0
}: {
  selectedCut: WorkingCut | null
  /** The selected scene's place in the play order, 1-based. */
  playOrder: number | undefined
  cutCount: number
  /** The clip's short name ('B', or the file name) — falls back to the
   * source id. */
  sourceLabel?: string
  /** The selected scene is skipped (meta.skipped). */
  skipped?: boolean
  /** How many scenes are selected; the header names the count past one. */
  selectionCount?: number
}): React.JSX.Element {
  return (
    <div className="shrink-0 border-b border-divider px-4 py-3">
      <p className="flex items-center gap-2 text-[13px] text-muted">
        ฉากที่เลือกอยู่
        {selectionCount > 1 ? (
          <span className="rounded-full border border-border px-2 py-px text-[13px] text-ink-3">
            เลือก {selectionCount} ฉาก
          </span>
        ) : null}
        {selectedCut && skipped ? (
          <span
            className="rounded-full border border-border px-2 py-px text-[13px] text-muted"
            title="ฉากนี้ไม่เล่นและไม่เรนเดอร์ — กด D เพื่อเอากลับ"
          >
            ข้ามอยู่
          </span>
        ) : null}
      </p>
      {selectedCut ? (
        <p className="mt-0.5 min-w-0 text-sm text-muted">
          <span className="text-lg font-semibold text-ink">ฉาก {playOrder ?? '–'}</span> จาก{' '}
          {cutCount} · ยาว {(selectedCut.out - selectedCut.in).toFixed(2)} วิ · เริ่มที่{' '}
          {fmtTimeTenths(selectedCut.in)} ในคลิป {sourceLabel ?? selectedCut.source}
        </p>
      ) : (
        <p className="mt-0.5 text-sm text-muted">คลิกฉากบนเส้นเวลาเพื่อเลือก</p>
      )}
    </div>
  )
})
