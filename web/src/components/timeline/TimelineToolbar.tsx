import { Magnet, Maximize2, Plus, Scissors, Trash2 } from 'lucide-react'
import { memo } from 'react'
import { canSnapToBeat } from '../../lib/platformFeatures'
import { fmtTime } from '../../lib/timelineMath'
import { Button } from '../ui/Button'
import { Slider } from '../ui/Slider'
import { MAX_PX_PER_SEC, MIN_PX_PER_SEC } from './constants'
import { ShortcutKey } from './ShortcutKey'
import { withShortcut } from './shortcuts'

/** The row above the lanes: the view switch, the edit buttons, beat snap and
 * the zoom. Memoized — a trim or a seek does not touch anything it shows. */
export const TimelineToolbar = memo(function TimelineToolbar({
  viewMode,
  thStats,
  hasSelection,
  snapToBeatEnabled,
  pxPerSec,
  hasMusic,
  beatCount,
  onSwitchView,
  onSplit,
  onAddScene,
  onDelete,
  onToggleSnap,
  onZoom,
  onFit
}: {
  viewMode: 'source' | 'edited'
  /** ตัดช่วงเงียบ's removed-span summary, or null for the other modes. */
  thStats: { removedCount: number; keptSec: number; totalSec: number } | null
  hasSelection: boolean
  snapToBeatEnabled: boolean
  pxPerSec: number
  hasMusic: boolean
  /** Beats known for the attached track (0 without one). */
  beatCount: number
  onSwitchView: (next: 'source' | 'edited') => void
  onSplit: () => void
  onAddScene: () => void
  onDelete: () => void
  onToggleSnap: () => void
  onZoom: (pxPerSec: number) => void
  onFit: () => void
}): React.JSX.Element {
  return (
    <div className="scroll-ghost flex items-center gap-2 overflow-x-auto px-4 py-2">
      <div className="flex shrink-0 items-center gap-1 rounded-lg border border-border p-0.5">
        <button
          type="button"
          onClick={() => onSwitchView('edited')}
          title={withShortcut('ดูแบบตัดแล้ว', 'view-edited')}
          className={`whitespace-nowrap rounded-md border px-2.5 py-1 text-[13px] font-medium transition-colors duration-state ${
            viewMode === 'edited'
              ? 'border-accent bg-accent-nav text-accent'
              : 'border-transparent text-muted hover:text-ink'
          }`}
        >
          ตัดแล้ว
        </button>
        <button
          type="button"
          onClick={() => onSwitchView('source')}
          title={withShortcut('ดูคลิปต้นฉบับ', 'view-source')}
          className={`whitespace-nowrap rounded-md border px-2.5 py-1 text-[13px] font-medium transition-colors duration-state ${
            viewMode === 'source'
              ? 'border-accent bg-accent-nav text-accent'
              : 'border-transparent text-muted hover:text-ink'
          }`}
        >
          ต้นฉบับ
        </button>
      </div>
      {thStats && (
        <p className="text-[13px] text-muted">
          <span className="font-medium text-ink">ตัดช่วงเงียบ</span> · ตัดออกแล้ว{' '}
          {thStats.removedCount} ช่วง · {fmtTime(thStats.keptSec)} จาก {fmtTime(thStats.totalSec)}
        </p>
      )}
      <span className="h-5 w-px bg-divider" />
      {/* The key is drawn beside the label (R3), not hidden in a
        title= — a shortcut nobody can see is a shortcut nobody uses. */}
      <Button
        icon={<Scissors size={14} />}
        onClick={onSplit}
        title={withShortcut('แยกฉากตรงหัวเล่น', 'split')}
      >
        แยกที่หัวเล่น <ShortcutKey id="split" />
      </Button>
      <Button
        icon={<Plus size={14} />}
        onClick={onAddScene}
        title={withShortcut('เพิ่มฉากที่หัวเล่น', 'add-scene')}
      >
        เพิ่มฉาก <ShortcutKey id="add-scene" />
      </Button>
      {hasSelection ? (
        <Button
          icon={<Trash2 size={14} />}
          onClick={onDelete}
          title={withShortcut('ลบฉากที่เลือก แล้วฉากถัดไปเลื่อนมาชิด', 'delete')}
        >
          ลบแล้วดึงชิด
        </Button>
      ) : (
        <Button
          icon={<Trash2 size={14} />}
          disabled
          reasonAs="tooltip"
          disabledReason="เลือกฉากก่อน"
        >
          ลบแล้วดึงชิด
        </Button>
      )}
      <span className="flex-1" />
      {/* Stays on screen with no music, disabled with its reason — the
        design's own caption promises it "เปิดใช้ได้เมื่อมีเพลง", which
        only means something if you can see the control. Where the
        feature does not exist at all the control goes away instead:
        its reason would name a condition nothing can satisfy. */}
      {!canSnapToBeat ? null : beatCount > 0 ? (
        <button
          type="button"
          onClick={onToggleSnap}
          title="ลากขอบฉากแล้วดูดเข้าจังหวะเพลงอัตโนมัติ"
          className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[13px] font-medium transition-colors duration-state ${
            snapToBeatEnabled
              ? 'border-accent bg-accent-nav text-accent'
              : 'border-border text-muted hover:text-ink'
          }`}
        >
          <Magnet size={13} />
          ดูดเข้าจังหวะ
        </button>
      ) : (
        <Button
          icon={<Magnet size={13} />}
          disabled
          reasonAs="tooltip"
          disabledReason={
            hasMusic ? 'เพลงนี้ยังไม่มีข้อมูลจังหวะ' : 'ใส่เพลงประกอบก่อนถึงจะดูดเข้าจังหวะได้'
          }
        >
          ดูดเข้าจังหวะ
        </Button>
      )}
      <Slider
        className="w-44"
        value={pxPerSec}
        min={MIN_PX_PER_SEC}
        max={MAX_PX_PER_SEC}
        step={2}
        onChange={onZoom}
        formatValue={(v) => `${Math.round(v)} px/วิ`}
      />
      <Button icon={<Maximize2 size={14} />} onClick={onFit}>
        พอดีจอ
      </Button>
    </div>
  )
})
