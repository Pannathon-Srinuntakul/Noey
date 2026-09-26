/**
 * Tracks whether Alt / Shift are currently held anywhere in the window.
 *
 * The editor's snap context reads `isAltHeld()` on every drag frame
 * (`isActive = snapEnabled && !isAltHeld()`), so holding Alt suppresses the
 * magnet the way every NLE does. The `blur` reset matters: an Alt released
 * while another window had focus never sends its keyup here, and without the
 * reset snapping would stay dead until the next Alt press.
 */
export interface ModifierTracker {
  isAltHeld(): boolean
  isShiftHeld(): boolean
  dispose(): void
}

type TrackerWindow = Pick<Window, 'addEventListener' | 'removeEventListener'>

export function createModifierTracker(win: TrackerWindow = window): ModifierTracker {
  let alt = false
  let shift = false

  function onKeyDown(ev: KeyboardEvent): void {
    if (ev.key === 'Alt') alt = true
    else if (ev.key === 'Shift') shift = true
  }

  function onKeyUp(ev: KeyboardEvent): void {
    if (ev.key === 'Alt') alt = false
    else if (ev.key === 'Shift') shift = false
  }

  function onBlur(): void {
    alt = false
    shift = false
  }

  // Capture phase so a handler that stops propagation (the drag binder's
  // Escape / Alt) cannot hide a modifier change from the tracker.
  win.addEventListener('keydown', onKeyDown, true)
  win.addEventListener('keyup', onKeyUp, true)
  win.addEventListener('blur', onBlur)

  return {
    isAltHeld: () => alt,
    isShiftHeld: () => shift,
    dispose: () => {
      win.removeEventListener('keydown', onKeyDown, true)
      win.removeEventListener('keyup', onKeyUp, true)
      win.removeEventListener('blur', onBlur)
    }
  }
}
