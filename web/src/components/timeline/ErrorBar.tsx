import { AlertTriangle } from 'lucide-react'
import { Button } from '../ui/Button'

/** R3 sub-frame ง — the error bar names the failure, keeps the reassurance,
 * and offers retry + copy (text stays selectable for แจ้งปัญหา). */
export function ErrorBar({
  error,
  saving,
  canRetry,
  onRetry,
  onCopy,
  onDismiss
}: {
  error: string
  saving: boolean
  /** Only a failed save is retryable. */
  canRetry: boolean
  onRetry: () => void
  onCopy: () => void
  onDismiss: () => void
}): React.JSX.Element {
  return (
    <div className="mx-6 mt-3 rounded-lg border border-error/40 bg-error/10 px-4 py-3 select-text">
      <p className="flex items-start gap-2 text-sm text-error">
        <AlertTriangle size={15} className="mt-0.5 shrink-0" />
        <span className="min-w-0">{error}</span>
      </p>
      <p className="mt-1 pl-6 text-[13px] text-muted">งานที่แก้ไว้ยังอยู่ในเครื่อง ไม่ได้หาย</p>
      <div className="mt-2 flex items-center gap-2 pl-6">
        {canRetry && (
          <Button onClick={onRetry} loading={saving}>
            ลองอีกครั้ง
          </Button>
        )}
        <Button variant="ghost" onClick={onCopy}>
          คัดลอกข้อมูลแจ้งปัญหา
        </Button>
        <Button variant="ghost" onClick={onDismiss}>
          ปิด
        </Button>
      </div>
    </div>
  )
}
