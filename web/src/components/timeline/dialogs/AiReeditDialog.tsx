import { Sparkles } from 'lucide-react'
import { useStableCallback } from '../../../lib/useStableCallback'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { Textarea } from '../../ui/Input'

export interface AiReeditLine {
  id: number
  script: string
  cutCount: number
}

/** R3 sub-frame ก — pick the sentences, say what to change. */
export function AiReeditDialog({
  lines,
  checked,
  onToggle,
  instruction,
  onInstructionChange,
  busy,
  errorMsg,
  onSubmit,
  onClose
}: {
  lines: AiReeditLine[]
  checked: Set<number>
  onToggle: (lineId: number) => void
  instruction: string
  onInstructionChange: (v: string) => void
  busy: boolean
  errorMsg: string | null
  onSubmit: () => void
  onClose: () => void
}): React.JSX.Element {
  // One identity for the dialog's life: Dialog keys its focus effect on
  // onClose, and a fresh closure per render sent focus back to the panel.
  const closeUnlessBusy = useStableCallback(() => {
    if (!busy) onClose()
  })
  return (
    <Dialog
      open
      onClose={closeUnlessBusy}
      title="ให้ AI แก้ให้"
      subtitle="เลือกประโยคที่อยากให้แก้ แล้วบอกว่าจะแก้อะไร"
      width={560}
    >
      <ul className="mb-4 space-y-2">
        {lines.map((l, i) => {
          const isChecked = checked.has(l.id)
          return (
            <li key={l.id}>
              <label
                className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-sm transition-colors duration-state ${
                  isChecked
                    ? 'border-accent bg-accent-nav text-ink'
                    : 'border-border text-ink hover:border-border-strong'
                }`}
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => onToggle(l.id)}
                  disabled={busy}
                  className="accent-[var(--color-accent)]"
                />
                <span className="w-4 shrink-0 text-right tabular-nums text-muted">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate">
                  {l.script || '(ไม่มีบทพูด)'}
                  {l.cutCount > 1 ? <span className="text-muted"> · {l.cutCount} มุม</span> : null}
                </span>
              </label>
            </li>
          )
        })}
      </ul>
      <p className="mb-1.5 text-[13px] text-muted">อยากให้แก้ว่าอะไร</p>
      {busy ? (
        <Textarea
          value={instruction}
          onChange={(e) => onInstructionChange(e.target.value)}
          disabled
          disabledReason="กำลังแก้ไขอยู่"
          placeholder="เช่น ตัดให้กระชับกว่านี้ · เอาช่วงที่พูดซ้ำออก"
          rows={3}
        />
      ) : (
        <Textarea
          value={instruction}
          onChange={(e) => onInstructionChange(e.target.value)}
          placeholder="เช่น ตัดให้กระชับกว่านี้ · เอาช่วงที่พูดซ้ำออก"
          rows={3}
        />
      )}
      {errorMsg && (
        <p className="mt-2 rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-sm text-error">
          {errorMsg}
        </p>
      )}
      <div className="mt-4 flex items-center justify-end gap-2">
        {busy ? (
          <Button variant="ghost" disabled reasonAs="tooltip" disabledReason="กำลังแก้ไขอยู่">
            ยกเลิก
          </Button>
        ) : (
          <Button variant="ghost" onClick={onClose}>
            ยกเลิก
          </Button>
        )}
        {instruction.trim() ? (
          <Button variant="primary" icon={<Sparkles size={14} />} loading={busy} onClick={onSubmit}>
            {busy ? 'กำลังแก้ไข…' : 'เริ่มแก้'}
          </Button>
        ) : (
          <Button
            variant="primary"
            icon={<Sparkles size={14} />}
            disabled
            disabledReason="พิมพ์คำสั่งก่อนถึงจะเริ่มได้"
          >
            เริ่มแก้
          </Button>
        )}
      </div>
    </Dialog>
  )
}
