import { describe, expect, it } from 'vitest'
import {
  FRAME_MAX_H,
  NOTE_LINE_H,
  NOTE_MIN_LINES,
  NOTE_TOGGLE_H,
  noteFold,
  shotFrameSize
} from './shotSwapLayout'

// Body boxes measured in the review at common windows (header 52, footer 82).
const BODY_1440x900 = { bodyW: 1278, bodyH: 702, headH: 61 }
const BODY_1024x768 = { bodyW: 958, bodyH: 570, headH: 61 }

describe('shotFrameSize', () => {
  it('is the tallest frame on a roomy window and keeps 9:16 by width alone', () => {
    const { frameW } = shotFrameSize({ ...BODY_1440x900, cardCount: 4 })
    expect(frameW).toBe(Math.floor((FRAME_MAX_H * 9) / 16))
  })

  it('narrows the frames so N cards fit side by side', () => {
    const body = { bodyW: 800, bodyH: 570, headH: 61 }
    const two = shotFrameSize({ ...body, cardCount: 2 }).frameW
    const four = shotFrameSize({ ...body, cardCount: 4 }).frameW
    expect(four).toBeLessThan(two)
    expect(4 * four + 3 * 20 + 48).toBeLessThanOrEqual(body.bodyW)
  })

  it('always leaves at least two lines of note under the frame', () => {
    for (const bodyH of [300, 450, 570, 702, 900]) {
      const { noteRoomPx } = shotFrameSize({ bodyW: 1200, bodyH, headH: 61, cardCount: 3 })
      expect(noteRoomPx).toBeGreaterThanOrEqual(NOTE_LINE_H * NOTE_MIN_LINES)
    }
  })

  it('gives a roomy window more note room, never a smaller frame', () => {
    const short = shotFrameSize({ ...BODY_1024x768, cardCount: 2 })
    const tall = shotFrameSize({ bodyW: 958, bodyH: 900, headH: 61, cardCount: 2 })
    expect(tall.frameW).toBeGreaterThanOrEqual(short.frameW)
    expect(tall.noteRoomPx).toBeGreaterThan(short.noteRoomPx)
  })
})

describe('noteFold', () => {
  const room = NOTE_LINE_H * 3

  it('shows a note that fits whole, with no toggle', () => {
    expect(noteFold(NOTE_LINE_H, room)).toEqual({ folded: false, lines: 0 })
    expect(noteFold(NOTE_LINE_H * 3, room)).toEqual({ folded: false, lines: 0 })
  })

  it('folds a longer note to the lines that leave room for the toggle', () => {
    const fold = noteFold(NOTE_LINE_H * 8, room)
    expect(fold.folded).toBe(true)
    expect(fold.lines * NOTE_LINE_H + NOTE_TOGGLE_H).toBeLessThanOrEqual(room + 0.5)
  })

  it('never folds below two lines, however tight the room', () => {
    expect(noteFold(NOTE_LINE_H * 8, 10)).toEqual({ folded: true, lines: NOTE_MIN_LINES })
  })

  it('does not fold when the fold would hide nothing', () => {
    expect(noteFold(NOTE_LINE_H * 2, 10)).toEqual({ folded: false, lines: 0 })
  })
})
