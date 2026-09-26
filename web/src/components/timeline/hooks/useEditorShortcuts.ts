import type { TrimEdge } from '../../../lib/timelineMath'
import { FRAME_SEC } from '../constants'
import { isTypingTarget, matchesShortcut } from '../shortcuts'
import { useWindowKeydown } from './useWindowKeydown'

/**
 * Everything a key can do to the editor. The editor hands this in fresh on
 * every render (useWindowKeydown calls the newest handler), so each action
 * closes over the current state and nothing here is memoized.
 */
export interface EditorShortcutActions {
  // ---- guards ------------------------------------------------------------
  ready: boolean
  hasPreview: boolean
  shortcutsOpen: boolean
  setShortcutsOpen: (open: boolean | ((prev: boolean) => boolean)) => void
  isDub: boolean
  /** ปรับช็อต is offered only where the caller can act on it. */
  canShotSwap: boolean
  hasSelection: boolean
  /** Esc with nothing typing and no sheet open: close the context menu,
   * else clear the selection. Never the editor (see TimelineEditor). */
  onEscape: () => void

  // ---- playback ----------------------------------------------------------
  togglePlay: () => void
  /** Shift+Space: the I/O range when set, else the selected scene. */
  playSelectionOrRange: () => void
  /** Shift+K: ±1 s around the cut boundary nearest the playhead. */
  playAroundNearestCut: () => void
  toggleLoop: () => void
  shuttleFaster: () => void
  shuttleStop: () => void
  shuttleBack: () => void
  openShotSwap: () => void

  // ---- view --------------------------------------------------------------
  zoomAround: (factor: number) => void
  fitToggle: () => void
  zoomToSelection: () => void
  switchView: (mode: 'source' | 'edited') => void
  toggleSnap: () => void

  // ---- history -----------------------------------------------------------
  undo: () => void
  redo: () => void
  save: () => void

  // ---- edits -------------------------------------------------------------
  deleteRange: () => void
  deleteSelection: () => void
  split: () => void
  duplicate: () => void
  copy: () => void
  cutToClipboard: () => void
  paste: () => void
  selectAll: () => void
  deselectAll: () => void
  addScene: () => void
  addAngle: () => void
  setPointAtPlayhead: (edge: TrimEdge) => void
  trimToPlayhead: (edge: TrimEdge) => void
  nudgeEdge: (dir: -1 | 1, big: boolean) => void
  slipNudge: (dir: -1 | 1, big: boolean) => void
  extendEdit: () => void
  moveScene: (dir: -1 | 1) => void
  toggleSkip: () => void

  // ---- markers + range ---------------------------------------------------
  addMarker: () => void
  jumpMarker: (dir: -1 | 1) => void
  setRangeIn: () => void
  setRangeOut: () => void
  jumpRange: (edge: 'in' | 'out') => void
  clearRange: () => void

  // ---- navigation --------------------------------------------------------
  nudgePlayhead: (deltaSec: number) => void
  jumpToCut: (dir: -1 | 1) => void
  jumpHome: () => void
  jumpEnd: () => void
}

/** The ←/→ or ↑/↓ or ,/. direction of an arrow-pair chord. */
function dirOf(e: KeyboardEvent): -1 | 1 {
  return e.code === 'ArrowLeft' || e.code === 'ArrowUp' || e.code === 'Comma' ? -1 : 1
}

/**
 * The editor's keyboard, in one place. Every key is matched through the
 * shortcut registry (`matchesShortcut`) so the sheet and the binding are one
 * table; the registry's own test proves no two ids answer the same chord.
 *
 * First match wins, in this order — the guards first: a key already handled
 * (a block picked up with Enter), Esc inside a text field, the sheet, and
 * typing anywhere else.
 */
