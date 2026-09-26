import { Copy, Eye, EyeOff, Scissors, Shuffle, SquarePlay, Trash2 } from 'lucide-react'
import { memo } from 'react'
import { Button } from '../../ui/Button'
import { withShortcut } from '../shortcuts'

/** The inspector's pinned actions — แยกฉาก / เล่นฉากนี้ / ทำซ้ำ / ข้าม /
 * ปรับช็อต / ลบ (R3). The same action set as the scene's context menu. */
export const SceneActions = memo(function SceneActions({
  hasSelection,
  selectionCount = hasSelection ? 1 : 0,
  skipped = false,
  onSplit,
  onDuplicate,
  onDelete,
  onPlayScene,
  onToggleSkip,
  onOpenShotSwap
}: {
  hasSelection: boolean
  /** How many scenes are selected — the delete button names the count. */
  selectionCount?: number
  /** The primary selected scene is skipped (meta.skipped). */
  skipped?: boolean
  onSplit: () => void
  onDuplicate: () => void
  onDelete: () => void
  onPlayScene?: () => void
  onToggleSkip?: () => void
  /** Only when the project has AI backup shots to swap between. */
  onOpenShotSwap?: () => void
}): React.JSX.Element {
  const deleteLabel = selectionCount > 1 ? `ลบ ${selectionCount} ฉาก` : 'ลบฉากที่เลือก'
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-divider px-4 py-3">
      <Button
        className="flex-1"
        icon={<Scissors size={14} />}
        onClick={onSplit}
        title={withShortcut('แยกฉากตรงหัวเล่น', 'split')}
      >
        แยกฉาก
      </Button>
      {hasSelection ? (
        <>
          {onPlayScene ? (
            <Button
              icon={<SquarePlay size={15} />}
              iconOnly
              aria-label="เล่นฉากนี้"
              onClick={onPlayScene}
              title={withShortcut('เล่นฉากนี้', 'play-scene')}
            />
          ) : null}
          <Button
            className="flex-1"
            icon={<Copy size={14} />}
            onClick={onDuplicate}
            title={withShortcut('ทำซ้ำฉากที่เลือก', 'duplicate')}
          >
            ทำซ้ำ
          </Button>
          {onToggleSkip ? (
            <Button
              icon={skipped ? <Eye size={15} /> : <EyeOff size={15} />}
              iconOnly
              aria-label={skipped ? 'เอาฉากกลับ' : 'ข้ามฉาก'}
              aria-pressed={skipped}
              onClick={onToggleSkip}
              title={withShortcut(
                skipped ? 'เอากลับ — ฉากนี้ถูกข้ามอยู่' : 'ข้ามฉาก — ไม่เล่นและไม่เรนเดอร์',
                'skip-scene'
              )}
            />
          ) : null}
          {onOpenShotSwap ? (
            <Button
              icon={<Shuffle size={15} />}
              iconOnly
              aria-label="ปรับช็อต"
              onClick={onOpenShotSwap}
              title={withShortcut('ปรับช็อตของฉากที่เลือก', 'shot-swap')}
            />
          ) : null}
          <Button
            variant="danger"
            icon={<Trash2 size={15} />}
            iconOnly
            aria-label={deleteLabel}
            onClick={onDelete}
            title={withShortcut(deleteLabel, 'delete')}
          />
        </>
      ) : (
        <>
          {onPlayScene ? (
            <Button
              icon={<SquarePlay size={15} />}
              iconOnly
              aria-label="เล่นฉากนี้"
              disabled
              reasonAs="tooltip"
              disabledReason="เลือกฉากก่อน"
            />
          ) : null}
          <Button
            className="flex-1"
            icon={<Copy size={14} />}
            disabled
            reasonAs="tooltip"
            disabledReason="เลือกฉากก่อน"
          >
            ทำซ้ำ
          </Button>
          {onToggleSkip ? (
            <Button
              icon={<EyeOff size={15} />}
              iconOnly
              aria-label="ข้ามฉาก"
              disabled
              reasonAs="tooltip"
              disabledReason="เลือกฉากก่อน"
            />
          ) : null}
          {onOpenShotSwap ? (
            <Button
              icon={<Shuffle size={15} />}
              iconOnly
              aria-label="ปรับช็อต"
              disabled
              reasonAs="tooltip"
              disabledReason="เลือกฉากก่อน"
            />
          ) : null}
          <Button
            variant="danger"
            icon={<Trash2 size={15} />}
            iconOnly
            aria-label="ลบฉากที่เลือก"
            disabled
            reasonAs="tooltip"
            disabledReason="เลือกฉากก่อน"
          />
        </>
      )}
    </div>
  )
})
