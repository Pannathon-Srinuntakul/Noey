import { describe, expect, it } from 'vitest'
import { previewCandidates } from './usePreviewFile'

/**
 * Two regressions live here.
 *
 * The first: at step `done` the preview short-circuited to `final.mp4` and
 * never looked for `final_fx.mp4`, so every effects render was invisible on
 * the project page while the export shipped it — "AI สร้าง effect มา แล้วแก้
 * effect ไม่เปลี่ยน" (2026-09-07). That is why the bake is asked for FIRST,
 * on a build that can make one.
 *
 * The second, and why this file asserts a web-shaped cascade: the browser
 * build has no render-effects runner at all, so `final_fx.mp4` can only ever
 * be a file left on the SERVER by an earlier render — and asking for it first
 * played the previous cut after a new one was made ("กดทำคลิปใหม่ แล้วคลิปยัง
 * เป็นอันเดิม", 2026-09-25). `canUseZoomEffects` decides, so the same source
 * keeps the 2026-09-07 behaviour on desktop and drops the probe on web.
 */
describe('previewCandidates', () => {
  it('does not ask for a bake this build cannot make', () => {
    expect(previewCandidates('done', 'talking_head')).toEqual(['final.mp4'])
    expect(previewCandidates('done', 'dub_first')).toEqual(['final.mp4'])
  })

  it('always ends on a file that is guaranteed to exist', () => {
    // The last entry is returned without a probe, so it must never be optional.
    expect(previewCandidates('done', 'dub_first')?.at(-1)).toBe('final.mp4')
    expect(previewCandidates('waiting_vo', 'dub_first')?.at(-1)).toBe('final_silent.mp4')
  })

  it('keeps the silent cascade for waiting_vo and for highlight', () => {
    const silent = ['final_silent_music.mp4', 'final_silent.mp4']
    expect(previewCandidates('waiting_vo', 'dub_first')).toEqual(silent)
    // `highlight` never runs the VO mux, so its `done` is the same situation.
    expect(previewCandidates('done', 'highlight')).toEqual(silent)
  })

  it('leaves speech_highlights alone — it has no final.mp4 to offer', () => {
    expect(previewCandidates('done', 'speech_highlights')).toBeNull()
    expect(previewCandidates('waiting_vo', 'speech_highlights')).toBeNull()
  })

  it('has nothing to show before a render exists', () => {
    expect(previewCandidates('importing', 'dub_first')).toBeNull()
    expect(previewCandidates('analyzing', 'dub_first')).toBeNull()
    expect(previewCandidates('silent_rendering', 'dub_first')).toBeNull()
  })
})
