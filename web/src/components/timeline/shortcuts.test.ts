/**
 * The shortcut table is read by people (the ? sheet, every toolbar tooltip)
 * and matched against real key events, so both directions are pinned here.
 *
 * Vitest runs in node: events are plain objects cast to KeyboardEvent, and
 * IS_MAC follows whatever machine runs the suite, so expectations that depend
 * on the platform say so instead of assuming one.
 */
import { describe, expect, it } from 'vitest'
import {
  IS_MAC,
  SHORTCUT_DISPLAY,
  formatShortcut,
  matchesShortcut,
  matchesShortcutParts,
  shortcutParts,
  shortcutText,
  snapTitle,
  withShortcut,
  type ShortcutId,
  type ShortcutKeyPart
} from './shortcuts'

function partsOf(id: ShortcutId): ShortcutKeyPart[] {
  const def = SHORTCUT_DISPLAY.find((s) => s.id === id)
  if (!def) throw new Error(`no shortcut '${id}' in SHORTCUT_DISPLAY`)
  return def.parts
}

type KeyInit = Partial<
  Pick<KeyboardEvent, 'key' | 'code' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey'>
>

/** A keydown with every modifier up unless the test holds one. */
function keydown(init: KeyInit): KeyboardEvent {
  return {
    key: '',
    code: '',
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...init
  } as KeyboardEvent
}

/** The platform's command key, held. */
const MOD: KeyInit = IS_MAC ? { metaKey: true } : { ctrlKey: true }

/** Split a def's parts into its chords the way the formatter groups them. */
function chordsOf(parts: ShortcutKeyPart[]): ShortcutKeyPart[][] {
  const groups: ShortcutKeyPart[][] = []
  for (const p of parts) {
    const last = groups[groups.length - 1]
    if (!last || last.some((q) => q.type === 'key')) groups.push([p])
    else last.push(p)
  }
  return groups
}

/** The keydown that presses exactly one chord. */
function eventFor(chord: ShortcutKeyPart[]): KeyboardEvent {
  const keyPart = chord.find((p) => p.type === 'key')
  const hasMod = chord.some((p) => p.type === 'mod')
  return keydown({
    code: keyPart?.code ?? '',
    key: keyPart?.key ?? '',
    shiftKey: chord.some((p) => p.type === 'shift'),
    altKey: chord.some((p) => p.type === 'alt'),
    metaKey: IS_MAC && hasMod,
    ctrlKey: !IS_MAC && hasMod
  })
}

describe('formatShortcut', () => {
  it('separates alternatives with a space', () => {
    // "Home+End" would read as both keys pressed together.
    expect(formatShortcut(partsOf('home'))).toBe('Home End')
    expect(formatShortcut(partsOf('frame-back'))).toBe('← →')
  })

  it('writes a chord tight and starts a new chord after a finished one', () => {
    expect(formatShortcut(partsOf('undo'))).toBe(IS_MAC ? '⌘Z' : 'Ctrl+Z')
    // Redo has two alternatives, and the first is a three-key chord.
    expect(formatShortcut(partsOf('redo'))).toBe(IS_MAC ? '⌘⇧Z ⌘Y' : 'Ctrl+Shift+Z Ctrl+Y')
    expect(formatShortcut(partsOf('split'))).toBe(IS_MAC ? 'S ⌘B' : 'S Ctrl+B')
  })

  it('draws the shot and shuttle keys as alternatives, not as a chord', () => {
    expect(formatShortcut(partsOf('cut-prev'))).toBe('↑ ↓')
    expect(formatShortcut(partsOf('shuttle'))).toBe('J K L')
    expect(formatShortcut(partsOf('zoom'))).toBe('+ −')
  })

  it('prints the alt part per platform', () => {
    expect(formatShortcut(partsOf('nudge-edge'))).toBe(IS_MAC ? '⌥← ⌥→' : 'Alt+← Alt+→')
    expect(formatShortcut(partsOf('range-clear'))).toBe(IS_MAC ? '⌥X' : 'Alt+X')
    expect(formatShortcut(partsOf('nudge-edge-big'))).toBe(
      IS_MAC ? '⌥⇧← ⌥⇧→' : 'Alt+Shift+← Alt+Shift+→'
    )
  })

  it('formats every id without throwing, and a gesture prints its own text', () => {
    for (const def of SHORTCUT_DISPLAY) {
      expect(() => formatShortcut(def.parts)).not.toThrow()
      const text = shortcutText(def.id)
      expect(text.length, `'${def.id}' has no printable keys`).toBeGreaterThan(0)
      if (def.gesture) {
        expect(def.parts).toEqual([])
        expect(text).toBe(def.gestureTh)
      }
    }
    expect(shortcutParts('snap-suppress')).toEqual([])
  })
})

