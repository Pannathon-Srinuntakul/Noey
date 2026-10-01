import { describe, expect, it } from 'vitest'
import {
  TRANSPORT_METRICS,
  transportControlsWidth,
  transportLayout,
  transportTimeWidth
} from './transportLayout'

// The timeline editor's transport: ⏮ ⏭ + play-scene + loop, clock is click-to-type.
const EDITOR = { secondaryButtons: 4, durationSec: 14, timeEditable: true }
// ui/VideoPlayer and the big-screen modal: ⏮ ⏭ only.
const PLAYER = { secondaryButtons: 2, durationSec: 15 }

describe('transportLayout', () => {
  it('keeps one row while the clock fits beside the buttons', () => {
    // 1440×1024 editor stage (measured 362.9px) and any wide player.
    expect(transportLayout(363, EDITOR)).toEqual({ size: 'md', stacked: false })
    expect(transportLayout(900, PLAYER)).toEqual({ size: 'md', stacked: false })
    // The project page's 270px player has room for its three controls + clock.
    expect(transportLayout(270, PLAYER)).toEqual({ size: 'md', stacked: false })
  })

  it('moves the clock to its own line instead of wrapping it (1440×900 stage)', () => {
    expect(transportLayout(293, EDITOR)).toEqual({ size: 'md', stacked: true })
    expect(transportLayout(237, EDITOR)).toEqual({ size: 'md', stacked: true })
  })

  it('steps the buttons down a size rather than squeezing them', () => {
    // 1024×768 stage, the phone stage, and the stacked-inspector stage at 900 wide.
    expect(transportLayout(219, EDITOR)).toEqual({ size: 'sm', stacked: true })
    expect(transportLayout(205, EDITOR)).toEqual({ size: 'sm', stacked: true })
    expect(transportLayout(183, EDITOR)).toEqual({ size: 'xs', stacked: true })
  })

  it('always picks a size whose button row fits, down to the smallest', () => {
    for (let w = 150; w <= 1000; w += 7) {
      const { size } = transportLayout(w, EDITOR)
      const inner = w - TRANSPORT_METRICS[size].padX * 2
      if (size !== 'xs') expect(transportControlsWidth(size, 4)).toBeLessThanOrEqual(inner)
    }
  })

  it('is monotonic: a wider bar never gets smaller buttons or a stacked clock back', () => {
    const rank = { xs: 0, sm: 1, md: 2 }
    let prev = transportLayout(150, EDITOR)
    for (let w = 151; w <= 1000; w++) {
      const next = transportLayout(w, EDITOR)
      expect(rank[next.size]).toBeGreaterThanOrEqual(rank[prev.size])
      if (next.size === prev.size && !prev.stacked) expect(next.stacked).toBe(false)
      prev = next
    }
  })

  it('stacks earlier for a longer clip, whose clock is wider', () => {
    expect(transportLayout(363, { ...EDITOR, durationSec: 14 }).stacked).toBe(false)
    expect(transportLayout(363, { ...EDITOR, durationSec: 12 * 60 }).stacked).toBe(true)
  })

  it('falls back to the full one-row bar before the first measure', () => {
    expect(transportLayout(0, EDITOR)).toEqual({ size: 'md', stacked: false })
    expect(transportLayout(Number.NaN, EDITOR)).toEqual({ size: 'md', stacked: false })
  })
})

describe('transportTimeWidth', () => {
  it('reserves room for the timecode field when the clock is click-to-type', () => {
    expect(transportTimeWidth(14, true)).toBeGreaterThan(transportTimeWidth(14, false))
  })
})
