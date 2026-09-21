import { ArrowLeft, HelpCircle, Redo2, Save, Sparkles, Undo2 } from 'lucide-react'
import { memo } from 'react'
import { OverlayTitleBarSpacer } from '../OverlayTitleBarSpacer'
import { Button } from '../ui/Button'
import { withShortcut } from './shortcuts'

/**
 * The overlay's title strip and the editor's header row.
 *
 * Memoized, and handed only values that change when something it shows does:
 * a trim, a seek or a keystroke in the inspector leaves it alone.
 */
export const EditorHeader = memo(function EditorHeader({
  projectName,
  isDub,
  draftSavedAt,
  editCount,
  canAiReedit,
  saving,
  cutCount,
  ready,
  canUndo,
  canRedo,
  onBack,
  onUndo,
  onRedo,
  onOpenShortcuts,
  onOpenAi,
  onSave
}: {
  projectName?: string
  isDub: boolean
  draftSavedAt: string | null
  editCount: number
  canAiReedit: boolean
  saving: boolean
  cutCount: number
  /** Past the preparing screen. */
  ready: boolean
  canUndo: boolean
  canRedo: boolean
  onBack: () => void
  onUndo: () => void
  onRedo: () => void
  onOpenShortcuts: () => void
  onOpenAi: () => void
  onSave: () => void
}): React.JSX.Element {
  return (
    <>
      <OverlayTitleBarSpacer
        label={`แก้ไขวิดีโอ${projectName ? ` — ${projectName}` : ''} · ${
          isDub ? 'ตัดฉากเด่น' : 'ตัดช่วงเงียบ'
        }`}
        rightNote={draftSavedAt ? `บันทึกร่างอัตโนมัติ · ${draftSavedAt}` : undefined}
      />
      {/* header (R3): leave, history, what state the cut is in, then act */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-divider px-4 py-3 md:flex-nowrap md:px-6">
        <Button variant="ghost" icon={<ArrowLeft size={16} />} onClick={onBack}>
          กลับไปหน้าโปรเจกต์
        </Button>
        <span className="h-5 w-px bg-divider" />
        {canUndo ? (
          <Button
            icon={<Undo2 size={15} />}
            onClick={onUndo}
            title={withShortcut('เลิกทำ', 'undo')}
          >
            เลิกทำ
          </Button>
        ) : (
          <Button
            icon={<Undo2 size={15} />}
            disabled
            reasonAs="tooltip"
            disabledReason="ยังไม่มีอะไรให้ย้อน"
          >
            เลิกทำ
          </Button>
        )}
        {canRedo ? (
          <Button icon={<Redo2 size={15} />} onClick={onRedo} title={withShortcut('ทำซ้ำ', 'undo')}>
            ทำซ้ำ
          </Button>
        ) : (
          <Button
            icon={<Redo2 size={15} />}
            disabled
            reasonAs="tooltip"
            disabledReason="ย้อนก่อนถึงจะทำซ้ำได้"
          >
            ทำซ้ำ
          </Button>
        )}

        <p className="min-w-0 flex-1 truncate text-sm text-muted">
          {editCount > 0 ? `แก้แล้ว ${editCount} อย่าง · ยังไม่ได้เรนเดอร์` : 'ยังไม่ได้แก้อะไร'}
          {draftSavedAt ? ` · บันทึกร่างอัตโนมัติ ${draftSavedAt}` : ''}
        </p>

        <Button
          variant="ghost"
          icon={<HelpCircle size={16} />}
          onClick={onOpenShortcuts}
          title={withShortcut('แป้นพิมพ์ลัด', 'shortcuts-help')}
        >
          แป้นพิมพ์ลัด
        </Button>
        {canAiReedit &&
          (ready && cutCount > 0 ? (
            <Button icon={<Sparkles size={16} />} onClick={onOpenAi}>
              ให้ AI แก้ให้
            </Button>
          ) : (
            <Button
              icon={<Sparkles size={16} />}
              disabled
              reasonAs="tooltip"
              disabledReason="ต้องมีอย่างน้อย 1 ฉาก"
            >
              ให้ AI แก้ให้
            </Button>
          ))}
        {ready && cutCount > 0 ? (
          <Button
            variant="primary"
            icon={<Save size={16} />}
            loading={saving}
            onClick={onSave}
            title={withShortcut('บันทึกและเรนเดอร์', 'save')}
          >
            {saving ? 'กำลังบันทึก…' : 'บันทึกและเรนเดอร์'}
          </Button>
        ) : (
          <Button
            variant="primary"
            icon={<Save size={16} />}
            disabled
            reasonAs="tooltip"
            disabledReason={cutCount === 0 ? 'ต้องมีอย่างน้อย 1 ฉาก' : 'กำลังเตรียมวิดีโอ'}
          >
            บันทึกและเรนเดอร์
          </Button>
        )}
      </div>
    </>
  )
})
