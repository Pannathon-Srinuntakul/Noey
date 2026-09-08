import { describe, expect, it } from 'vitest'
import {
  sameCaptionLines,
  sameCaptionStyle,
  sameCuts,
  sameMusic,
  sameSnapshot,
  type EditorSnapshot
} from './editorHistory'
import type { EditorMusic } from './editorApi'

const cut = (
  over: Partial<EditorSnapshot['cuts'][number]> = {}
): EditorSnapshot['cuts'][number] => ({
  id: 'cut0',
  source: 'clip0',
  in: 0,
  out: 2,
  label: 'บรรทัด 1',
  voiceoverLineId: 1,
  voiceoverScript: 'สวัสดี',
  ...over
})

const music = (over: Partial<EditorMusic> = {}): EditorMusic => ({
  path: 'music/a.mp3',
  volume: 0.25,
  offsetSec: 0,
  trimInSec: 0,
  trimOutSec: null,
  muted: false,
  ...over
})

const snap = (over: Partial<EditorSnapshot> = {}): EditorSnapshot => ({
  cuts: [cut()],
  captionLines: [{ id: 'l1', text: 'สวัสดี', start: 0, end: 1 }],
  captionStyle: { font: 'kanit', mode: 'static', color: '#fff', border_color: '#000', size: 48 },
  music: music(),
  ...over
})

describe('snapshot equality', () => {
  it('treats a rebuilt-but-identical snapshot as unchanged', () => {
    // The whole point: every push builds fresh objects, so reference equality
    // would report a change on every focus/blur of a text box.
    expect(sameSnapshot(snap(), snap())).toBe(true)
  })

  it('sees a script line being typed', () => {
    expect(sameCuts([cut()], [cut({ voiceoverScript: 'สวัสดีค่ะ' })])).toBe(false)
  })

  it('sees a cut being retrimmed and reordered', () => {
    expect(sameCuts([cut()], [cut({ out: 2.5 })])).toBe(false)
    expect(
      sameCuts([cut({ id: 'a' }), cut({ id: 'b' })], [cut({ id: 'b' }), cut({ id: 'a' })])
    ).toBe(false)
  })

  it('sees caption text and caption retiming', () => {
    const base = [{ id: 'l1', text: 'สวัสดี', start: 0, end: 1 }]
    expect(sameCaptionLines(base, [{ ...base[0], text: 'หวัดดี' }])).toBe(false)
    expect(sameCaptionLines(base, [{ ...base[0], end: 1.4 }])).toBe(false)
    expect(sameCaptionLines(base, [...base])).toBe(true)
  })

  it('distinguishes no captions at all from an empty list', () => {
    expect(sameCaptionLines(null, [])).toBe(false)
    expect(sameCaptionLines(null, null)).toBe(true)
  })

  it('sees every music parameter the editor can change', () => {
    expect(sameMusic(music(), music({ volume: 0.4 }))).toBe(false)
    expect(sameMusic(music(), music({ offsetSec: 1.2 }))).toBe(false)
    expect(sameMusic(music(), music({ trimInSec: 3 }))).toBe(false)
    expect(sameMusic(music(), music({ trimOutSec: 30 }))).toBe(false)
    expect(sameMusic(music(), music({ muted: true }))).toBe(false)
    expect(sameMusic(music(), music({ path: 'music/b.mp3' }))).toBe(false)
    expect(sameMusic(music(), music())).toBe(true)
  })

  it('sees attaching and detaching the track', () => {
    expect(sameMusic(null, music())).toBe(false)
    expect(sameMusic(music(), null)).toBe(false)
    expect(sameMusic(null, null)).toBe(true)
  })

  it('sees a caption appearance change', () => {
    const style = snap().captionStyle!
    expect(sameCaptionStyle(style, { ...style, size: 60 })).toBe(false)
    expect(sameCaptionStyle(style, { ...style })).toBe(true)
  })

  it('reports a change from ANY field of the snapshot', () => {
    expect(sameSnapshot(snap(), snap({ cuts: [cut({ in: 0.5 })] }))).toBe(false)
    expect(sameSnapshot(snap(), snap({ captionLines: [] }))).toBe(false)
    expect(sameSnapshot(snap(), snap({ music: music({ muted: true }) }))).toBe(false)
    expect(
      sameSnapshot(snap(), snap({ captionStyle: { ...snap().captionStyle!, font: 'sarabun' } }))
    ).toBe(false)
  })
})