export function useEditorShortcuts(a: EditorShortcutActions): void {
  useWindowKeydown((e: KeyboardEvent) => {
    // Already handled — a block picked up with Enter moves on the arrows and
    // drops on Esc, and neither may also nudge the playhead or close the editor.
    if (e.defaultPrevented) return
    if (e.code === 'Escape') {
      // In a text, number or timecode field Esc belongs to the field: it
      // leaves it (a timecode field reverts its draft itself, first). It used
      // to close the whole editor from the middle of a sentence.
      if (isTypingTarget(e.target)) {
        e.preventDefault()
        ;(e.target as HTMLElement).blur()
        return
      }
      if (a.shortcutsOpen) {
        e.preventDefault()
        a.setShortcutsOpen(false)
        return
      }
      if (!a.ready) return
      e.preventDefault()
      // An in-flight drag is cancelled by the pointer binder (capture phase)
      // and never reaches here. Esc then gives back the smallest thing it can
      // reach: the context menu, the selection, and only then the editor.
      a.onEscape()
      return
    }

    if (!a.ready || !a.hasPreview) return
    if (isTypingTarget(e.target)) return

    const isQuestion = e.key === '?' || (e.code === 'Slash' && e.shiftKey)
    if (isQuestion && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      a.setShortcutsOpen((open) => !open)
      return
    }

    const run = (fn: () => void): void => {
      e.preventDefault()
      fn()
    }

    // ---- playback ----------------------------------------------------------
    if (matchesShortcut(e, 'play')) return run(a.togglePlay)
    if (matchesShortcut(e, 'play-scene')) return run(a.playSelectionOrRange)
    if (matchesShortcut(e, 'play-around')) return run(a.playAroundNearestCut)
    if (matchesShortcut(e, 'loop')) return run(a.toggleLoop)
    // J K L — the transport shuttle. See usePreviewPlayer for why J steps back
    // instead of playing backwards.
    if (matchesShortcut(e, 'shuttle')) {
      if (e.code === 'KeyL') return run(a.shuttleFaster)
      if (e.code === 'KeyK') return run(a.shuttleStop)
      return run(a.shuttleBack)
    }
    // Enter opens ปรับช็อต for the selected scene — only where the caller can
    // act on it (the shot-swap screen lives outside the editor).
    if (a.canShotSwap && a.hasSelection && matchesShortcut(e, 'shot-swap')) {
      return run(a.openShotSwap)
    }

    // ---- view --------------------------------------------------------------
    // + / − zoom, anchored on the playhead. Read off `key` as well as `code`:
    // on most layouts '+' IS Shift+Equal, and the registry's chord would
    // reject the shift — the fallback keeps the key working there.
    if (matchesShortcut(e, 'zoom')) return run(() => a.zoomAround(e.code === 'Minus' ? 0.8 : 1.25))
    if (!e.metaKey && !e.ctrlKey && !e.altKey) {
      const zoomIn = e.code === 'NumpadAdd' || e.key === '+'
      const zoomOut = e.code === 'NumpadSubtract' || e.key === '_'
      if (zoomIn || zoomOut) return run(() => a.zoomAround(zoomIn ? 1.25 : 0.8))
    }
    if (matchesShortcut(e, 'zoom-fit-toggle')) return run(a.fitToggle)
    if (matchesShortcut(e, 'zoom-selection')) return run(a.zoomToSelection)

    // ---- history -----------------------------------------------------------
    if (matchesShortcut(e, 'undo')) return run(a.undo)
    if (matchesShortcut(e, 'redo')) return run(a.redo)

    // ---- edits -------------------------------------------------------------
    if (matchesShortcut(e, 'delete-range')) return run(a.deleteRange)
    if (matchesShortcut(e, 'delete')) return run(a.deleteSelection)
    if (matchesShortcut(e, 'save')) return run(a.save)
    if (matchesShortcut(e, 'split')) return run(a.split)
    if (matchesShortcut(e, 'duplicate')) return run(a.duplicate)
    if (matchesShortcut(e, 'copy')) return run(a.copy)
    if (matchesShortcut(e, 'cut')) return run(a.cutToClipboard)
    if (matchesShortcut(e, 'paste')) return run(a.paste)
    if (matchesShortcut(e, 'select-all')) return run(a.selectAll)
    if (matchesShortcut(e, 'deselect-all')) return run(a.deselectAll)
    if (matchesShortcut(e, 'add-scene')) return run(a.addScene)
    if (a.isDub && matchesShortcut(e, 'add-angle')) return run(a.addAngle)
    if (matchesShortcut(e, 'set-in')) {
      return run(() => a.setPointAtPlayhead(e.code === 'BracketLeft' ? 'left' : 'right'))
    }
    if (matchesShortcut(e, 'trim-head')) return run(() => a.trimToPlayhead('left'))
    if (matchesShortcut(e, 'trim-tail')) return run(() => a.trimToPlayhead('right'))
    if (matchesShortcut(e, 'nudge-edge')) return run(() => a.nudgeEdge(dirOf(e), false))
    if (matchesShortcut(e, 'nudge-edge-big')) return run(() => a.nudgeEdge(dirOf(e), true))
    if (matchesShortcut(e, 'slip-nudge')) return run(() => a.slipNudge(dirOf(e), false))
    if (matchesShortcut(e, 'slip-nudge-big')) return run(() => a.slipNudge(dirOf(e), true))
    if (matchesShortcut(e, 'extend-edit')) return run(a.extendEdit)
    if (matchesShortcut(e, 'move-scene')) return run(() => a.moveScene(dirOf(e)))
    if (matchesShortcut(e, 'skip-scene')) return run(a.toggleSkip)
    if (matchesShortcut(e, 'snap-toggle')) return run(a.toggleSnap)

    // ---- markers + range ---------------------------------------------------
    if (matchesShortcut(e, 'add-marker')) return run(a.addMarker)
    if (matchesShortcut(e, 'marker-prev')) return run(() => a.jumpMarker(-1))
    if (matchesShortcut(e, 'marker-next')) return run(() => a.jumpMarker(1))
    if (matchesShortcut(e, 'range-in')) return run(a.setRangeIn)
    if (matchesShortcut(e, 'range-out')) return run(a.setRangeOut)
    if (matchesShortcut(e, 'range-jump-in')) return run(() => a.jumpRange('in'))
    if (matchesShortcut(e, 'range-jump-out')) return run(() => a.jumpRange('out'))
    if (matchesShortcut(e, 'range-clear')) return run(a.clearRange)

    // ---- navigation --------------------------------------------------------
    if (matchesShortcut(e, 'view-source')) return run(() => a.switchView('source'))
    if (matchesShortcut(e, 'view-edited')) return run(() => a.switchView('edited'))
    if (matchesShortcut(e, 'jump-back')) return run(() => a.nudgePlayhead(dirOf(e)))
    if (matchesShortcut(e, 'frame-back')) return run(() => a.nudgePlayhead(dirOf(e) * FRAME_SEC))
    if (matchesShortcut(e, 'cut-prev')) return run(() => a.jumpToCut(dirOf(e)))
    if (matchesShortcut(e, 'home')) return run(e.code === 'End' ? a.jumpEnd : a.jumpHome)
  })
}
