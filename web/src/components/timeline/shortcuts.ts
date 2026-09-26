export const IS_MAC =
  typeof navigator !== 'undefined' &&
  (navigator.platform.includes('Mac') || navigator.userAgent.includes('Mac'))

export type ShortcutKeyPart =
  | { type: 'mod' }
  | { type: 'shift' }
  | { type: 'alt' }
  | { type: 'key'; code?: string; key?: string }

export type ShortcutCategory = 'playback' | 'view' | 'select' | 'edit'

/**
 * Every shortcut the editor knows, by id. The editor's key handler matches
 * through `matchesShortcut(e, id)` and the sheet / tooltips format through
 * `formatShortcut`, so one table is both the documentation and the binding —
 * a key that works is a key that is listed, and vice versa.
 */
export type ShortcutId =
  // playback
  | 'play'
  | 'play-scene'
  | 'play-around'
  | 'loop'
  | 'frame-back'
  | 'jump-back'
  | 'cut-prev'
  | 'marker-prev'
  | 'marker-next'
  | 'shuttle'
  | 'home'
  // view
  | 'view-source'
  | 'view-edited'
  | 'zoom'
  | 'zoom-fit-toggle'
  | 'zoom-selection'
  | 'zoom-wheel'
  | 'scroll-wheel'
  | 'snap-toggle'
  | 'snap-suppress'
  | 'add-marker'
  | 'range-in'
  | 'range-out'
  | 'range-jump-in'
  | 'range-jump-out'
  | 'range-clear'
  | 'shortcuts-help'
  // select
  | 'select-all'
  | 'deselect-all'
  | 'select-range'
  | 'select-toggle'
  | 'marquee'
  | 'escape'
  // edit
  | 'split'
  | 'add-scene'
  | 'add-angle'
  | 'set-in'
  | 'trim-head'
  | 'trim-tail'
  | 'extend-edit'
  | 'nudge-edge'
  | 'nudge-edge-big'
  | 'slip-nudge'
  | 'slip-nudge-big'
  | 'slip-drag'
  | 'roll-drag'
  | 'move-scene'
  | 'skip-scene'
  | 'shot-swap'
  | 'duplicate'
  | 'copy'
  | 'cut'
  | 'paste'
  | 'delete'
  | 'delete-range'
  | 'undo'
  | 'redo'
  | 'save'

export interface ShortcutDisplayDef {
  id: ShortcutId
  category: ShortcutCategory
  labelTh: string
  /** Chords, in `formatShortcut` grouping: a modifier run + one key is a
   * chord; the next chord starts at the next part after a key. Several
   * chords in one def are ALTERNATIVES (S or ⌘B) and all of them match. */
  parts: ShortcutKeyPart[]
  dubOnly?: boolean
  /** Only when the project actually has AI backup shots to swap between —
   * a key the editor cannot act on must not be advertised. */
  shotSwapOnly?: boolean
  /** A pointer gesture, listed for people only: `parts` is empty, nothing
   * matches a key event, and the sheet prints `gestureTh` in the key slot. */
  gesture?: true
  gestureTh?: string
}

const MOD_WORD = IS_MAC ? '⌘' : 'Ctrl'