describe('withShortcut', () => {
  it('appends the keys to a tooltip, and leaves an unknown id alone', () => {
    expect(withShortcut('แยกฉาก', 'split')).toBe(IS_MAC ? 'แยกฉาก (S ⌘B)' : 'แยกฉาก (S Ctrl+B)')
    expect(withShortcut('แยกฉาก', 'no-such-shortcut')).toBe('แยกฉาก')
  })

  it('appends the gesture text for a gesture row', () => {
    expect(withShortcut('ปิดดูดชั่วคราว', 'snap-suppress')).toBe('ปิดดูดชั่วคราว (Alt ค้างขณะลาก)')
  })
})

describe('snapTitle', () => {
  it('names the beat grid only when the project has one', () => {
    const shiftN = IS_MAC ? '⇧N' : 'Shift+N'
    expect(snapTitle(0)).toBe(
      `ดูดขอบฉาก หัวเล่น ประโยคพากย์ (${shiftN}) · กด Alt ค้างเพื่อปิดชั่วคราว`
    )
    expect(snapTitle(12)).toBe(
      `ดูดขอบฉาก หัวเล่น ประโยคพากย์ และจังหวะเพลง (${shiftN}) · กด Alt ค้างเพื่อปิดชั่วคราว`
    )
  })
})

describe('matchesShortcutParts', () => {
  it('rejects a plain key while Ctrl, Meta or Alt is held', () => {
    const split: ShortcutKeyPart[] = [{ type: 'key', code: 'KeyS' }]
    expect(matchesShortcutParts(keydown({ code: 'KeyS' }), split)).toBe(true)
    expect(matchesShortcutParts(keydown({ code: 'KeyS', ctrlKey: true }), split)).toBe(false)
    expect(matchesShortcutParts(keydown({ code: 'KeyS', metaKey: true }), split)).toBe(false)
    expect(matchesShortcutParts(keydown({ code: 'KeyS', altKey: true }), split)).toBe(false)
  })

  it('requires Shift for a shift part, and refuses it for a part without one', () => {
    const jump: ShortcutKeyPart[] = [{ type: 'shift' }, { type: 'key', code: 'ArrowLeft' }]
    const nudge: ShortcutKeyPart[] = [{ type: 'key', code: 'ArrowLeft' }]
    expect(matchesShortcutParts(keydown({ code: 'ArrowLeft', shiftKey: true }), jump)).toBe(true)
    expect(matchesShortcutParts(keydown({ code: 'ArrowLeft' }), jump)).toBe(false)
    expect(matchesShortcutParts(keydown({ code: 'ArrowLeft', shiftKey: true }), nudge)).toBe(false)
  })

  it('requires Alt for an alt part, and refuses it for a part without one', () => {
    const alt: ShortcutKeyPart[] = [{ type: 'alt' }, { type: 'key', code: 'ArrowLeft' }]
    const plain: ShortcutKeyPart[] = [{ type: 'key', code: 'ArrowLeft' }]
    expect(matchesShortcutParts(keydown({ code: 'ArrowLeft', altKey: true }), alt)).toBe(true)
    expect(matchesShortcutParts(keydown({ code: 'ArrowLeft' }), alt)).toBe(false)
    expect(matchesShortcutParts(keydown({ code: 'ArrowLeft', altKey: true }), plain)).toBe(false)
    // Alt+Shift is the big nudge, never the small one.
    expect(
      matchesShortcutParts(keydown({ code: 'ArrowLeft', altKey: true, shiftKey: true }), alt)
    ).toBe(false)
  })

  it("matches the '?' part from Shift+Slash", () => {
    const help: ShortcutKeyPart[] = [{ type: 'shift' }, { type: 'key', key: '?' }]
    const usLayout = keydown({ code: 'Slash', key: '?', shiftKey: true })
    // A layout that puts another character on that key still reports its code.
    const otherLayout = keydown({ code: 'Slash', key: '_', shiftKey: true })
    expect(matchesShortcutParts(usLayout, help)).toBe(true)
    expect(matchesShortcutParts(otherLayout, help)).toBe(true)
  })

  it("does not match the sheet's own '?' entry, which has no shift part", () => {
    // The Shift state must match exactly, and '?' always takes Shift — which
    // is why the editor's keydown handler recognises '?' itself instead of
    // going through this entry.
    const shiftSlash = keydown({ code: 'Slash', key: '?', shiftKey: true })
    expect(matchesShortcutParts(shiftSlash, partsOf('shortcuts-help'))).toBe(false)
  })
})

