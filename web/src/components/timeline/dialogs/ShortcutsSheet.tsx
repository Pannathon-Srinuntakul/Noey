import { Dialog } from '../../ui/Dialog'
import {
  IS_MAC,
  SHORTCUT_CATEGORY_TITLES,
  SHORTCUT_DISPLAY,
  formatShortcut,
  type ShortcutCategory
} from '../shortcuts'

/** R3 sheet ข — two-column grouped shortcut sheet on the Dialog primitive. */
export function ShortcutsSheet({
  isDub,
  onClose
}: {
  isDub: boolean
  onClose: () => void
}): React.JSX.Element {
  const categories = Object.keys(SHORTCUT_CATEGORY_TITLES) as ShortcutCategory[]
  return (
    <Dialog open onClose={onClose} title="แป้นพิมพ์ลัด" width={640}>
      <div className="grid grid-cols-2 gap-x-10 gap-y-6">
        {categories.map((cat) => {
          const items = SHORTCUT_DISPLAY.filter((s) => s.category === cat && (!s.dubOnly || isDub))
          if (items.length === 0) return null
          return (
            <section key={cat} className={cat === 'edit' ? 'row-span-2' : undefined}>
              <h4 className="mb-2 text-[13px] font-medium tracking-wide text-muted">
                {SHORTCUT_CATEGORY_TITLES[cat]}
              </h4>
              <ul className="space-y-2">
                {items.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-ink">{s.labelTh}</span>
                    <kbd className="shrink-0 font-mono text-[13px] tabular-nums text-muted">
                      {formatShortcut(s.parts)}
                    </kbd>
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
      </div>
      <p className="mt-5 border-t border-divider pt-3 text-[13px] text-muted">
        {IS_MAC ? 'แสดงคีย์ตามระบบ Mac ของคุณ (⌘ = Command)' : 'บน Mac ใช้ ⌘ แทน Ctrl'}
      </p>
    </Dialog>
  )
}
