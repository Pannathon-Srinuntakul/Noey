/**
 * The editor's first-view gate: the loading screen stays until the strips,
 * the visible tiles and the preview's first frame are all in — and never
 * opens on a manifest alone, which is what left the lanes black after the
 * loading screen went away (owner, 2026-10-01).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createSettleDetector,
  filmstripSettled,
  firstViewGate,
  FIRST_VIEW_CAP_MS,
  waitForFirstFrame,
  type FrameSource
} from './editorFirstView'

const ready = { status: 'ready' as const, done: 3, total: 3 }

describe('firstViewGate', () => {
  it('opens only when strips, tiles and preview are all settled', () => {
    expect(firstViewGate({ filmstrip: ready, tilesSettled: true, previewSettled: true })).toEqual({
      open: true,
      hint: ''
    })
  })

  it('does not open on the strip manifests alone', () => {
    // The old gate: status 'ready' (a cached manifest is instant) opened the
    // editor while every visible tile was still on its way.
    expect(
      firstViewGate({ filmstrip: ready, tilesSettled: false, previewSettled: true }).open
    ).toBe(false)
    expect(
      firstViewGate({ filmstrip: ready, tilesSettled: true, previewSettled: false }).open
    ).toBe(false)
  })

  it('treats a failed or empty filmstrip as settled — an empty lane is not a wait', () => {
    expect(
      firstViewGate({
        filmstrip: { status: 'error', done: 0, total: 2 },
        tilesSettled: true,
        previewSettled: true
      }).open
    ).toBe(true)
    expect(filmstripSettled({ status: 'idle', done: 0, total: 0 })).toBe(true)
    expect(filmstripSettled({ status: 'running', done: 1, total: 2 })).toBe(false)
  })

  it('names the step it waits on, never a percentage', () => {
    const extracting = firstViewGate({
      filmstrip: { status: 'running', done: 1, total: 3 },
      tilesSettled: false,
      previewSettled: false
    })
    expect(extracting.hint).toBe('กำลังเตรียมภาพตัวอย่างวิดีโอ… (2/3)')
    const tiles = firstViewGate({ filmstrip: ready, tilesSettled: false, previewSettled: false })
    expect(tiles.hint).toBe('กำลังโหลดภาพตัวอย่าง…')
    const preview = firstViewGate({ filmstrip: ready, tilesSettled: true, previewSettled: false })
    expect(preview.hint).toBe('กำลังโหลดตัวอย่างเล่น…')
    for (const h of [extracting.hint, tiles.hint, preview.hint]) expect(h).not.toContain('%')
  })

  it('caps the wait at a few seconds', () => {
    expect(FIRST_VIEW_CAP_MS).toBeGreaterThanOrEqual(5000)
    expect(FIRST_VIEW_CAP_MS).toBeLessThanOrEqual(10_000)
  })
})

describe('createSettleDetector', () => {
  it('needs a run of quiet frames, so lanes that have not subscribed yet do not count as done', () => {
    const settled = createSettleDetector(3)
    expect(settled(0)).toBe(false)
    expect(settled(0)).toBe(false)
    // A lane paints and asks for its tiles: the run starts over.
    expect(settled(12)).toBe(false)
    expect(settled(4)).toBe(false)
    expect(settled(0)).toBe(false)
    expect(settled(0)).toBe(false)
    expect(settled(0)).toBe(true)
  })
})

/** A <video> stand-in with just the state the wait reads. */
class FakeVideo implements FrameSource {
  readyState = 0
  seeking = false
  error: unknown = null
  private handlers = new Map<string, Set<() => void>>()
  addEventListener(type: string, fn: () => void): void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set())
    this.handlers.get(type)!.add(fn)
  }
  removeEventListener(type: string, fn: () => void): void {
    this.handlers.get(type)?.delete(fn)
  }
  fire(type: string): void {
    for (const fn of [...(this.handlers.get(type) ?? [])]) fn()
  }
  listenerCount(): number {
    let n = 0
    for (const s of this.handlers.values()) n += s.size
    return n
  }
}

describe('waitForFirstFrame', () => {
  let v: FakeVideo
  beforeEach(() => {
    v = new FakeVideo()
  })
  afterEach(() => {
    expect(v.listenerCount()).toBe(0)
  })

  it('waits past the frame at 0 for the seek to the first scene', async () => {
    let done = false
    const p = waitForFirstFrame(v).then(() => (done = true))
    // loadedmetadata → the player seeks to the in-point; loadeddata fires
    // with that seek still running.
    v.readyState = 2
    v.seeking = true
    v.fire('loadeddata')
    await Promise.resolve()
    expect(done).toBe(false)
    v.seeking = false
    v.fire('seeked')
    await p
    expect(done).toBe(true)
  })

  it('settles on an error — the editor shows it rather than waiting', async () => {
    const p = waitForFirstFrame(v)
    v.error = { code: 4 }
    v.fire('error')
    await expect(p).resolves.toBeUndefined()
  })

  it('resolves at once for a frame already on screen, and on abort', async () => {
    v.readyState = 4
    await waitForFirstFrame(v)
    v.readyState = 0
    const ac = new AbortController()
    const p = waitForFirstFrame(v, ac.signal)
    ac.abort()
    await expect(p).resolves.toBeUndefined()
  })
})
