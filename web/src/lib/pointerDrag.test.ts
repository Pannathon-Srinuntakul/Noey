import { describe, expect, it, vi, type Mock } from 'vitest'
import {
  NO_SCROLLER,
  bindPointerDrag,
  type DragFrame,
  type DragScroller,
  type DragWindow
} from './pointerDrag'

type Listener = (ev: unknown) => void

/** A window that records listeners and lets a test fire events and frames by hand. */
class FakeWindow {
  listeners: { type: string; fn: Listener; capture: boolean }[] = []
  private frames = new Map<number, FrameRequestCallback>()
  private nextId = 1

  addEventListener(type: string, fn: Listener, opts?: boolean | AddEventListenerOptions): void {
    const capture = typeof opts === 'boolean' ? opts : opts?.capture === true
    this.listeners.push({ type, fn, capture })
  }

  removeEventListener(type: string, fn: Listener, opts?: boolean | AddEventListenerOptions): void {
    const capture = typeof opts === 'boolean' ? opts : opts?.capture === true
    this.listeners = this.listeners.filter(
      (l) => !(l.type === type && l.fn === fn && l.capture === capture)
    )
  }

  requestAnimationFrame(cb: FrameRequestCallback): number {
    const id = this.nextId++
    this.frames.set(id, cb)
    return id
  }

  cancelAnimationFrame(id: number): void {
    this.frames.delete(id)
  }

  /** Dispatch to every listener of `type` (capture listeners first). */
  fire(type: string, ev: Record<string, unknown> = {}): void {
    const full = { preventDefault: vi.fn(), stopPropagation: vi.fn(), ...ev }
    const ls = [...this.listeners].sort((a, b) => Number(b.capture) - Number(a.capture))
    for (const l of ls) if (l.type === type) l.fn(full)
  }

  /** Run every pending animation frame once. */
  runFrame(): void {
    const pending = [...this.frames.entries()]
    this.frames.clear()
    for (const [, cb] of pending) cb(16)
  }

  get pendingFrames(): number {
    return this.frames.size
  }

  as(): DragWindow {
    return this as unknown as DragWindow
  }
}

const pointer = (
  clientX: number,
  over: Partial<Pick<DragFrame, 'altKey' | 'shiftKey' | 'metaKey' | 'ctrlKey'>> = {}
): Record<string, unknown> => ({
  clientX,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  ...over
})

interface StartEvent {
  clientX: number
  stopPropagation: Mock<() => void>
  preventDefault: Mock<() => void>
}

const startEvent = (clientX = 100): StartEvent => ({
  clientX,
  stopPropagation: vi.fn<() => void>(),
  preventDefault: vi.fn<() => void>()
})

function bind(
  win: FakeWindow,
  over: Partial<Parameters<typeof bindPointerDrag>[0]> = {}
): {
  frames: DragFrame[]
  ends: { cancelled: boolean }[]
  cancel: () => void
  e: StartEvent
} {
  const frames: DragFrame[] = []
  const ends: { cancelled: boolean }[] = []
  const e = startEvent()
  const cancel = bindPointerDrag({
    e,
    pxPerSec: 40,
    onFrame: (f) => frames.push(f),
    onEnd: (r) => ends.push(r),
    win: win.as(),
    ...over
  })
  return { frames, ends, cancel, e }
}

