import { describe, expect, it } from 'vitest'
import { aiReeditPayload, cutPayload } from './cutPayload'
import type { WorkingCut } from './types'

const cut = (over: Partial<WorkingCut> = {}): WorkingCut => ({
  id: 'cut0',
  source: 'clip0',
  in: 1,
  out: 3,
  label: 'บรรทัด 2',
  voiceoverLineId: 2,
  voiceoverScript: 'สวัสดี',
  ...over
})

describe('cutPayload (draft + render save)', () => {
  it('passes the fields the editor does not model through untouched', () => {
    // Dropping them emptied ปรับช็อต on every save (EditCut.meta).
    const meta = { alternates: [{ source: 'clip1', in: 4, out: 6 }], matchedFrameTime: 1.5 }
    const [sent] = cutPayload([cut({ meta })], true)
    expect(sent.meta).toBe(meta)
    expect(cutPayload([cut({ meta })], false)[0].meta).toBe(meta)
  })

  it('adds no meta key when the cut has none', () => {
    expect('meta' in cutPayload([cut()], true)[0]).toBe(false)
  })

  it('never sends the editor-local id', () => {
    for (const isDub of [true, false]) {
      expect('id' in cutPayload([cut()], isDub)[0]).toBe(false)
    }
  })

  it('sends the voiceover line and script for a dub project', () => {
    expect(cutPayload([cut()], true)[0]).toMatchObject({
      source: 'clip0',
      in: 1,
      out: 3,
      label: 'บรรทัด 2',
      voiceoverLineId: 2,
      voiceoverScript: 'สวัสดี'
    })
  })

  it('falls back to the line parsed from the label, then to null, and to an empty script', () => {
    const [fromLabel, none] = cutPayload(
      [
        cut({ voiceoverLineId: undefined, label: '7', voiceoverScript: undefined }),
        cut({ voiceoverLineId: null, label: 'ฉากใหม่' })
      ],
      true
    )
    expect(fromLabel.voiceoverLineId).toBe(7)
    expect(fromLabel.voiceoverScript).toBe('')
    expect(none.voiceoverLineId).toBeNull()
  })

  it('trims the script where it is stored, not while it is typed', () => {
    const typed = cut({ voiceoverScript: '  สวัสดี \n' })
    expect(cutPayload([typed], true)[0].voiceoverScript).toBe('สวัสดี')
    expect(aiReeditPayload([typed])[0].voiceoverScript).toBe('สวัสดี')
  })

  it('leaves the voiceover fields out of a non-dub project', () => {
    const [sent] = cutPayload([cut()], false)
    expect(sent.voiceoverLineId).toBeUndefined()
    expect(sent.voiceoverScript).toBeUndefined()
    expect(sent).toMatchObject({ source: 'clip0', in: 1, out: 3, label: 'บรรทัด 2' })
  })
})

describe('aiReeditPayload', () => {
  it('always sends the line fields and never meta or id', () => {
    const [sent] = aiReeditPayload([
      cut({ voiceoverLineId: undefined, label: '4', voiceoverScript: null, meta: { a: 1 } })
    ])
    expect(sent).toEqual({
      source: 'clip0',
      in: 1,
      out: 3,
      label: '4',
      voiceoverLineId: 4,
      voiceoverScript: ''
    })
  })
})
