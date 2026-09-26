/**
 * The ONE window-level drag loop for the timeline editor (editor-standard
 * pass, 2026-09-27). Trim handles, the music block, caption edges, markers and
 * the scrub all bind through here instead of each keeping its own copy of the
 * pointermove/pointerup dance.
 *
 * Proven behaviour kept from the copies it replaces:
 *  - ONE `onFrame` per animation frame with the NEWEST pointer position — a
 *    trackpad or a 120 Hz display delivers several moves per frame and every
 *    frame re-renders the editor, so the drag lagged the pointer (live report
 *    2026-09-21).
 *  - The last pending frame is flushed on pointerup BEFORE `onEnd`, so the
 *    commit sees the final value.
 *  - Listeners are removed on pointerup AND pointercancel.
 *
 * Added:
 *  - Escape cancels: `onEnd({ cancelled: true })` with NO final frame — the
 *    caller restores its own start values. The keydown is caught in the
 *    capture phase and stopped so the editor's global Escape (close) never
 *    sees it.
 *  - Alt keydown mid-drag is preventDefault'ed (Windows would move focus to
 *    the menu bar) and re-runs a frame with `altKey: true` immediately, keyup
 *    with false, so snap suppression toggles without moving the mouse. The
 *    other modifiers are tracked the same way; flags always come from the
 *    latest pointer OR key event.
 *  - An optional `DragScroller` (the viewport hook's edge auto-scroll):
 *    `begin()` on start, `tick(clientX)` before every frame, `end()` after
 *    `onEnd`. `deltaPx` includes the scroll the lane did meanwhile so a drag
 *    that scrolled the lane stays under the pointer.
 */

export interface DragWindow {
  addEventListener: Window['addEventListener']
  removeEventListener: Window['removeEventListener']
  requestAnimationFrame(cb: FrameRequestCallback): number
  cancelAnimationFrame(id: number): void
}

export interface DragScroller {
  begin(): void
  /** Called before every frame with the latest pointer x; may scroll the lane. */
  tick(clientX: number): void
  end(): void
  scrollLeft(): number
}

/** A scroller that never scrolls — the default, and the one tests use. */
export const NO_SCROLLER: DragScroller = {
  begin: () => {},
  tick: () => {},
  end: () => {},
  scrollLeft: () => 0
}

export interface DragFrame {
  deltaSec: number
  deltaPx: number
  clientX: number
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
}

export interface DragStartEvent {
  clientX: number
  stopPropagation(): void
  preventDefault(): void
  altKey?: boolean
  shiftKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
}

export interface BindPointerDragOptions {
  e: DragStartEvent
  pxPerSec: number
  scroller?: DragScroller
  onStart?(): void
  onFrame(f: DragFrame): void
  onEnd(r: { cancelled: boolean }): void
  /** Defaults to `window`; exists ONLY so a test can inject a fake. */
  win?: DragWindow
}

type Mods = Pick<DragFrame, 'altKey' | 'shiftKey' | 'metaKey' | 'ctrlKey'>

const MOD_KEYS: Record<string, keyof Mods> = {
  Alt: 'altKey',
  Shift: 'shiftKey',
  Meta: 'metaKey',
  Control: 'ctrlKey'
}

/**
 * Start a drag from a pointerdown. Returns `cancel()`, which ends the drag as
 * Escape would (no final frame, `onEnd({ cancelled: true })`) and detaches
 * everything — for a component unmounting mid-drag. Calling it after the drag
 * has ended is a no-op.
 */
export function bindPointerDrag(opts: BindPointerDragOptions): () => void {
  const { e, pxPerSec, scroller = NO_SCROLLER, onFrame, onEnd } = opts
  const win: DragWindow = opts.win ?? window
  e.stopPropagation()
  e.preventDefault()

  scroller.begin()
  opts.onStart?.()

  const startX = e.clientX
  const scrollLeftAtStart = scroller.scrollLeft()
  let lastX = startX
  const mods: Mods = {
    altKey: e.altKey === true,
    shiftKey: e.shiftKey === true,
    metaKey: e.metaKey === true,
    ctrlKey: e.ctrlKey === true
  }
  let frame = 0
  let done = false

  function readMods(ev: Mods): void {
    mods.altKey = ev.altKey
    mods.shiftKey = ev.shiftKey
    mods.metaKey = ev.metaKey
    mods.ctrlKey = ev.ctrlKey
  }

  function apply(): void {
    frame = 0
    scroller.tick(lastX)
    const deltaPx = lastX - startX + (scroller.scrollLeft() - scrollLeftAtStart)
    onFrame({
      deltaSec: pxPerSec > 0 ? deltaPx / pxPerSec : 0,
      deltaPx,
      clientX: lastX,
      altKey: mods.altKey,
      shiftKey: mods.shiftKey,
      metaKey: mods.metaKey,
      ctrlKey: mods.ctrlKey
    })
  }

  function schedule(): void {
    if (!frame) frame = win.requestAnimationFrame(apply)
  }

  function dropPending(): void {
    if (frame) {
      win.cancelAnimationFrame(frame)
      frame = 0
    }
  }

  /** Run a frame right now (a modifier changed — no pointer move will come). */
  function runNow(): void {
    dropPending()
    apply()
  }

  function detach(): void {
    win.removeEventListener('pointermove', onMove)
    win.removeEventListener('pointerup', onUp)
    win.removeEventListener('pointercancel', onCancel)
    win.removeEventListener('keydown', onKeyDown, true)
    win.removeEventListener('keyup', onKeyUp, true)
  }

  function finish(cancelled: boolean): void {
    if (done) return
    done = true
    if (cancelled) dropPending()
    else if (frame) {
      // Land the last position before the edit is committed to history.
      dropPending()
      apply()
    }
    detach()
    onEnd({ cancelled })
    scroller.end()
  }

  function onMove(ev: PointerEvent): void {
    lastX = ev.clientX
    readMods(ev)
    schedule()
  }

  function onUp(ev: PointerEvent): void {
    if (done) return
    if (ev.clientX !== lastX) {
      lastX = ev.clientX
      schedule()
    }
    readMods(ev)
    finish(false)
  }

  function onCancel(): void {
    // A pointercancel carries no useful position; land whatever was pending.
    finish(false)
  }

  function onKeyDown(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') {
      ev.preventDefault()
      ev.stopPropagation()
      finish(true)
      return
    }
    const flag = MOD_KEYS[ev.key]
    if (!flag) return
    if (flag === 'altKey') ev.preventDefault()
    if (mods[flag]) return
    mods[flag] = true
    runNow()
  }

  function onKeyUp(ev: KeyboardEvent): void {
    const flag = MOD_KEYS[ev.key]
    if (!flag || !mods[flag]) return
    mods[flag] = false
    runNow()
  }

  win.addEventListener('pointermove', onMove)
  win.addEventListener('pointerup', onUp)
  win.addEventListener('pointercancel', onCancel)
  win.addEventListener('keydown', onKeyDown, true)
  win.addEventListener('keyup', onKeyUp, true)

  return () => finish(true)
}
