/**
 * Sizing for the ปรับช็อต review cards (components/projects/ShotSwapReview):
 * how big each 9:16 frame is, and how much of each option's note shows under
 * it.
 *
 * The rule the owner set (2026-10-01): a note's length must never change a
 * frame. So the frame is sized from the measured body alone — no input here
 * knows what any note says — and the note gets whatever room is left under
 * the frame, folding behind ดูเพิ่ม only when it does not fit there. Text
 * grows downward; frames never move.
 */

/** Tallest a frame ever gets; below that it shrinks with the window so the row
 * never scrolls — comparing is the whole job, every option must be on screen. */
export const FRAME_MAX_H = 470
/** Smallest a frame may shrink to before the body is allowed to scroll instead:
 * under this the shots are too small to judge, which is the only reason to be
 * on this screen. */
export const FRAME_MIN_H = 200
/** Narrowest a frame may get to fit N cards side by side. */
export const FRAME_MIN_W = 120
/** pt-[26px] on the body plus the mt-[22px] above the row. */
export const BODY_PAD_H = 26 + 22
/** px-6 on the body. */
export const BODY_SIDE_PAD = 24
/** sm:gap-5 between the cards. */
export const CARD_GAP = 20

/** One line of note: 13.5px at leading 1.6 (good Thai line-height — the
 * stacked vowels and tone marks need it). */
export const NOTE_LINE_H = 13.5 * 1.6
/** The ดูเพิ่ม / ย่อ toggle under a folded note: one 13px line at leading 1.4. */
export const NOTE_TOGGLE_H = 13 * 1.4
/** Fewest note lines a folded note shows, however short the window. */
export const NOTE_MIN_LINES = 2
/** Under the frame, apart from the note itself: the label's mt-[11px], its
 * 15px line (leading 1.5), the note's mt-[3px] and the row's pb-1. */
export const CAPTION_CHROME_H = 11 + 15 * 1.5 + 3 + 4
/** Room kept under every frame for its caption: the label plus TWO lines of
 * note. A constant: it is the same for every shot (with or without options)
 * and never depends on what a note says, so a frame is the same size whatever
 * its note's length and as you step between shots. */
export const LABEL_BLOCK_H = CAPTION_CHROME_H + NOTE_LINE_H * NOTE_MIN_LINES

/**
 * Frame size for `cardCount` cards in the measured body. The height comes
 * from the box the frames really live in; the width is what that height allows
 * at 9:16, capped so all N cards fit side by side. Only the width is applied
 * (the frame's `aspect-[9/16]` derives the height), so a shot can never be
 * drawn out of ratio.
 *
 * `noteRoomPx` is what is left under the frame for a note once the frame and
 * the label are placed — at least two lines, since LABEL_BLOCK_H reserves
 * them; more on a window with height to spare.
 */
export function shotFrameSize(box: {
  bodyW: number
  bodyH: number
  headH: number
  cardCount: number
}): { frameW: number; noteRoomPx: number } {
  const cardCount = Math.max(1, box.cardCount)
  const frameH =
    box.bodyH > 0
      ? Math.max(
          FRAME_MIN_H,
          Math.min(FRAME_MAX_H, box.bodyH - box.headH - BODY_PAD_H - LABEL_BLOCK_H)
        )
      : FRAME_MAX_H
  const widthCap =
    box.bodyW > 0
      ? (box.bodyW - BODY_SIDE_PAD * 2 - CARD_GAP * (cardCount - 1)) / cardCount
      : Infinity
  const frameW = Math.max(FRAME_MIN_W, Math.floor(Math.min((frameH * 9) / 16, widthCap)))
  const drawnH = (frameW * 16) / 9
  const left = box.bodyH > 0 ? box.bodyH - box.headH - BODY_PAD_H - drawnH - CAPTION_CHROME_H : 0
  return { frameW, noteRoomPx: Math.max(NOTE_LINE_H * NOTE_MIN_LINES, left) }
}

/**
 * Whether a note of `naturalPx` (its full wrapped height) folds into
 * `roomPx`, and to how many lines. A note that fits is shown whole with no
 * toggle; one that does not shows as many lines as leave room for the toggle
 * — never fewer than NOTE_MIN_LINES.
 */
export function noteFold(naturalPx: number, roomPx: number): { folded: boolean; lines: number } {
  // Half a pixel of slack: line boxes come back fractional.
  if (!(naturalPx > roomPx + 0.5)) return { folded: false, lines: 0 }
  const lines = Math.max(NOTE_MIN_LINES, Math.floor((roomPx - NOTE_TOGGLE_H) / NOTE_LINE_H))
  // A fold that would hide nothing is not a fold: show the note whole.
  if (lines * NOTE_LINE_H >= naturalPx - 0.5) return { folded: false, lines: 0 }
  return { folded: true, lines }
}
