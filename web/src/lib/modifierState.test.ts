import { describe, expect, it } from 'vitest'
import { createModifierTracker } from './modifierState'

type Listener = (ev: unknown) => void

class FakeWindow {
  listeners: { type: string; fn: Listener }[] = []

  addEventListener(type: string, fn: Listener): void {
    this.listeners.push({ type, fn })
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn))
  }

  fire(type: string, ev: Record<string, unknown> = {}): void {
    for (const l of [...this.listeners]) if (l.type === type) l.fn(ev)
  }

  as(): Pick<Window, 'addEventListener' | 'removeEventListener'> {
    return this as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'>
  }
}

describe('createModifierTracker', () => {
  it('starts with nothing held and listens for keydown, keyup and blur', () => {
    const win = new FakeWindow()
    const tracker = createModifierTracker(win.as())
    expect(tracker.isAltHeld()).toBe(false)
    expect(tracker.isShiftHeld()).toBe(false)
    expect(win.listeners.map((l) => l.type).sort()).toEqual(['blur', 'keydown', 'keyup'])
  })

  it('tracks Alt down and up', () => {
    const win = new FakeWindow()
    const tracker = createModifierTracker(win.as())
    win.fire('keydown', { key: 'Alt' })
    expect(tracker.isAltHeld()).toBe(true)
    expect(tracker.isShiftHeld()).toBe(false)
    win.fire('keyup', { key: 'Alt' })
    expect(tracker.isAltHeld()).toBe(false)
  })

  it('tracks Shift independently and ignores other keys', () => {
    const win = new FakeWindow()
    const tracker = createModifierTracker(win.as())
    win.fire('keydown', { key: 'Shift' })
    win.fire('keydown', { key: 'n' })
    expect(tracker.isShiftHeld()).toBe(true)
    expect(tracker.isAltHeld()).toBe(false)
    win.fire('keyup', { key: 'n' })
    expect(tracker.isShiftHeld()).toBe(true)
    win.fire('keyup', { key: 'Shift' })
    expect(tracker.isShiftHeld()).toBe(false)
  })

  it('blur resets both so a key released over another window is not stuck', () => {
    const win = new FakeWindow()
    const tracker = createModifierTracker(win.as())
    win.fire('keydown', { key: 'Alt' })
    win.fire('keydown', { key: 'Shift' })
    win.fire('blur')
    expect(tracker.isAltHeld()).toBe(false)
    expect(tracker.isShiftHeld()).toBe(false)
  })

  it('dispose removes all three listeners', () => {
    const win = new FakeWindow()
    const tracker = createModifierTracker(win.as())
    tracker.dispose()
    expect(win.listeners).toHaveLength(0)
    win.fire('keydown', { key: 'Alt' })
    expect(tracker.isAltHeld()).toBe(false)
  })
})
