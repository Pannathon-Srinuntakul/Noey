import { Copy, Scissors, Trash2 } from 'lucide-react'
import { memo } from 'react'
import { Button } from '../../ui/Button'
import { withShortcut } from '../shortcuts'

/** The inspector's pinned actions — แยกฉาก / ทำซ้ำ / ลบ (R3). */
export const SceneActions = memo(function SceneActions({
  hasSelection,
  onSplit,
  onDuplicate,
  onDelete
}: {
  hasSelection: boolean
  onSplit: () => void
  onDuplicate: () => void
  onDelete: () => void
}): React.JSX.Element {
  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-divider px-4 py-3">
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
          <Button className="flex-1" icon={<Copy size={14} />} onClick={onDuplicate}>
            ทำซ้ำ
          </Button>
          <Button
            variant="danger"
            icon={<Trash2 size={15} />}
            iconOnly
            aria-label="ลบฉากที่เลือก"
            onClick={onDelete}
          />
        </>
      ) : (
        <>
          <Button
            className="flex-1"
            icon={<Copy size={14} />}
            disabled
            reasonAs="tooltip"
            disabledReason="เลือกฉากก่อน"
          >
            ทำซ้ำ
          </Button>
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