describe('bindPointerDrag', () => {
  it('swallows the pointerdown and attaches window listeners', () => {
    const win = new FakeWindow()
    const onStart = vi.fn()
    const { e } = bind(win, { onStart })
    expect(e.stopPropagation).toHaveBeenCalled()
    expect(e.preventDefault).toHaveBeenCalled()
    expect(onStart).toHaveBeenCalledTimes(1)
    const types = win.listeners.map((l) => l.type).sort()
    expect(types).toEqual(['keydown', 'keyup', 'pointercancel', 'pointermove', 'pointerup'])
    expect(win.listeners.find((l) => l.type === 'keydown')?.capture).toBe(true)
  })

  it('coalesces several moves into one frame with the last x', () => {
    const win = new FakeWindow()
    const { frames } = bind(win)
    win.fire('pointermove', pointer(110))
    win.fire('pointermove', pointer(124))
    expect(frames).toHaveLength(0)
    expect(win.pendingFrames).toBe(1)
    win.runFrame()
    expect(frames).toHaveLength(1)
    expect(frames[0].clientX).toBe(124)
    expect(frames[0].deltaPx).toBe(24)
    expect(frames[0].deltaSec).toBeCloseTo(24 / 40, 10)
    expect(frames[0]).toMatchObject({
      altKey: false,
      shiftKey: false,
      metaKey: false,
      ctrlKey: false
    })
  })

  it('pointerup flushes the pending frame before onEnd and removes every listener', () => {
    const win = new FakeWindow()
    const order: string[] = []
    const { frames, ends } = bind(win, {
      onFrame: () => order.push('frame'),
      onEnd: () => order.push('end')
    })
    win.fire('pointermove', pointer(130))
    win.fire('pointerup', pointer(130))
    expect(order).toEqual(['frame', 'end'])
    expect(frames).toHaveLength(0) // overridden onFrame above
    expect(ends).toHaveLength(0)
    expect(win.listeners).toHaveLength(0)
    expect(win.pendingFrames).toBe(0)
  })

  it('pointerup reports cancelled: false and uses the up position', () => {
    const win = new FakeWindow()
    const { frames, ends } = bind(win)
    win.fire('pointermove', pointer(130))
    win.fire('pointerup', pointer(132))
    expect(frames).toHaveLength(1)
    expect(frames[0].clientX).toBe(132)
    expect(ends).toEqual([{ cancelled: false }])
  })

  it('pointercancel ends the drag too', () => {
    const win = new FakeWindow()
    const { ends } = bind(win)
    win.fire('pointercancel')
    expect(ends).toEqual([{ cancelled: false }])
    expect(win.listeners).toHaveLength(0)
  })

  it('Escape cancels: no final frame, onEnd(true), listeners removed, event stopped', () => {
    const win = new FakeWindow()
    const { frames, ends } = bind(win)
    win.fire('pointermove', pointer(150))
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()
    win.fire('keydown', { key: 'Escape', preventDefault, stopPropagation })
    expect(frames).toHaveLength(0)
    expect(ends).toEqual([{ cancelled: true }])
    expect(win.listeners).toHaveLength(0)
    expect(win.pendingFrames).toBe(0)
    expect(preventDefault).toHaveBeenCalled()
    expect(stopPropagation).toHaveBeenCalled()
  })

  it('Alt keydown is preventDefault-ed and runs an immediate frame with altKey true', () => {
    const win = new FakeWindow()
    const { frames } = bind(win)
    win.fire('pointermove', pointer(120))
    win.runFrame()
    expect(frames[0].altKey).toBe(false)
    const preventDefault = vi.fn()
    win.fire('keydown', { key: 'Alt', preventDefault })
    expect(preventDefault).toHaveBeenCalled()
    expect(frames).toHaveLength(2)
    expect(frames[1].altKey).toBe(true)
    expect(frames[1].clientX).toBe(120)
    // A repeat keydown (OS auto-repeat) does not spam frames.
    win.fire('keydown', { key: 'Alt', preventDefault })
    expect(frames).toHaveLength(2)
    win.fire('keyup', { key: 'Alt' })
    expect(frames).toHaveLength(3)
    expect(frames[2].altKey).toBe(false)
  })

  it('modifier flags come from the latest pointer or key event', () => {
    const win = new FakeWindow()
    const { frames } = bind(win)
    win.fire('pointermove', pointer(120, { shiftKey: true }))
    win.runFrame()
    expect(frames[0].shiftKey).toBe(true)
    win.fire('keydown', { key: 'Meta' })
    expect(frames[1].metaKey).toBe(true)
    expect(frames[1].shiftKey).toBe(true)
    win.fire('pointermove', pointer(121, { shiftKey: false, metaKey: false }))
    win.runFrame()
    expect(frames[2].shiftKey).toBe(false)
    expect(frames[2].metaKey).toBe(false)
  })

  it('carries the modifiers held at pointerdown into the first frame', () => {
    const win = new FakeWindow()
    const { frames } = bind(win, { e: { ...startEvent(), metaKey: true } })
    win.fire('pointermove', pointer(120, { metaKey: true }))
    win.runFrame()
    expect(frames[0].metaKey).toBe(true)
  })

  it('adds the scroll the lane did during the drag to deltaPx', () => {
    const win = new FakeWindow()
    let scroll = 100
    const scroller: DragScroller = {
      begin: vi.fn(),
      tick: vi.fn(() => {
        scroll += 30
      }),
      end: vi.fn(),
      scrollLeft: () => scroll
    }
    const { frames, ends } = bind(win, { scroller })
    expect(scroller.begin).toHaveBeenCalledTimes(1)
    win.fire('pointermove', pointer(110))
    win.runFrame()
    expect(scroller.tick).toHaveBeenCalledWith(110)
    expect(frames[0].deltaPx).toBe(10 + 30)
    expect(frames[0].deltaSec).toBeCloseTo(40 / 40, 10)
    win.fire('pointerup', pointer(110))
    expect(ends).toHaveLength(1)
    expect(scroller.end).toHaveBeenCalledTimes(1)
  })

  it('NO_SCROLLER contributes nothing', () => {
    expect(NO_SCROLLER.scrollLeft()).toBe(0)
    expect(() => {
      NO_SCROLLER.begin()
      NO_SCROLLER.tick(5)
      NO_SCROLLER.end()
    }).not.toThrow()
  })

  it('cancel() detaches everything and ends as a cancel, once', () => {
    const win = new FakeWindow()
    const { frames, ends, cancel } = bind(win)
    win.fire('pointermove', pointer(140))
    cancel()
    expect(frames).toHaveLength(0)
    expect(ends).toEqual([{ cancelled: true }])
    expect(win.listeners).toHaveLength(0)
    expect(win.pendingFrames).toBe(0)
    cancel()
    win.fire('pointerup', pointer(140))
    expect(ends).toHaveLength(1)
  })

  it('a click with no move ends without a frame', () => {
    const win = new FakeWindow()
    const { frames, ends } = bind(win)
    win.fire('pointerup', pointer(100))
    expect(frames).toHaveLength(0)
    expect(ends).toEqual([{ cancelled: false }])
  })
})
