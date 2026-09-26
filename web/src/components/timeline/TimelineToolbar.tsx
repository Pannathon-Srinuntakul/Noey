import { Crosshair, Magnet, Maximize2, Plus, Scan, Scissors, Trash2 } from 'lucide-react'
import { memo } from 'react'
import { canSnapToBeat } from '../../lib/platformFeatures'
import { fmtTime } from '../../lib/timelineMath'
import { Button } from '../ui/Button'
import { Segmented } from '../ui/Segmented'
import { Slider } from '../ui/Slider'
import { MAX_PX_PER_SEC, MIN_PX_PER_SEC } from './constants'
import { ShortcutKey } from './ShortcutKey'
import { snapTitle, withShortcut } from './shortcuts'

export type TimelineLayout = 'lanes' | 'strip'

/** A pressed/unpressed toolbar toggle — the magnet and the skimmer. */
function ToggleButton({
  on,
  title,
  icon,
  onClick,
  children
}: {
  on: boolean
  title: string
  icon: React.ReactNode
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      title={title}
      className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 py-1.5 text-[13px] font-medium transition-colors duration-state ${
        on ? 'border-accent bg-accent-nav text-accent' : 'border-border text-muted hover:text-ink'
      }`}
    >
      {icon}
      {children}
    </button>
  )
}

/** The row above the lanes: the view switch, the edit buttons, the snap and
 * skim toggles and the zoom. Memoized — a trim or a seek does not touch
 * anything it shows. */
export const TimelineToolbar = memo(function TimelineToolbar({
  viewMode,
  thStats,
  hasSelection,
  selectionCount = hasSelection ? 1 : 0,
  snapEnabled,
  beatCount,
  skimEnabled,
  pxPerSec,
  canZoomSelection,
  layout = 'lanes',
  showLayoutToggle = false,
  onSwitchView,
  onSplit,
  onAddScene,
  onDelete,
  onToggleSnap,
  onToggleSkim,
  onZoom,
  onFitToggle,
  onZoomSelection,
  onLayout
}: {
  viewMode: 'source' | 'edited'
  /** ตัดช่วงเงียบ's removed-span summary, or null for the other modes. */
  thStats: { removedCount: number; keptSec: number; totalSec: number } | null
  hasSelection: boolean
  /** How many scenes are selected — the delete button names the count. */
  selectionCount?: number
  /** Snap to cut edges / playhead / voiceover lines (+ beats when known).
   * Never hidden and never disabled: every project has edges to snap to. */
  snapEnabled: boolean
  /** Beats known for the attached track (0 without one) — wording only. */
  beatCount: number
  /** Hover on the timeline shows the frame without moving the playhead. */
  skimEnabled: boolean
  pxPerSec: number
  canZoomSelection: boolean
  layout?: TimelineLayout
  /** Phone-width only: lanes ⇄ scene strip. */
  showLayoutToggle?: boolean
  onSwitchView: (next: 'source' | 'edited') => void
  onSplit: () => void
  onAddScene: () => void
  onDelete: () => void
  onToggleSnap: () => void
  onToggleSkim: () => void
  onZoom: (pxPerSec: number) => void
  /** พอดีจอ; pressed again it restores the zoom from before. */
  onFitToggle: () => void
  onZoomSelection: () => void
  onLayout?: (layout: TimelineLayout) => void
}): React.JSX.Element {
  const deleteLabel = selectionCount > 1 ? `ลบ ${selectionCount} ฉาก` : 'ลบแล้วดึงชิด'
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
      {showLayoutToggle && onLayout ? (
        <Segmented
          ariaLabel="รูปแบบไทม์ไลน์"
          value={layout}
          onChange={(v) => onLayout(v as TimelineLayout)}
          options={[
            { value: 'lanes', label: 'ไทม์ไลน์' },
            { value: 'strip', label: 'ฉาก' }
          ]}
        />
      ) : null}
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
      {selectionCount > 1 ? (
        <span className="shrink-0 whitespace-nowrap text-[13px] text-muted">
          เลือก {selectionCount} ฉาก
        </span>
      ) : null}
      {hasSelection ? (
        <Button
          icon={<Trash2 size={14} />}
          onClick={onDelete}
          title={withShortcut(
            selectionCount > 1
              ? `ลบ ${selectionCount} ฉากที่เลือก แล้วฉากถัดไปเลื่อนมาชิด`
              : 'ลบฉากที่เลือก แล้วฉากถัดไปเลื่อนมาชิด',
            'delete'
          )}
        >
          {deleteLabel}
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
      {/* One magnet, always on screen: cut edges, the playhead and the
        voiceover lines exist on every project, so there is always something
        to snap to. Beats only change the wording — canSnapToBeat gates the
        beat SOURCE of targets, never this control. */}
      <ToggleButton
        on={snapEnabled}
        onClick={onToggleSnap}
        title={snapTitle(canSnapToBeat ? beatCount : 0)}
        icon={<Magnet size={13} />}
      >
        ดูดขอบ
      </ToggleButton>
      <ToggleButton
        on={skimEnabled}
        onClick={onToggleSkim}
        title="เลื่อนเมาส์บนไทม์ไลน์เพื่อดูเฟรม โดยไม่ขยับหัวเล่น"
        icon={<Crosshair size={13} />}
      >
        แกนพรีวิว
      </ToggleButton>
      <Slider
        className="w-44"
        value={pxPerSec}
        min={MIN_PX_PER_SEC}
        max={MAX_PX_PER_SEC}
        step={2}
        onChange={onZoom}
        formatValue={(v) => `${Math.round(v)} px/วิ`}
      />
      {canZoomSelection ? (
        <Button
          icon={<Scan size={14} />}
          onClick={onZoomSelection}
          title={withShortcut('ซูมให้ฉากที่เลือกเต็มจอ', 'zoom-selection')}
        >
          พอดีฉาก
        </Button>
      ) : (
        <Button icon={<Scan size={14} />} disabled reasonAs="tooltip" disabledReason="เลือกฉากก่อน">
          พอดีฉาก
        </Button>
      )}
      <Button
        icon={<Maximize2 size={14} />}
        onClick={onFitToggle}
        title={withShortcut('ซูมให้ทั้งคลิปพอดีจอ · กดอีกครั้งกลับซูมเดิม', 'zoom-fit-toggle')}
      >
        พอดีจอ
      </Button>
    </div>
  )
})
