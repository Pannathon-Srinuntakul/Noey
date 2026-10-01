import { fmtTime, fmtTimeTenths } from './timelineMath'

/**
 * How the video transport (components/ui/VideoTransport) lays itself out in
 * the width it actually has.
 *
 * The transport sits on the frame, and the timeline editor's frame is a 9:16
 * stage only ~180-360px wide. Laid out as one fixed row it was squeezed there:
 * the 44px play ring was crushed into a tall oval and the clock wrapped onto
 * two lines and ran off the stage (owner report 2026-10-01; 293px wide at
 * 1440×900, 219px at 1024×768, 183px with the inspector stacked). So the
 * layout is chosen from the measured width, never from the viewport — the
 * same transport is a 183px editor stage and a 900px big-screen modal:
 *
 *  - `size`: the largest control size whose button row fits. Buttons are
 *    fixed squares at every size; they never stretch or squash.
 *  - `stacked`: the clock does not fit beside the buttons, so it gets its own
 *    line above the seek bar instead of wrapping.
 */

export type TransportSize = 'md' | 'sm' | 'xs'

export interface TransportMetrics {
  /** Square secondary button (step, play-scene, loop). */
  button: number
  /** The play ring. */
  play: number
  /** Gap between the controls. */
  gap: number
  /** Side padding of the bar. */
  padX: number
}

/** Pixel sizes per tier — VideoTransport's class lists mirror these. */
export const TRANSPORT_METRICS: Record<TransportSize, TransportMetrics> = {
  md: { button: 32, play: 44, gap: 6, padX: 12 },
  sm: { button: 28, play: 40, gap: 4, padX: 10 },
  xs: { button: 24, play: 36, gap: 2, padX: 8 }
}

/** Gap between the button group and the clock when they share a row. */
export const TRANSPORT_TIME_GAP_PX = 12
/** Upper bound for one character of the 13px tabular clock. Measured ~6.3px
 * in the app font; rounded up so a wider fallback font stacks early rather
 * than overflowing. */
export const TRANSPORT_TIME_CHAR_PX = 7
/** The clock's timecode field (TimecodeInput, `w-[84px]`) plus its gap. */
export const TRANSPORT_TIME_FIELD_PX = 84 + 4

const SIZES: TransportSize[] = ['md', 'sm', 'xs']

/** Width of the button group at a size. */
export function transportControlsWidth(size: TransportSize, secondaryButtons: number): number {
  const m = TRANSPORT_METRICS[size]
  const items = secondaryButtons + 1
  return secondaryButtons * m.button + m.play + Math.max(0, items - 1) * m.gap
}

/** Widest the clock gets for this clip: the label at the clip's end, or —
 * when the clock is click-to-type — the timecode field plus `/ m:ss`, so
 * opening the field never re-flows the bar. */
export function transportTimeWidth(durationSec: number, timeEditable: boolean): number {
  const label = `${fmtTimeTenths(durationSec)} / ${fmtTime(durationSec)}`
  const labelW = label.length * TRANSPORT_TIME_CHAR_PX
  if (!timeEditable) return labelW
  const fieldW =
    TRANSPORT_TIME_FIELD_PX + `/ ${fmtTime(durationSec)}`.length * TRANSPORT_TIME_CHAR_PX
  return Math.max(labelW, fieldW)
}

export function transportLayout(
  widthPx: number,
  opts: { secondaryButtons: number; durationSec: number; timeEditable?: boolean }
): { size: TransportSize; stacked: boolean } {
  // Not laid out yet (hidden, or before the first measure): the full size, one
  // row — what every surface wider than the editor stage gets anyway.
  if (!(widthPx > 0)) return { size: 'md', stacked: false }
  const inner = (size: TransportSize): number => widthPx - TRANSPORT_METRICS[size].padX * 2
  const size =
    SIZES.find((s) => transportControlsWidth(s, opts.secondaryButtons) <= inner(s)) ?? 'xs'
  const rowW =
    transportControlsWidth(size, opts.secondaryButtons) +
    TRANSPORT_TIME_GAP_PX +
    transportTimeWidth(opts.durationSec, opts.timeEditable ?? false)
  return { size, stacked: rowW > inner(size) }
}
