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
  matchesShortcutParts,
  withShortcut,
  type ShortcutKeyPart
} from './shortcuts'

function partsOf(id: string): ShortcutKeyPart[] {
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

describe('formatShortcut', () => {
  it('separates alternatives with a space', () => {
    // "Home+End" would read as both keys pressed together.
    expect(formatShortcut(partsOf('home'))).toBe('Home End')
    expect(formatShortcut(partsOf('frame-back'))).toBe('← →')
  })

  it('writes a chord tight and starts a new chord after a finished one', () => {
    expect(formatShortcut(partsOf('undo'))).toBe(IS_MAC ? '⌘Z ⌘Y' : 'Ctrl+Z Ctrl+Y')
  })
})

describe('withShortcut', () => {
  it('appends the keys to a tooltip, and leaves an unknown id alone', () => {
    expect(withShortcut('แยกฉาก', 'split')).toBe('แยกฉาก (S)')
    expect(withShortcut('แยกฉาก', 'no-such-shortcut')).toBe('แยกฉาก')
  })
})

describe('matchesShortcutParts', () => {
  it('rejects a plain key while Ctrl, Meta or Alt is held', () => {
    const split = partsOf('split')
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
