import { describe, expect, it } from 'vitest'
import {
  anchorForOutputSpan,
  applyCaptionEdit,
  captionEditsOf,
  deleteCaptionEdit,
  rebaseCaptionEdit,
  resolveCaptionLines,
  storedCaptionEdits,
  timelineCaptionLines,
  wordCaptionLines,
  type AnchorCut
} from './captionEdits'
import { dubCaptionLines, type CaptionLine } from './captionLines'
import { dubCutsFor, dubScenesFor, timelineCutsFor, timelineScenesFor } from './dubScenes'
import { editScriptFromCuts, type EditCut } from './editorApi'

// Words a b c at source 0-2 s and d e f at 10-12 s — the bug report's repro.
const words = [
  { word: 'a', start: 0.1, end: 0.6 },
  { word: 'b', start: 0.7, end: 1.2 },
  { word: 'c', start: 1.3, end: 1.9 },
  { word: 'd', start: 10.1, end: 10.6 },
  { word: 'e', start: 10.7, end: 11.2 },
  { word: 'f', start: 11.3, end: 11.9 }
]
const cutA: AnchorCut = { source: 'clip0', in: 0, out: 2 }
const cutB: AnchorCut = { source: 'clip0', in: 10, out: 12 }
const DUR = [20]

const derive = (cuts: AnchorCut[]): CaptionLine[] => wordCaptionLines(words, cuts, DUR)
const texts = (lines: CaptionLine[]): string[] => lines.map((l) => `${l.text}@${l.start}-${l.end}`)

let n = 0
const nextId = (): string => `ed${++n}`

/** Edit the shown line `idx` on `cuts` and return the edit list. */
function edit(
  cuts: AnchorCut[],
  idx: number,
  patch: Partial<Pick<CaptionLine, 'text' | 'start' | 'end'>>,
  edits: CaptionLine[] = []
): CaptionLine[] {
  const shown = resolveCaptionLines(derive(cuts), edits, cuts)[idx]
  return applyCaptionEdit(edits, shown, patch, cuts, nextId).edits
}

describe('derived caption lines follow the cut', () => {
  it('re-groups from the current cut after a scene is deleted', () => {
    expect(texts(resolveCaptionLines(derive([cutA, cutB]), [], [cutA, cutB]))).toEqual([
      'a b c@0.1-1.9',
      'd e f@2.1-3.9'
    ])
    // Deleting the first scene: the speech at 0.1-1.9 is now d e f. The stale
    // editor list kept "a b c" there.
    expect(texts(resolveCaptionLines(derive([cutB]), [], [cutB]))).toEqual(['d e f@0.1-1.9'])
  })

  it('re-splits a dub line whose script was retyped', () => {
    const cuts: EditCut[] = [
      {
        id: 'c0',
        source: 'clip0',
        in: 0,
        out: 2,
        label: '1',
        voiceoverLineId: 1,
        voiceoverScript: 'เก่า'
      }
    ]
    const splitFor = (cs: EditCut[]): CaptionLine[] =>
      dubCaptionLines(dubScenesFor(editScriptFromCuts(cs)))
    expect(splitFor(cuts)[0].text).toBe('เก่า')
    const retyped = [{ ...cuts[0], voiceoverScript: 'ใหม่' }]
    expect(
      resolveCaptionLines(splitFor(retyped), [], dubCutsFor(editScriptFromCuts(retyped)))[0].text
    ).toBe('ใหม่')
  })
})

describe('an edited line follows its scene', () => {
  it('keeps its text and moves with its footage when an earlier scene is deleted', () => {
    const edits = edit([cutA, cutB], 1, { text: 'DEF!' })
    expect(texts(resolveCaptionLines(derive([cutB]), edits, [cutB]))).toEqual(['DEF!@0.1-1.9'])
  })

  it('follows a reorder', () => {
    const edits = edit([cutA, cutB], 0, { text: 'ABC!' })
    expect(texts(resolveCaptionLines(derive([cutB, cutA]), edits, [cutB, cutA]))).toEqual([
      'd e f@0.1-1.9',
      'ABC!@2.1-3.9'
    ])
  })

  it('is dropped with its scene, and the lines after it stay on their speech', () => {
    const edits = edit([cutA, cutB], 0, { text: 'ABC!' })
    expect(texts(resolveCaptionLines(derive([cutB]), edits, [cutB]))).toEqual(['d e f@0.1-1.9'])
  })

  it('shortens with a trim of its scene', () => {
    const edits = edit([cutA, cutB], 1, { text: 'DEF!' })
    const trimmed = { ...cutB, in: 10.5 }
    const out = resolveCaptionLines(derive([cutA, trimmed]), edits, [cutA, trimmed])
    expect(out.find((l) => l.text === 'DEF!')).toMatchObject({ start: 2, end: 3.4 })
  })

  it('a retime re-anchors, a text change keeps the anchor', () => {
    const cuts = [cutA, cutB]
    let edits = edit(cuts, 1, { start: 2.5 })
    expect(edits[0].anchor).toEqual([{ source: 'clip0', in: 10.5, out: 11.9 }])
    const shown = resolveCaptionLines(derive(cuts), edits, cuts).find((l) => l.id === edits[0].id)!
    edits = applyCaptionEdit(edits, shown, { text: 'x' }, cuts, nextId).edits
    expect(edits).toHaveLength(1)
    expect(edits[0]).toMatchObject({
      text: 'x',
      anchor: [{ source: 'clip0', in: 10.5, out: 11.9 }]
    })
  })
})

