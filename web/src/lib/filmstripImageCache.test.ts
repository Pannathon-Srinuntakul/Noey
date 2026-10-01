/**
 * `loadingTileCount` is what the editor's first-view gate polls: tiles a lane
 * on screen is waiting for that have not decoded yet. A tile nobody waits for
 * any more must not hold the gate.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Node has no Image: a stand-in that decodes when the test says so. */
class FakeImage {
  static all: FakeImage[] = []
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  decoding = ''
  src = ''
  constructor() {
    FakeImage.all.push(this)
  }
}
;(globalThis as unknown as { Image: unknown }).Image = FakeImage

beforeEach(() => {
  FakeImage.all = []
  vi.resetModules()
})

const noop = (): void => undefined

describe('loadingTileCount', () => {
  it('counts subscribed tiles until they decode or fail', async () => {
    const cache = await import('./filmstripImageCache')
    cache.subscribeFilmstripImage('/t1.jpg', noop, noop)
    cache.subscribeFilmstripImage('/t2.jpg', noop, noop)
    expect(cache.loadingTileCount()).toBe(2)

    FakeImage.all[0].onload?.()
    expect(cache.loadingTileCount()).toBe(1)
    expect(cache.getDecodedFilmstripImage('/t1.jpg')).not.toBeNull()

    // A failed tile is settled too: the lane keeps its placeholder.
    FakeImage.all[1].onerror?.()
    expect(cache.loadingTileCount()).toBe(0)
  })

  it('stops counting a tile once no lane waits for it', async () => {
    const cache = await import('./filmstripImageCache')
    const off = cache.subscribeFilmstripImage('/scrolled-away.jpg', noop, noop)
    expect(cache.loadingTileCount()).toBe(1)
    off()
    expect(cache.loadingTileCount()).toBe(0)
  })
})
