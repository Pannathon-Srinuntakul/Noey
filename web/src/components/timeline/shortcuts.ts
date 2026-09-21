export const IS_MAC =
  typeof navigator !== 'undefined' &&
  (navigator.platform.includes('Mac') || navigator.userAgent.includes('Mac'))

export type ShortcutKeyPart =
  { type: 'mod' } | { type: 'shift' } | { type: 'key'; code?: string; key?: string }

export type ShortcutCategory = 'playback' | 'view' | 'edit'

interface ShortcutDisplayDef {
  id: string
  category: ShortcutCategory
  labelTh: string
  parts: ShortcutKeyPart[]
  dubOnly?: boolean
}

/** R3 sheet ข — grouped เล่น / มุมมอง / แก้ไข. */
export const SHORTCUT_DISPLAY: ShortcutDisplayDef[] = [
  {
    id: 'play',
    category: 'playback',
    labelTh: 'เล่น / หยุด',
    parts: [{ type: 'key', code: 'Space' }]
  },
  {
    id: 'frame-back',
    category: 'playback',
    labelTh: 'ถอย / เดินหน้า 1 เฟรม',
    parts: [
      { type: 'key', code: 'ArrowLeft' },
      { type: 'key', code: 'ArrowRight' }
    ]
  },
  {
    id: 'jump-back',
    category: 'playback',
    labelTh: 'ถอย / เดินหน้า 1 วิ',
    parts: [
      { type: 'shift' },
      { type: 'key', code: 'ArrowLeft' },
      { type: 'key', code: 'ArrowRight' }
    ]
  },
  {
    id: 'home',
    category: 'playback',
    labelTh: 'ต้นคลิป / ท้ายคลิป',
    parts: [
      { type: 'key', code: 'Home' },
      { type: 'key', code: 'End' }
    ]
  },
  {
    id: 'view-source',
    category: 'view',
    labelTh: 'ดูคลิปต้นฉบับ',
    parts: [{ type: 'mod' }, { type: 'key', code: 'Digit1' }]
  },
  {
    id: 'view-edited',
    category: 'view',
    labelTh: 'ดูแบบตัดแล้ว',
    parts: [{ type: 'mod' }, { type: 'key', code: 'Digit2' }]
  },
  {
    id: 'shortcuts-help',
    category: 'view',
    labelTh: 'เปิด–ปิดแผ่นนี้',
    parts: [{ type: 'key', key: '?' }]
  },
  {
    id: 'split',
    category: 'edit',
    labelTh: 'แยกฉากที่หัวเล่น',
    parts: [{ type: 'key', code: 'KeyS' }]
  },
  {
    id: 'add-scene',
    category: 'edit',
    labelTh: 'เพิ่มฉากที่หัวเล่น',
    parts: [{ type: 'key', code: 'KeyN' }]
  },
  {
    id: 'add-angle',
    category: 'edit',
    labelTh: 'เพิ่มมุมให้ประโยคนี้',
    parts: [{ type: 'key', code: 'KeyM' }],
    dubOnly: true
  },
  {
    id: 'set-in',
    category: 'edit',
    labelTh: 'ตั้งจุดเข้า / จุดออก',
    parts: [
      { type: 'key', code: 'BracketLeft' },
      { type: 'key', code: 'BracketRight' }
    ]
  },
  {
    id: 'delete',
    category: 'edit',
    labelTh: 'ลบฉากที่เลือก',
    parts: [{ type: 'key', code: 'Delete' }]
  },
  {
    id: 'undo',
    category: 'edit',
    labelTh: 'เลิกทำ / ทำซ้ำ',
    parts: [
      { type: 'mod' },
      { type: 'key', code: 'KeyZ' },
      { type: 'mod' },
      { type: 'key', code: 'KeyY' }
    ]
  },
  {
    id: 'save',
    category: 'edit',
    labelTh: 'บันทึกและเรนเดอร์',
    parts: [{ type: 'mod' }, { type: 'key', code: 'KeyS' }]
  },
  {
    id: 'escape',
    category: 'edit',
    labelTh: 'ปิดหน้านี้',
    parts: [{ type: 'key', code: 'Escape' }]
  }
]

export const SHORTCUT_CATEGORY_TITLES: Record<ShortcutCategory, string> = {
  playback: 'เล่น',
  view: 'มุมมอง',
  edit: 'แก้ไข'
}

export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  return Boolean(el.closest('input, textarea, [contenteditable="true"]'))
}

function modKey(e: KeyboardEvent): boolean {
  return IS_MAC ? e.metaKey : e.ctrlKey
}

function formatKeyPart(part: ShortcutKeyPart): string {
  if (part.type === 'mod') return IS_MAC ? '⌘' : 'Ctrl'
  if (part.type === 'shift') return IS_MAC ? '⇧' : 'Shift'
  if (part.code === 'Space') return 'Space'
  if (part.code === 'ArrowLeft') return '←'
  if (part.code === 'ArrowRight') return '→'
  if (part.code === 'Home') return 'Home'
  if (part.code === 'End') return 'End'
  if (part.code === 'Delete' || part.code === 'Backspace') return 'Del'
  if (part.code === 'Escape') return 'Esc'
  if (part.code === 'BracketLeft') return '['
  if (part.code === 'BracketRight') return ']'
  if (part.key === '?') return '?'
  if (part.code?.startsWith('Key')) return part.code.slice(3)
  if (part.code?.startsWith('Digit')) return part.code.slice(5)
  return part.key?.toUpperCase() ?? part.code ?? ''
}

/**
 * A shortcut's keys as one string.
 *
 * Modifier+key is a chord and joins tight ("⌘Z" / "Ctrl+Z"); a second key after
 * a complete chord is an ALTERNATIVE ("← →", "Home End", "⌘Z ⌘Y") and is space
 * separated, or the sheet reads "Home+End" as if both were pressed together.
 */
export function formatShortcut(parts: ShortcutKeyPart[]): string {
  const groups: ShortcutKeyPart[][] = []
  for (const p of parts) {
    const last = groups[groups.length - 1]
    // A new group starts on a modifier that follows a finished chord, or on a
    // second plain key.
    if (!last || last.some((q) => q.type === 'key')) groups.push([p])
    else last.push(p)
  }
  return groups
    .map((g) => {
      const bits = g.map(formatKeyPart)
      return IS_MAC ? bits.join('') : bits.join('+')
    })
    .join(' ')
}

export function withShortcut(label: string, id: string): string {
  const def = SHORTCUT_DISPLAY.find((s) => s.id === id)
  return def ? `${label} (${formatShortcut(def.parts)})` : label
}

export function matchesShortcutParts(e: KeyboardEvent, parts: ShortcutKeyPart[]): boolean {
  const needsMod = parts.some((p) => p.type === 'mod')
  const needsShift = parts.some((p) => p.type === 'shift')
  if (needsMod !== modKey(e)) return false
  if (needsShift !== e.shiftKey) return false
  if (!needsMod && !needsShift && (e.metaKey || e.ctrlKey || e.altKey)) return false
  const keyPart = parts.find((p) => p.type === 'key')
  if (!keyPart) return false
  if (keyPart.code && e.code === keyPart.code) return true
  if (keyPart.key === '?' && (e.key === '?' || (e.code === 'Slash' && e.shiftKey))) return true
  return false
}