describe('a line across a cut boundary', () => {
  // A talking_head line grouped across a silence cut: 1.5-2 on A, 10-10.5 on B.
  const cuts = [cutA, cutB]

  it('anchors piece by piece and comes back unchanged on the same cut', () => {
    const anchor = anchorForOutputSpan(cuts, 1.5, 2.5)
    expect(anchor).toEqual([
      { source: 'clip0', in: 1.5, out: 2 },
      { source: 'clip0', in: 10, out: 10.5 }
    ])
    const line: CaptionLine = { id: 'e', text: 't', start: 1.5, end: 2.5, edited: true, anchor }
    expect(rebaseCaptionEdit(line, cuts)).toMatchObject({ start: 1.5, end: 2.5 })
  })

  it('keeps only its first half once the halves are reordered apart', () => {
    const anchor = anchorForOutputSpan(cuts, 1.5, 2.5)
    const line: CaptionLine = { id: 'e', text: 't', start: 1.5, end: 2.5, edited: true, anchor }
    const mid: AnchorCut = { source: 'clip0', in: 5, out: 6 }
    expect(rebaseCaptionEdit(line, [cutA, mid, cutB])).toMatchObject({ start: 1.5, end: 2 })
  })
})

describe('edits over the derived lines', () => {
  it('an edit hides the line it replaces and a deleted line stays gone', () => {
    const cuts = [cutA, cutB]
    const shown = resolveCaptionLines(derive(cuts), [], cuts)
    const tomb = deleteCaptionEdit([], shown[0], cuts, nextId)
    expect(tomb[0]).toMatchObject({ edited: true, deleted: true, text: '' })
    expect(texts(resolveCaptionLines(derive(cuts), tomb, cuts))).toEqual(['d e f@2.1-3.9'])
  })

  it('deleting an edited line turns it into a tombstone under the same id', () => {
    const cuts = [cutA, cutB]
    const edits = edit(cuts, 0, { text: 'ABC!' })
    const shown = resolveCaptionLines(derive(cuts), edits, cuts)[0]
    const next = deleteCaptionEdit(edits, shown, cuts, nextId)
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ id: edits[0].id, deleted: true })
    expect(texts(resolveCaptionLines(derive(cuts), next, cuts))).toEqual(['d e f@2.1-3.9'])
  })

  it('pushes a line it only grazes out of the way instead of stacking on it', () => {
    const derived: CaptionLine[] = [
      { id: 'cap0', text: 'one', start: 0, end: 2 },
      { id: 'cap1', text: 'two', start: 2, end: 4 }
    ]
    const cuts = [{ source: 'clip0', in: 0, out: 4 }]
    const edits: CaptionLine[] = [
      {
        id: 'e',
        text: 'ONE',
        start: 0,
        end: 2.3,
        edited: true,
        anchor: anchorForOutputSpan(cuts, 0, 2.3)
      }
    ]
    expect(texts(resolveCaptionLines(derived, edits, cuts))).toEqual(['ONE@0-2.3', 'two@2.3-4'])
  })

  it('ignores stored full lists that carry no edit marks', () => {
    // What every save and every render stored before — stale by construction.
    const legacy = [{ id: 'cap0', text: 'old', start: 0, end: 1 }]
    expect(captionEditsOf(legacy)).toEqual([])
    expect(captionEditsOf(undefined)).toEqual([])
    expect(texts(resolveCaptionLines(derive([cutB]), legacy, [cutB]))).toEqual(['d e f@0.1-1.9'])
  })
})