/** R3 sheet ข — grouped เล่น / มุมมอง / เลือก / แก้ไข. */
export const SHORTCUT_DISPLAY: ShortcutDisplayDef[] = [
  // ---- playback ----------------------------------------------------------
  {
    id: 'play',
    category: 'playback',
    labelTh: 'เล่น / หยุด',
    parts: [{ type: 'key', code: 'Space' }]
  },
  {
    id: 'play-scene',
    category: 'playback',
    labelTh: 'เล่นฉากที่เลือก / ช่วง I–O',
    parts: [{ type: 'shift' }, { type: 'key', code: 'Space' }]
  },
  {
    id: 'play-around',
    category: 'playback',
    labelTh: 'เล่นรอบรอยตัด ±1 วิ',
    parts: [{ type: 'shift' }, { type: 'key', code: 'KeyK' }]
  },
  {
    id: 'loop',
    category: 'playback',
    labelTh: 'เล่นวน',
    parts: [{ type: 'shift' }, { type: 'key', code: 'KeyL' }]
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
      { type: 'shift' },
      { type: 'key', code: 'ArrowRight' }
    ]
  },
  {
    id: 'cut-prev',
    category: 'playback',
    labelTh: 'ช็อตก่อนหน้า / ช็อตถัดไป',
    parts: [
      { type: 'key', code: 'ArrowUp' },
      { type: 'key', code: 'ArrowDown' }
    ]
  },
  {
    id: 'marker-prev',
    category: 'playback',
    labelTh: 'หมุดก่อนหน้า',
    parts: [{ type: 'shift' }, { type: 'key', code: 'ArrowUp' }]
  },
  {
    id: 'marker-next',
    category: 'playback',
    labelTh: 'หมุดถัดไป',
    parts: [{ type: 'shift' }, { type: 'key', code: 'ArrowDown' }]
  },
  {
    // J is a step BACK, not backwards play: a <video> has no reverse — a
    // negative playbackRate is ignored by every browser we ship on. L steps
    // the speed 1× → 1.5× → 2×.
    id: 'shuttle',
    category: 'playback',
    labelTh: 'ถอย 1 วิ / หยุด / เล่น–เร่ง (1× · 1.5× · 2×)',
    parts: [
      { type: 'key', code: 'KeyJ' },
      { type: 'key', code: 'KeyK' },
      { type: 'key', code: 'KeyL' }
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
  // ---- view --------------------------------------------------------------
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
    id: 'zoom',
    category: 'view',
    labelTh: 'ซูมเข้า / ซูมออก',
    parts: [
      { type: 'key', code: 'Equal' },
      { type: 'key', code: 'Minus' }
    ]
  },
  {
    id: 'zoom-fit-toggle',
    category: 'view',
    labelTh: 'พอดีจอ ⇄ ซูมเดิม',
    parts: [{ type: 'shift' }, { type: 'key', code: 'KeyZ' }]
  },
  {
    id: 'zoom-selection',
    category: 'view',
    labelTh: 'ซูมพอดีฉากที่เลือก',
    parts: [{ type: 'key', code: 'KeyF' }]
  },
  {
    id: 'zoom-wheel',
    category: 'view',
    labelTh: 'ซูมตรงเมาส์',
    parts: [],
    gesture: true,
    gestureTh: `${MOD_WORD}+ล้อ หรือบีบนิ้ว`
  },
  {
    id: 'scroll-wheel',
    category: 'view',
    labelTh: 'เลื่อนไทม์ไลน์ซ้าย–ขวา',
    parts: [],
    gesture: true,
    gestureTh: 'Shift+ล้อ'
  },
  {
    id: 'snap-toggle',
    category: 'view',
    labelTh: 'เปิด–ปิดดูดขอบ',
    parts: [{ type: 'shift' }, { type: 'key', code: 'KeyN' }]
  },
  {
    id: 'snap-suppress',
    category: 'view',
    labelTh: 'ปิดดูดขอบชั่วคราว',
    parts: [],
    gesture: true,
    gestureTh: 'Alt ค้างขณะลาก'
  },
  {
    id: 'add-marker',
    category: 'view',
    labelTh: 'ปักหมุดที่หัวเล่น',
    parts: [{ type: 'shift' }, { type: 'key', code: 'KeyM' }]
  },
  {
    id: 'range-in',
    category: 'view',
    labelTh: 'ตั้งจุด I (ต้นช่วง)',
    parts: [{ type: 'key', code: 'KeyI' }]
  },
  {
    id: 'range-out',
    category: 'view',
    labelTh: 'ตั้งจุด O (ท้ายช่วง)',
    parts: [{ type: 'key', code: 'KeyO' }]
  },
  {
    id: 'range-jump-in',
    category: 'view',
    labelTh: 'ไปจุด I',
    parts: [{ type: 'shift' }, { type: 'key', code: 'KeyI' }]
  },
  {
    id: 'range-jump-out',
    category: 'view',
    labelTh: 'ไปจุด O',
    parts: [{ type: 'shift' }, { type: 'key', code: 'KeyO' }]
  },
  {
    id: 'range-clear',
    category: 'view',
    labelTh: 'ล้างช่วง I–O',
    parts: [{ type: 'alt' }, { type: 'key', code: 'KeyX' }]
  },
  {
    id: 'shortcuts-help',
    category: 'view',
    labelTh: 'เปิด–ปิดแผ่นนี้',
    parts: [{ type: 'key', key: '?' }]
  },
  // ---- select ------------------------------------------------------------
  {
    id: 'select-all',
    category: 'select',
    labelTh: 'เลือกทุกฉาก',
    parts: [{ type: 'mod' }, { type: 'key', code: 'KeyA' }]
  },
  {
    id: 'deselect-all',
    category: 'select',
    labelTh: 'ยกเลิกเลือกทั้งหมด',
    parts: [{ type: 'mod' }, { type: 'shift' }, { type: 'key', code: 'KeyA' }]
  },
  {
    id: 'select-range',
    category: 'select',
    labelTh: 'เลือกเป็นช่วง',
    parts: [],
    gesture: true,
    gestureTh: 'Shift+คลิก'
  },
  {
    id: 'select-toggle',
    category: 'select',
    labelTh: 'เลือกเพิ่ม / เอาออกทีละฉาก',
    parts: [],
    gesture: true,
    gestureTh: `${MOD_WORD}+คลิก`
  },
  {
    id: 'marquee',
    category: 'select',
    labelTh: 'ลากกรอบเลือกหลายฉาก',
    parts: [],
    gesture: true,
    gestureTh: 'Shift+ลากพื้นที่ว่าง'
  },
  {
    id: 'escape',
    category: 'select',
    labelTh: 'ยกเลิกการเลือก / ปิดเมนู',
    parts: [{ type: 'key', code: 'Escape' }]
  },
  // ---- edit --------------------------------------------------------------
  {
    id: 'split',
    category: 'edit',
    labelTh: 'แยกฉากที่หัวเล่น',
    parts: [{ type: 'key', code: 'KeyS' }, { type: 'mod' }, { type: 'key', code: 'KeyB' }]
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
    id: 'trim-head',
    category: 'edit',
    labelTh: 'ตัดหัวฉากใต้หัวเล่นถึงหัวเล่น',
    parts: [{ type: 'key', code: 'KeyQ' }]
  },
  {
    id: 'trim-tail',
    category: 'edit',
    labelTh: 'ตัดท้ายฉากใต้หัวเล่นถึงหัวเล่น',
    parts: [{ type: 'key', code: 'KeyW' }]
  },
  {
    id: 'extend-edit',
    category: 'edit',
    labelTh: 'เลื่อนรอยตัดที่โฟกัสไปหัวเล่น',
    parts: [{ type: 'key', code: 'KeyE' }]
  },
  {
    id: 'nudge-edge',
    category: 'edit',
    labelTh: 'ขยับขอบที่โฟกัส 1 เฟรม',
    parts: [
      { type: 'alt' },
      { type: 'key', code: 'ArrowLeft' },
      { type: 'alt' },
      { type: 'key', code: 'ArrowRight' }
    ]
  },
  {
    id: 'nudge-edge-big',
    category: 'edit',
    labelTh: 'ขยับขอบที่โฟกัส 10 เฟรม',
    parts: [
      { type: 'alt' },
      { type: 'shift' },
      { type: 'key', code: 'ArrowLeft' },
      { type: 'alt' },
      { type: 'shift' },
      { type: 'key', code: 'ArrowRight' }
    ]
  },
  {
    id: 'slip-nudge',
    category: 'edit',
    labelTh: 'เลื่อนหน้าต่างฉาก 1 เฟรม',
    parts: [
      { type: 'key', code: 'Comma' },
      { type: 'key', code: 'Period' }
    ]
  },
  {
    id: 'slip-nudge-big',
    category: 'edit',
    labelTh: 'เลื่อนหน้าต่างฉาก 10 เฟรม',
    parts: [
      { type: 'shift' },
      { type: 'key', code: 'Comma' },
      { type: 'shift' },
      { type: 'key', code: 'Period' }
    ]
  },
  {
    id: 'slip-drag',
    category: 'edit',
    labelTh: 'เลื่อนหน้าต่างฉาก (ตัวฉากอยู่ที่เดิม)',
    parts: [],
    gesture: true,
    gestureTh: 'Alt+ลากตัวฉาก'
  },
  {
    id: 'roll-drag',
    category: 'edit',
    labelTh: 'เลื่อนรอยตัดทั้งสองฉาก',
    parts: [],
    gesture: true,
    gestureTh: `${MOD_WORD}+ลากที่จับ`
  },
  {
    id: 'move-scene',
    category: 'edit',
    labelTh: 'ย้ายฉากขึ้น / ลง 1 ตำแหน่ง',
    parts: [
      { type: 'alt' },
      { type: 'key', code: 'ArrowUp' },
      { type: 'alt' },
      { type: 'key', code: 'ArrowDown' }
    ]
  },
  {
    id: 'skip-scene',
    category: 'edit',
    labelTh: 'ข้าม / เลิกข้ามฉาก',
    parts: [{ type: 'key', code: 'KeyD' }]
  },
  {
    id: 'shot-swap',
    category: 'edit',
    labelTh: 'ปรับช็อตของฉากที่เลือก',
    parts: [{ type: 'key', code: 'Enter' }],
    shotSwapOnly: true
  },
  {
    id: 'duplicate',
    category: 'edit',
    labelTh: 'ทำซ้ำฉากที่เลือก',
    parts: [{ type: 'mod' }, { type: 'key', code: 'KeyD' }]
  },
  {
    id: 'copy',
    category: 'edit',
    labelTh: 'คัดลอกฉาก',
    parts: [{ type: 'mod' }, { type: 'key', code: 'KeyC' }]
  },
  {
    id: 'cut',
    category: 'edit',
    labelTh: 'ตัดฉากไปวาง',
    parts: [{ type: 'mod' }, { type: 'key', code: 'KeyX' }]
  },
  {
    id: 'paste',
    category: 'edit',
    labelTh: 'วางฉากหลังหัวเล่น',
    parts: [{ type: 'mod' }, { type: 'key', code: 'KeyV' }]
  },
  {
    id: 'delete',
    category: 'edit',
    labelTh: 'ลบฉากที่เลือก',
    parts: [
      { type: 'key', code: 'Delete' },
      { type: 'key', code: 'Backspace' }
    ]
  },
  {
    id: 'delete-range',
    category: 'edit',
    labelTh: 'ลบช่วง I–O',
    parts: [{ type: 'shift' }, { type: 'key', code: 'Delete' }]
  },
  {
    id: 'undo',
    category: 'edit',
    labelTh: 'เลิกทำ',
    parts: [{ type: 'mod' }, { type: 'key', code: 'KeyZ' }]
  },
  {
    // Ctrl/⌘+Shift+Z has always worked; it was only missing from this table,
    // which is the one place anyone can find out that it does.
    id: 'redo',
    category: 'edit',
    labelTh: 'ทำซ้ำ',
    parts: [
      { type: 'mod' },
      { type: 'shift' },
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
  }
]

export const SHORTCUT_CATEGORY_TITLES: Record<ShortcutCategory, string> = {
  playback: 'เล่น',
  view: 'มุมมอง',
  select: 'เลือก',
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
  if (part.type === 'alt') return IS_MAC ? '⌥' : 'Alt'
  if (part.code === 'Space') return 'Space'
  if (part.code === 'ArrowLeft') return '←'
  if (part.code === 'ArrowRight') return '→'
  if (part.code === 'ArrowUp') return '↑'
  if (part.code === 'ArrowDown') return '↓'
  if (part.code === 'Home') return 'Home'
  if (part.code === 'End') return 'End'
  if (part.code === 'Enter') return 'Enter'
  if (part.code === 'Delete') return 'Del'
  if (part.code === 'Backspace') return '⌫'
  if (part.code === 'Escape') return 'Esc'
  if (part.code === 'BracketLeft') return '['
  if (part.code === 'BracketRight') return ']'
  if (part.code === 'Equal') return '+'
  if (part.code === 'Minus') return '−'
  if (part.code === 'Comma') return ','
  if (part.code === 'Period') return '.'
  if (part.key === '?') return '?'
  if (part.code?.startsWith('Key')) return part.code.slice(3)
  if (part.code?.startsWith('Digit')) return part.code.slice(5)
  return part.key?.toUpperCase() ?? part.code ?? ''
}

/**
 * The chords of a def: a run of modifiers followed by one key is a chord; the
 * part after a key starts the next one. Shared by the formatter (which prints
 * the chords space-separated) and the matcher (which accepts any of them).
 */
function chordGroups(parts: readonly ShortcutKeyPart[]): ShortcutKeyPart[][] {
  const groups: ShortcutKeyPart[][] = []
  for (const p of parts) {
    const last = groups[groups.length - 1]
    // A new group starts on a modifier that follows a finished chord, or on a
    // second plain key.
    if (!last || last.some((q) => q.type === 'key')) groups.push([p])
    else last.push(p)
  }
  return groups
}

/**
 * A shortcut's keys as one string.
 *
 * Modifier+key is a chord and joins tight ("⌘Z" / "Ctrl+Z"); a second key after
 * a complete chord is an ALTERNATIVE ("← →", "Home End", "⌘Z ⌘Y") and is space
 * separated, or the sheet reads "Home+End" as if both were pressed together.
 */
export function formatShortcut(parts: readonly ShortcutKeyPart[]): string {
  return chordGroups(parts)
    .map((g) => {
      const bits = g.map(formatKeyPart)
      return IS_MAC ? bits.join('') : bits.join('+')
    })
    .join(' ')
}

function findDef(id: string): ShortcutDisplayDef | undefined {
  return SHORTCUT_DISPLAY.find((s) => s.id === id)
}

/** The key parts of a shortcut (empty for a gesture). */
export function shortcutParts(id: ShortcutId): ShortcutKeyPart[] {
  return findDef(id)?.parts ?? []
}

/** The printable keys of a shortcut, or the gesture text for a gesture row. */
export function shortcutText(id: ShortcutId): string {
  const def = findDef(id)
  if (!def) return ''
  return def.gesture ? (def.gestureTh ?? '') : formatShortcut(def.parts)
}

export function withShortcut(label: string, id: string): string {
  const def = findDef(id)
  if (!def) return label
  const keys = def.gesture ? def.gestureTh : formatShortcut(def.parts)
  return keys ? `${label} (${keys})` : label
}

/** The magnet button's tooltip — what it snaps to depends on whether the
 * project has a beat grid; the toggle itself never does. */
export function snapTitle(beatCount: number): string {
  const what = 'ดูดขอบฉาก หัวเล่น ประโยคพากย์' + (beatCount > 0 ? ' และจังหวะเพลง' : '')
  return withShortcut(what, 'snap-toggle') + ' · กด Alt ค้างเพื่อปิดชั่วคราว'
}

/** Does `e` press exactly this ONE chord (modifiers must match exactly)? */
export function matchesShortcutParts(e: KeyboardEvent, parts: readonly ShortcutKeyPart[]): boolean {
  const needsMod = parts.some((p) => p.type === 'mod')
  const needsShift = parts.some((p) => p.type === 'shift')
  const needsAlt = parts.some((p) => p.type === 'alt')
  if (needsMod !== modKey(e)) return false
  if (needsShift !== e.shiftKey) return false
  if (needsAlt !== e.altKey) return false
  // The platform's other command key held is a different chord (or the
  // browser's own), never this one.
  if (!needsMod && (e.metaKey || e.ctrlKey)) return false
  const keyPart = parts.find((p) => p.type === 'key')
  if (!keyPart) return false
  if (keyPart.code && e.code === keyPart.code) return true
  if (keyPart.key === '?' && (e.key === '?' || (e.code === 'Slash' && e.shiftKey))) return true
  return false
}

/**
 * Does `e` press the shortcut `id`? A def may list several chords (split is
 * S or ⌘B; redo is ⌘⇧Z or ⌘Y) and any of them counts. A gesture row never
 * matches a key.
 */
export function matchesShortcut(e: KeyboardEvent, id: ShortcutId): boolean {
  const def = findDef(id)
  if (!def || def.gesture) return false
  return chordGroups(def.parts).some((chord) => matchesShortcutParts(e, chord))
}