describe('matchesShortcut', () => {
  it('accepts any of a def’s alternative chords', () => {
    expect(matchesShortcut(keydown({ code: 'KeyS' }), 'split')).toBe(true)
    expect(matchesShortcut(keydown({ code: 'KeyB', ...MOD }), 'split')).toBe(true)
    expect(matchesShortcut(keydown({ code: 'KeyB' }), 'split')).toBe(false)
    expect(matchesShortcut(keydown({ code: 'KeyZ', shiftKey: true, ...MOD }), 'redo')).toBe(true)
    expect(matchesShortcut(keydown({ code: 'KeyY', ...MOD }), 'redo')).toBe(true)
    expect(matchesShortcut(keydown({ code: 'Backspace' }), 'delete')).toBe(true)
  })

  it('keeps ⌘A and ⌘⇧A apart', () => {
    expect(matchesShortcut(keydown({ code: 'KeyA', ...MOD }), 'select-all')).toBe(true)
    expect(matchesShortcut(keydown({ code: 'KeyA', shiftKey: true, ...MOD }), 'select-all')).toBe(
      false
    )
    expect(matchesShortcut(keydown({ code: 'KeyA', shiftKey: true, ...MOD }), 'deselect-all')).toBe(
      true
    )
  })

  it('keeps Shift+N (snap toggle) apart from N (add scene)', () => {
    const shiftN = keydown({ code: 'KeyN', shiftKey: true })
    expect(matchesShortcut(shiftN, 'snap-toggle')).toBe(true)
    expect(matchesShortcut(shiftN, 'add-scene')).toBe(false)
    expect(matchesShortcut(keydown({ code: 'KeyN' }), 'add-scene')).toBe(true)
    expect(matchesShortcut(keydown({ code: 'KeyN' }), 'snap-toggle')).toBe(false)
  })

  it('never matches a gesture row', () => {
    expect(matchesShortcut(keydown({ code: 'KeyS', shiftKey: true }), 'marquee')).toBe(false)
    expect(matchesShortcut(keydown({ altKey: true, code: 'AltLeft' }), 'snap-suppress')).toBe(false)
  })

  it('binds every chord to exactly one id — the conflict guard', () => {
    const keyed = SHORTCUT_DISPLAY.filter((d) => !d.gesture)
    for (const def of keyed) {
      for (const chord of chordsOf(def.parts)) {
        const e = eventFor(chord)
        const owners = keyed.filter((other) => matchesShortcut(e, other.id)).map((o) => o.id)
        expect(owners, `${formatShortcut(chord)} is bound more than once`).toEqual([def.id])
      }
    }
  })

  it('lists every id once', () => {
    const ids = SHORTCUT_DISPLAY.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
