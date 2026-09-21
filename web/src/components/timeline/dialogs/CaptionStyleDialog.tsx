import { memo } from 'react'
import type { CaptionStyle } from '../../../lib/captionStyle'
import { Dialog } from '../../ui/Dialog'
import { CaptionPanel } from '../../wizard/CaptionPanel'

/**
 * Caption appearance — the same panel the wizard shows, reachable after the
 * cut. The style is stored on the project and burned in on the next render,
 * so nothing here re-renders anything on its own.
 *
 * `onClose` must keep its identity: Dialog keys its focus effect on it, and a
 * new one per editor render moved focus back to the panel on every render —
 * several times a second while the preview plays.
 */
export const CaptionStyleDialog = memo(function CaptionStyleDialog({
  style,
  onChange,
  onClose
}: {
  style: CaptionStyle
  onChange: (next: CaptionStyle) => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <Dialog
      open
      onClose={onClose}
      title="หน้าตาคำบรรยาย"
      subtitle="มีผลกับการเรนเดอร์ครั้งถัดไป"
      width={620}
    >
      <CaptionPanel style={style} onChange={onChange} previewThumb={null} />
    </Dialog>
  )
})