describe('storedCaptionEdits converts a list stored by an older build', () => {
  it('turns a hand-fixed line into an anchored edit that follows its scene', () => {
    // Stored on cut [A, B]: line 2 was retyped by hand, the rest untouched.
    const cuts = [cutA, cutB]
    const legacy = derive(cuts).map((l) => (l.text === 'd e f' ? { ...l, text: 'DEF แก้' } : l))
    const edits = storedCaptionEdits(legacy, derive(cuts), cuts)
    expect(edits).toHaveLength(1)
    expect(edits[0]).toMatchObject({ id: 'legacy1', text: 'DEF แก้', edited: true })
    expect(edits[0].anchor).toEqual([{ source: 'clip0', in: 10.1, out: 11.9 }])
    // Scene A deleted: the fix moves with its footage.
    expect(texts(resolveCaptionLines(derive([cutB]), edits, [cutB]))).toEqual(['DEF แก้@0.1-1.9'])
  })

  it('keeps nothing from lines the derivation still says, wherever they sat', () => {
    const cuts = [cutA, cutB]
    const stale = derive(cuts).map((l) => ({ ...l, start: l.start + 0.5, end: l.end + 0.5 }))
    expect(storedCaptionEdits(stale, derive(cuts), cuts)).toEqual([])
  })

  it('is deterministic and leaves marked lists to captionEditsOf', () => {
    const cuts = [cutB]
    const legacy = [{ id: 'cap0', text: 'แก้แล้ว', start: 0.1, end: 1.9 }]
    const once = storedCaptionEdits(legacy, derive(cuts), cuts)
    expect(storedCaptionEdits(legacy, derive(cuts), cuts)).toEqual(once)
    expect(storedCaptionEdits(once, derive(cuts), cuts)).toEqual(once)
    expect(storedCaptionEdits([], derive(cuts), cuts)).toEqual([])
    expect(storedCaptionEdits(undefined, derive(cuts), cuts)).toEqual([])
  })
})

describe('shot swap keeps the other scenes’ edits (free regime)', () => {
  it('re-times edits onto the new script; the swapped scene’s own edit drops out', () => {
    const script = {
      segments: [
        {
          sourceClip: 'clip0',
          sourceIn: 0,
          sourceOut: 2,
          durationSec: 2,
          voiceoverLineId: 1,
          voiceoverScript: 'หนึ่ง'
        },
        {
          sourceClip: 'clip0',
          sourceIn: 10,
          sourceOut: 12,
          durationSec: 2,
          voiceoverLineId: 2,
          voiceoverScript: 'สอง'
        }
      ]
    }
    const cuts = dubCutsFor(script)
    const derived = dubCaptionLines(dubScenesFor(script))
    let edits = applyCaptionEdit([], derived[1], { text: 'สองแก้' }, cuts, nextId).edits
    edits = applyCaptionEdit(edits, derived[0], { text: 'หนึ่งแก้' }, cuts, nextId).edits
    // Swap scene 1 for a longer alternate elsewhere in the footage.
    const swapped = {
      segments: [
        { ...script.segments[0], sourceIn: 4, sourceOut: 7, durationSec: 3 },
        script.segments[1]
      ]
    }
    const out = resolveCaptionLines(
      dubCaptionLines(dubScenesFor(swapped)),
      edits,
      dubCutsFor(swapped)
    )
    expect(texts(out)).toEqual(['หนึ่ง@0-3', 'สองแก้@3-5'])
  })
})

describe('timelineCaptionLines', () => {
  it('derives from the timeline’s own cuts and words, edits laid over', () => {
    const timeline = {
      timeline: [{ type: 'cut', source: 'clip0', in: 10, out: 12, label: '' }],
      words,
      captionLines: edit([cutB], 0, { text: 'DEF!' })
    }
    expect(texts(timelineCaptionLines(timeline, DUR))).toEqual(['DEF!@0.1-1.9'])
  })

  it('pre-VO edits land on the planned timeline’s re-timed scenes', () => {
    const script = {
      segments: [
        {
          sourceClip: 'clip0',
          sourceIn: 0,
          sourceOut: 2,
          durationSec: 2,
          voiceoverLineId: 1,
          voiceoverScript: 'หนึ่ง'
        },
        {
          sourceClip: 'clip0',
          sourceIn: 10,
          sourceOut: 12,
          durationSec: 2,
          voiceoverLineId: 2,
          voiceoverScript: 'สอง'
        }
      ]
    }
    const edits = applyCaptionEdit(
      [],
      dubCaptionLines(dubScenesFor(script))[1],
      { text: 'สองแก้' },
      dubCutsFor(script),
      nextId
    ).edits
    // The voiceover plan stretched scene 1 to 3 s.
    const planned = {
      mode: 'dub_first',
      timeline: [
        { type: 'cut', source: 'clip0', in: 0, out: 3, label: '' },
        { type: 'cut', source: 'clip0', in: 10, out: 12, label: '' }
      ]
    }
    const out = resolveCaptionLines(
      dubCaptionLines(timelineScenesFor(planned, script)),
      edits,
      timelineCutsFor(planned)
    )
    expect(texts(out)).toEqual(['หนึ่ง@0-3', 'สองแก้@3-5'])
  })
})
