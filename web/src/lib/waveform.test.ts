import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeAudioPeaks, peaksOf, resetWaveformCache } from './waveform'

describe('peaksOf', () => {
  it('takes the loudest |sample| of each bucket', () => {
    const ch = new Float32Array([0.1, -0.9, 0.2, 0.3, -0.4, 0.05])
    // Float32 rounding: compare to the float32 values, not the literals.
    expect(peaksOf(ch, 3).map((v) => Math.round(v * 100) / 100)).toEqual([0.9, 0.3, 0.4])
  })
})

describe('decodeAudioPeaks cache', () => {
  const realFetch = globalThis.fetch
  const realCtx = (globalThis as { AudioContext?: unknown }).AudioContext
  let fetches = 0
  beforeEach(() => {
    fetches = 0
    resetWaveformCache()
    globalThis.fetch = (async () => {
      fetches += 1
      return new Response(new Uint8Array(4))
    }) as typeof fetch
    ;(globalThis as { AudioContext?: unknown }).AudioContext = class {
      async decodeAudioData(): Promise<{ getChannelData: () => Float32Array; duration: number }> {
        return { getChannelData: () => new Float32Array([0.5, 0.25]), duration: 2 }
      }
      async close(): Promise<void> {
        return undefined
      }
    }
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    ;(globalThis as { AudioContext?: unknown }).AudioContext = realCtx
  })

  it('decodes a project file once per session', async () => {
    const a = await decodeAudioPeaks('/media/u/music/track.mp3')
    const b = await decodeAudioPeaks('/media/u/music/track.mp3')
    expect(a).toEqual(b)
    expect(a.durationSec).toBe(2)
    expect(fetches).toBe(1)
  })

  it('never caches a blob: URL — the caller revokes it', async () => {
    await decodeAudioPeaks('blob:http://x/1')
    await decodeAudioPeaks('blob:http://x/1')
    expect(fetches).toBe(2)
  })

  it('forgets a failed decode so the next caller retries', async () => {
    globalThis.fetch = (async () => {
      fetches += 1
      throw new TypeError('Failed to fetch')
    }) as typeof fetch
    await expect(decodeAudioPeaks('/media/u/music/t.mp3')).rejects.toThrow()
    await expect(decodeAudioPeaks('/media/u/music/t.mp3')).rejects.toThrow()
    expect(fetches).toBe(2)
    expect(vi.isMockFunction(globalThis.fetch)).toBe(false)
  })
})
