import { describe, expect, it } from 'vitest'
import { cycleTab, enterConfirms, FOCUSABLE } from './focusTrap'

/** Enough of an Element for the two functions: a tag and a selector match. */
function el(tagName: string, attrs: Record<string, string> = {}): Element {
  return {
    tagName,
    matches: (selector: string) =>
      selector
        .split(',')
        .map((s) => s.trim())
        .some((s) => {
          if (s === tagName.toLowerCase()) return true
          const m = /^\[(\w+)="?([^"\]]*)"?\]$/.exec(s)
          return !!m && attrs[m[1]] === m[2]
        })
  } as unknown as Element
}

describe('enterConfirms', () => {
  it('confirms from an input, a select and the panel itself', () => {
    expect(enterConfirms(el('INPUT'))).toBe(true)
    expect(enterConfirms(el('SELECT'))).toBe(true)
    expect(enterConfirms(el('DIV'))).toBe(true)
  })

  it('never from a textarea (Enter is a newline there)', () => {
    expect(enterConfirms(el('TEXTAREA'))).toBe(false)
  })

  it('never from a button, a link or a role=button — they act on Enter themselves', () => {
    // The cancel button of a destructive confirm: Enter must NOT delete.
    expect(enterConfirms(el('BUTTON'))).toBe(false)
    expect(enterConfirms(el('A'))).toBe(false)
    expect(enterConfirms(el('DIV', { role: 'button' }))).toBe(false)
  })

  it('treats no target (the document) as confirmable', () => {
    expect(enterConfirms(null)).toBe(true)
    expect(enterConfirms({} as EventTarget)).toBe(true)
  })
})

describe('the focus-trap selector', () => {
  it('skips disabled controls', () => {
    for (const tag of ['button', 'input', 'select', 'textarea']) {
      expect(FOCUSABLE).toContain(`${tag}:not([disabled])`)
    }
    expect(FOCUSABLE).toContain('[tabindex]:not([tabindex="-1"])')
  })
})

describe('cycleTab', () => {
  function panelWith(items: object[]): {
    panel: HTMLElement
    focused: () => object | null
    setActive: (o: object | null) => void
  } {
    let active: object | null = null
    const focusables = items.map((o) => ({ ...o, focus: () => (active = o) }))
    const panel = {
      querySelectorAll: () => focusables,
      focus: () => (active = panel)
    } as unknown as HTMLElement
    // `document.activeElement` is what the trap reads.
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        get activeElement() {
          return active
        }
      }
    })
    return {
      panel,
      focused: () => active,
      setActive: (o) => {
        active = o
      }
    }
  }
  const key = (shiftKey: boolean): KeyboardEvent & { prevented: boolean } => {
    const e = { shiftKey, prevented: false, preventDefault: () => undefined } as KeyboardEvent & {
      prevented: boolean
    }
    e.preventDefault = () => {
      e.prevented = true
    }
    return e
  }

  it('wraps forward from the last to the first, and back from the first to the last', () => {
    const t = panelWith([{ id: 'a' }, { id: 'b' }])
    const [a, b] = (t.panel.querySelectorAll('') as unknown as { id: string }[]).map((x) => x)
    t.setActive(b)
    const fwd = key(false)
    cycleTab(t.panel, fwd)
    expect(fwd.prevented).toBe(true)
    expect((t.focused() as { id: string }).id).toBe('a')
    t.setActive(a)
    const back = key(true)
    cycleTab(t.panel, back)
    expect(back.prevented).toBe(true)
    expect((t.focused() as { id: string }).id).toBe('b')
  })

  it('leaves a Tab in the middle to the browser', () => {
    const t = panelWith([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    const [, b] = t.panel.querySelectorAll('') as unknown as object[]
    t.setActive(b)
    const e = key(false)
    cycleTab(t.panel, e)
    expect(e.prevented).toBe(false)
  })

  it('keeps focus on an empty panel', () => {
    const t = panelWith([])
    const e = key(false)
    cycleTab(t.panel, e)
    expect(e.prevented).toBe(true)
    expect(t.focused()).toBe(t.panel)
  })
})
