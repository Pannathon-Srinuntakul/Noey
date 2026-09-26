import { Dialog } from '../../ui/Dialog'
import {
  IS_MAC,
  SHORTCUT_CATEGORY_TITLES,
  SHORTCUT_DISPLAY,
  shortcutText,
  type ShortcutCategory
} from '../shortcuts'

/** R3 sheet ข — the grouped shortcut sheet (เล่น / มุมมอง / เลือก / แก้ไข)
 * on the Dialog primitive. Gesture rows print their gesture in the key slot;
 * everything listed is always available, only the dub-only and shot-swap
 * rows depend on the project. */
export function ShortcutsSheet({
  isDub,
  canShotSwap = false,
  onClose
}: {
  isDub: boolean
  /** The project has AI backup shots — see the shotSwapOnly entries. */
  canShotSwap?: boolean
  onClose: () => void
}): React.JSX.Element {
  const categories = Object.keys(SHORTCUT_CATEGORY_TITLES) as ShortcutCategory[]
  return (
    <Dialog open onClose={onClose} title="แป้นพิมพ์ลัด" width={680}>
      <div className="grid grid-cols-1 gap-x-10 gap-y-6 sm:grid-cols-2">
        {categories.map((cat) => {
          const items = SHORTCUT_DISPLAY.filter(
            (s) => s.category === cat && (!s.dubOnly || isDub) && (!s.shotSwapOnly || canShotSwap)
          )
          if (items.length === 0) return null
          return (
            <section key={cat} className={cat === 'edit' ? 'sm:row-span-3' : undefined}>
              <h4 className="mb-2 text-[13px] font-medium tracking-wide text-muted">
                {SHORTCUT_CATEGORY_TITLES[cat]}
              </h4>
              <ul className="space-y-2">
                {items.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-ink">{s.labelTh}</span>
                    <kbd
                      className={`shrink-0 text-[13px] tabular-nums text-muted ${
                        s.gesture ? 'text-right' : 'font-mono'
                      }`}
                    >
                      {shortcutText(s.id)}
                    </kbd>
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
      </div>
      <p className="mt-5 border-t border-divider pt-3 text-[13px] text-muted">
        กด Alt ค้างขณะลากเพื่อปิดดูดขอบชั่วคราว · Shift+ลาก เลือกหลายฉาก
      </p>
      <p className="mt-1 text-[13px] text-muted">
        {IS_MAC ? 'แสดงคีย์ตามระบบ Mac ของคุณ (⌘ = Command, ⌥ = Option)' : 'บน Mac ใช้ ⌘ แทน Ctrl'}
        {' · J ถอยทีละ 1 วิ (เบราว์เซอร์เล่นถอยหลังไม่ได้)'}
      </p>
    </Dialog>
  )
}
