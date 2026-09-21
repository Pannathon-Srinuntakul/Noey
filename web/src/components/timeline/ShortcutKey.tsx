import { SHORTCUT_DISPLAY, formatShortcut } from './shortcuts'

/** The shortcut letter, drawn beside a toolbar label in muted (R3 toolbar). */
export function ShortcutKey({ id }: { id: string }): React.JSX.Element | null {
  const def = SHORTCUT_DISPLAY.find((s) => s.id === id)
  if (!def) return null
  return <span className="text-muted">{formatShortcut(def.parts)}</span>
}
