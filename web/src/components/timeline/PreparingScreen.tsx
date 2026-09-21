import { Loader2 } from 'lucide-react'

/** R3 sub-frame ค — preparing. One-time per project, so say that. */
export function PreparingScreen({
  prepareHint,
  canSkip,
  onSkip
}: {
  prepareHint: string
  /** Only the thumbnails are still coming — see the editor's filmstrip gate. */
  canSkip: boolean
  onSkip: () => void
}): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="h-1 w-56 overflow-hidden rounded-full bg-border-faint">
        <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" />
      </div>
      <p className="text-sm font-medium text-ink">กำลังเตรียมวิดีโอให้พร้อมแก้ไข</p>
      <p className="max-w-xs text-[13px] text-muted">
        ทำครั้งเดียวต่อโปรเจกต์ · ครั้งต่อไปจะเปิดได้ทันที
      </p>
      {prepareHint && (
        <p className="flex items-center gap-1.5 text-[13px] text-muted">
          <Loader2 size={13} className="animate-spin" /> {prepareHint}
        </p>
      )}
      {/* The way out for a long cold extraction: edit now, lanes fill in
          behind (their pending wash marks the ones still coming). */}
      {canSkip && (
        <button
          type="button"
          onClick={onSkip}
          className="text-[13px] text-accent underline underline-offset-2 hover:text-accent-hover-text"
        >
          เข้าไปแก้ไขเลย — ภาพตัวอย่างจะตามมาเอง
        </button>
      )}
    </div>
  )
}
