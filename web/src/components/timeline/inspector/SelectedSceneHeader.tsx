import { memo } from 'react'
import { fmtTime } from '../../../lib/timelineMath'
import type { WorkingCut } from '../types'

/** The inspector's first row: which scene is selected, its place in the play
 * order, its length and where it comes from. */
export const SelectedSceneHeader = memo(function SelectedSceneHeader({
  selectedCut,
  playOrder,
  cutCount
}: {
  selectedCut: WorkingCut | null
  /** The selected scene's place in the play order, 1-based. */
  playOrder: number | undefined
  cutCount: number
}): React.JSX.Element {
  return (
    <div className="shrink-0 border-b border-divider px-4 py-3">
      <p className="text-[13px] text-muted">ฉากที่เลือกอยู่</p>
      {selectedCut ? (
        <p className="mt-0.5 min-w-0 text-sm text-muted">
          <span className="text-lg font-semibold text-ink">ฉาก {playOrder ?? '–'}</span> จาก{' '}
          {cutCount} · ยาว {(selectedCut.out - selectedCut.in).toFixed(2)} วิ · {selectedCut.source}{' '}
          ที่ {fmtTime(selectedCut.in)}
        </p>
      ) : (
        <p className="mt-0.5 text-sm text-muted">คลิกฉากบนเส้นเวลาเพื่อเลือก</p>
      )}
    </div>
  )
})
