import { describe, expect, it } from 'vitest'
import { LINE_GAP_SEC, encodeVoiceoverWav, planLineLayout } from './wav'

const RATE = 48_000

function tone(seconds: number, value = 0.5): Float32Array {
  return new Float32Array(Math.round(seconds * RATE)).fill(value)
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length))
}

function u32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset).getUint32(offset, true)
}

describe('planLineLayout', () => {
  it('places the first line at zero', () => {
    expect(planLineLayout([2, 3]).lineStarts[0]).toBe(0)
  })

  it('inserts a gap between lines but not after the last one', () => {
    const plan = planLineLayout([2, 3], 0.5)
    expect(plan.lineStarts).toEqual([0, 2.5])
    // 2 + gap + 3 — no trailing silence.
    expect(plan.totalSec).toBe(5.5)
  })

  it('handles a single line', () => {
    expect(planLineLayout([4], 0.5)).toEqual({ lineStarts: [0], totalSec: 4 })
  })

  it('handles no lines', () => {
    expect(planLineLayout([])).toEqual({ lineStarts: [], totalSec: 0 })
  })

  it('treats a negative duration as zero rather than moving lines backwards', () => {
    expect(planLineLayout([-1, 2], 0).lineStarts).toEqual([0, 0])
  })
})

describe('encodeVoiceoverWav', () => {
  it('writes a valid mono 16-bit PCM header', () => {
    const { bytes } = encodeVoiceoverWav([tone(0.1)], RATE)
    expect(ascii(bytes, 0, 4)).toBe('RIFF')
    expect(ascii(bytes, 8, 4)).toBe('WAVE')
    expect(ascii(bytes, 12, 4)).toBe('fmt ')
    expect(ascii(bytes, 36, 4)).toBe('data')
    const view = new DataView(bytes.buffer)
    expect(view.getUint16(20, true)).toBe(1) // PCM
    expect(view.getUint16(22, true)).toBe(1) // mono
    expect(view.getUint32(24, true)).toBe(RATE)
    expect(view.getUint16(34, true)).toBe(16) // bit depth
  })

  it('declares sizes that match the bytes actually written', () => {
    const { bytes } = encodeVoiceoverWav([tone(0.05), tone(0.05)], RATE, 0.1)
    const dataBytes = u32(bytes, 40)
    expect(bytes.length).toBe(44 + dataBytes)
    // RIFF size counts everything after the first 8 bytes.
    expect(u32(bytes, 4)).toBe(36 + dataBytes)
  })

  it('lays takes end to end with silence between them', () => {
    const gap = 0.1
    const { bytes, plan } = encodeVoiceoverWav([tone(0.1, 0.5), tone(0.1, 0.5)], RATE, gap)
    const view = new DataView(bytes.buffer)
    const at = (sec: number): number => view.getInt16(44 + Math.round(sec * RATE) * 2, true)

    expect(at(0.05)).toBeGreaterThan(0) // inside line 1
    expect(at(0.15)).toBe(0) // inside the gap
    expect(at(0.25)).toBeGreaterThan(0) // inside line 2
    expect(plan.lineStarts[1]).toBeCloseTo(0.2, 5)
  })

  it('clips samples outside the representable range instead of wrapping', () => {
    // Wrapping would turn a loud take into audible noise.
    const { bytes } = encodeVoiceoverWav([new Float32Array([2, -2])], RATE)
    const view = new DataView(bytes.buffer)
    expect(view.getInt16(44, true)).toBe(32767)
    expect(view.getInt16(46, true)).toBe(-32768)
  })

  it('produces a header-only file for no takes', () => {
    const { bytes, plan } = encodeVoiceoverWav([], RATE)
    expect(bytes.length).toBe(44)
    expect(plan.totalSec).toBe(0)
  })

  it('defaults to the shared line gap', () => {
    const { plan } = encodeVoiceoverWav([tone(1), tone(1)], RATE)
    expect(plan.lineStarts[1]).toBeCloseTo(1 + LINE_GAP_SEC, 5)
  })
})
