import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorSnapshot } from '../../../lib/editorHistory'
import type { WorkingCut } from '../types'
import { createEditHistory } from './useEditorHistory'

const cut = (script: string, id = 'a'): WorkingCut => ({
  id,
  source: 'clip0',
  in: 0,
  out: 2,
  label: '1',
  voiceoverLineId: 1,
  voiceoverScript: script
})

/** A tiny editor: `state` is what snapshotNow reads, as the refs are. */
function setup(initial: WorkingCut[]) {
  let state: EditorSnapshot = { cuts: initial, captionLines: null, captionStyle: null, music: null }
  const history = createEditHistory(
    () => state,
    () => undefined
  )
  return {
    history,
    get cuts() {
      return state.cuts
    },
    write(cuts: WorkingCut[]) {
      state = { ...state, cuts }
    },
    /** What the editor's undo/redo does with the snapshot it gets back. */
    apply(snap: EditorSnapshot | null) {
      if (snap) state = snap
    }
  }
}

describe('createEditHistory', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('records typing once, a tick after the box lets go', () => {
    const ed = setup([cut('')])
    ed.history.beginEdit()
    ed.write([cut('สวัสดี')])
    ed.history.commitEdit()
    expect(ed.history.undoStack).toHaveLength(0)
    vi.runAllTimers()
    expect(ed.history.undoStack).toHaveLength(1)
  })

  it('records nothing for a focus that changed nothing', () => {
    const ed = setup([cut('x')])
    ed.history.beginEdit()
    ed.history.commitEdit()
    vi.runAllTimers()
    expect(ed.history.undoStack).toHaveLength(0)
  })

  // Bug hunt #32: on touch the blur and the tap on เลิกทำ run in one task, so
  // the deferred step used to land AFTER the undo — clearing its redo.
  it('an undo tapped before the deferred commit fires undoes the typing and can redo it', () => {
    const ed = setup([cut('a')])
    // An earlier edit (a trim, say) — there is something to undo past it.
    ed.history.push({ cuts: [cut('')], captionLines: null, captionStyle: null, music: null })
    ed.history.beginEdit()
    ed.write([cut('ab')])
    ed.history.commitEdit()
    ed.apply(ed.history.undo())
    vi.runAllTimers()
    expect(ed.cuts[0].voiceoverScript).toBe('a')
    expect(ed.history.redoStack).toHaveLength(1)
    ed.apply(ed.history.redo())
    expect(ed.cuts[0].voiceoverScript).toBe('ab')
  })

  it('an undo while the box still has focus closes the edit; its later blur records nothing', () => {
    const ed = setup([cut('a')])
    ed.history.beginEdit()
    ed.write([cut('ab')])
    ed.apply(ed.history.undo())
    expect(ed.cuts[0].voiceoverScript).toBe('a')
    ed.history.commitEdit()
    vi.runAllTimers()
    expect(ed.history.undoStack).toHaveLength(0)
    expect(ed.history.redoStack).toHaveLength(1)
  })

  it('typing on after an undo in a box that kept focus is still recorded', () => {
    const ed = setup([cut('a')])
    ed.history.beginEdit()
    ed.write([cut('ab')])
    ed.apply(ed.history.undo())
    // iOS: เลิกทำ did not blur the box, so no new beginEdit.
    ed.write([cut('ac')])
    ed.history.commitEdit()
    vi.runAllTimers()
    expect(ed.history.undoStack).toHaveLength(1)
    ed.apply(ed.history.undo())
    expect(ed.cuts[0].voiceoverScript).toBe('a')
  })

  it('typing on after a delete in a box that kept focus is its own step', () => {
    const ed = setup([cut('a'), cut('', 'b')])
    ed.history.beginEdit()
    ed.write([cut('ab'), cut('', 'b')])
    ed.history.push({ cuts: ed.cuts, captionLines: null, captionStyle: null, music: null })
    ed.write([cut('ab')])
    vi.runAllTimers()
    ed.write([cut('abc')])
    ed.history.commitEdit()
    vi.runAllTimers()
    expect(ed.history.undoStack.map((s) => s.cuts[0].voiceoverScript)).toEqual(['a', 'ab', 'ab'])
    ed.apply(ed.history.undo())
    expect(ed.cuts).toEqual([cut('ab')])
  })

  it('a delete tapped mid-commit is its own step after the typing', () => {
    const ed = setup([cut('a'), cut('', 'b')])
    ed.history.beginEdit()
    ed.write([cut('ab'), cut('', 'b')])
    ed.history.commitEdit()
    // The delete: push the state before it, then apply it.
    ed.history.push({ cuts: ed.cuts, captionLines: null, captionStyle: null, music: null })
    ed.write([cut('ab')])
    vi.runAllTimers()
    expect(ed.history.undoStack.map((s) => s.cuts.length)).toEqual([2, 2])
    ed.apply(ed.history.undo())
    expect(ed.cuts).toHaveLength(2)
    expect(ed.cuts[0].voiceoverScript).toBe('ab')
    ed.apply(ed.history.undo())
    expect(ed.cuts[0].voiceoverScript).toBe('a')
  })

  it('settleEdit records typing that never lost focus — the way out', () => {
    const ed = setup([cut('')])
    ed.history.beginEdit()
    ed.write([cut('พิมพ์ค้างไว้')])
    ed.history.settleEdit()
    expect(ed.history.undoStack).toHaveLength(1)
  })
})
