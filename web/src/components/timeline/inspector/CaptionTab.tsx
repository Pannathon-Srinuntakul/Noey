import { ChevronLeft, ChevronRight, Download, Trash2 } from 'lucide-react'
import { memo } from 'react'
import type { CaptionLine } from '../../../lib/editorApi'
import { CAPTION_FONTS, CAPTION_MODES, type CaptionStyle } from '../../../lib/captionStyle'
import { clamp } from '../../../lib/timelineMath'
import { Button } from '../../ui/Button'
import { Textarea } from '../../ui/Input'
import { TimecodeInput } from './TimecodeInput'

function captionStyleSummary(style: CaptionStyle): string {
  const font = CAPTION_FONTS.find((f) => f.value === style.font)?.label ?? style.font
  const mode = CAPTION_MODES.find((m) => m.value === style.mode)?.label ?? style.mode
  return `${font} · ${mode} · ขนาด ${style.size}`
}

/**
 * คำบรรยายบนภาพ: the line under the caption cursor — its text, its times,
 * delete, previous/next — and the appearance row. Or why there is none.
 */
export const CaptionTabBody = memo(function CaptionTabBody({
  captionLines,
  captionCursorIdx,
  cursorLine,
  captionStyle,
  srtNote,
  onUpdateLine,
  onBeginEdit,
  onCommitEdit,
  onDeleteLine,
  onJump,
  onOpenStyle
}: {
  /** null when the project has captions off. */
  captionLines: CaptionLine[] | null
  captionCursorIdx: number
  cursorLine: CaptionLine | undefined
  captionStyle: CaptionStyle | null
  srtNote: string | null
  onUpdateLine: (id: string, patch: Partial<CaptionLine>) => void
  onBeginEdit: () => void
  onCommitEdit: () => void
  /** Deletes the line and steps the cursor back. */
  onDeleteLine: (id: string) => void
  onJump: (idx: number) => void
  onOpenStyle: () => void
}): React.JSX.Element {
  if (!(captionLines && captionLines.length > 0 && cursorLine)) {
    return (
      <p className="text-sm text-muted">
        {captionLines ? 'ยังไม่มีท่อนคำบรรยายในโปรเจกต์นี้' : 'โปรเจกต์นี้ไม่ได้เปิดคำบรรยาย'}
      </p>
    )
  }
  return (
    <>
      {/* R7 order: header · text · timecodes+delete · prev/next */}
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <p className="text-[13px] text-muted">ท่อนที่ตรงกับฉากนี้</p>
        <p className="shrink-0 text-[13px] tabular-nums text-muted">
          ท่อน {captionCursorIdx + 1} จาก {captionLines.length}
        </p>
      </div>
      <Textarea
        value={cursorLine.text}
        onChange={(e) => onUpdateLine(cursorLine.id, { text: e.target.value })}
        onFocus={onBeginEdit}
        onBlur={onCommitEdit}
        rows={2}
      />
      {/* Timecodes, not raw seconds (R7): the rest of the editor
        speaks 0:22.4, so this field must too. Typing is parsed
        back through parseTimecode, which also accepts a plain
        number for anyone who prefers seconds. */}
      <div className="mt-3 flex items-center gap-2 text-sm">
        <TimecodeInput
          value={cursorLine.start}
          onFocus={onBeginEdit}
          onCommit={(v) => {
            onUpdateLine(cursorLine.id, {
              start: clamp(v, 0, cursorLine.end)
            })
          }}
          onSettled={onCommitEdit}
        />
        <span className="text-muted">ถึง</span>
        <TimecodeInput
          value={cursorLine.end}
          onFocus={onBeginEdit}
          onCommit={(v) => {
            onUpdateLine(cursorLine.id, {
              end: Math.max(v, cursorLine.start)
            })
          }}
          onSettled={onCommitEdit}
        />
        <Button
          className="ml-auto"
          variant="danger"
          icon={<Trash2 size={15} />}
          iconOnly
          aria-label="ลบท่อนนี้"
          title="ลบท่อนนี้"
          onClick={() => onDeleteLine(cursorLine.id)}
        />
      </div>
      <div className="mt-3 flex items-center gap-1.5 [&_button]:whitespace-nowrap">
        {captionCursorIdx > 0 ? (
          <Button icon={<ChevronLeft size={14} />} onClick={() => onJump(captionCursorIdx - 1)}>
            ก่อนหน้า
          </Button>
        ) : (
          <Button
            icon={<ChevronLeft size={14} />}
            disabled
            reasonAs="tooltip"
            disabledReason="นี่คือท่อนแรกแล้ว"
          >
            ก่อนหน้า
          </Button>
        )}
        {captionCursorIdx < captionLines.length - 1 ? (
          <Button icon={<ChevronRight size={14} />} onClick={() => onJump(captionCursorIdx + 1)}>
            ถัดไป
          </Button>
        ) : (
          <Button
            icon={<ChevronRight size={14} />}
            disabled
            reasonAs="tooltip"
            disabledReason="นี่คือท่อนสุดท้ายแล้ว"
          >
            ถัดไป
          </Button>
        )}
      </div>
      <p className="mt-2 text-[13px] text-muted">แก้คำที่ถอดเสียงผิดได้ · ลบท่อนที่ AI ฟังผิดได้</p>
      {captionStyle && (
        // Appearance row (R7): an "Aa" tile in the chosen font so
        // the choice is visible, the summary, and its own button.
        <div className="mt-4 flex items-center gap-3 border-t border-divider pt-3">
          <span
            className="flex h-9 w-[52px] shrink-0 items-center justify-center rounded border border-border bg-black text-[15px] font-bold"
            style={{ color: captionStyle.color, fontFamily: captionStyle.font }}
          >
            Aa
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-ink">
              {captionStyleSummary(captionStyle)}
            </span>
            <span className="block text-[13px] text-muted">หน้าตาคำบรรยายใช้กับทั้งคลิป</span>
          </span>
          <Button onClick={onOpenStyle}>ปรับหน้าตา</Button>
        </div>
      )}
      {srtNote && <p className="mt-2 text-[13px] text-muted">{srtNote}</p>}
    </>
  )
})

/** Caption footer (R7): what the whole set is, and the export — pinned
 * outside the scrolling body so it is always reachable. */
export const CaptionFooter = memo(function CaptionFooter({
  lineCount,
  isDub,
  srtBusy,
  onExport
}: {
  lineCount: number
  isDub: boolean
  srtBusy: boolean
  onExport: () => void
}): React.JSX.Element {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-t border-divider px-4 py-3">
      <p className="min-w-0 truncate text-[13px] text-muted">
        <span className="tabular-nums">{lineCount}</span> ท่อน ·{' '}
        {isDub ? 'สร้างจากสคริปต์พากย์' : 'สร้างจากการถอดเสียง'}
      </p>
      <Button
        icon={<Download size={14} />}
        loading={srtBusy}
        onClick={onExport}
        title="บันทึกท่อนคำบรรยายที่แก้อยู่ตอนนี้เป็นไฟล์ .srt"
      >
        ส่งออก .srt
      </Button>
    </div>
  )
})
