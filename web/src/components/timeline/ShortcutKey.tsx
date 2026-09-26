import { shortcutText, type ShortcutId } from './shortcuts'

/** The shortcut letter, drawn beside a toolbar label in muted (R3 toolbar).
 * Modifier parts (⌘ / ⇧ / ⌥, or Ctrl / Shift / Alt) print through the same
 * formatter the sheet uses, so a button and the sheet never disagree. */
export function ShortcutKey({ id }: { id: ShortcutId }): React.JSX.Element | null {
  const text = shortcutText(id)
  if (!text) return null
  return <span className="text-muted">{text}</span>
}
