/**
 * SubRip output, pinned against `render_common.write_srt`.
 *
 * Someone opens this file in another editor, so the format is the interface:
 * a wrong separator or a comma where a full stop belongs makes the whole file
 * silently unreadable there.
 */

import { describe, expect, it } from 'vitest'
import { buildSrt } from './bundle'

describe('buildSrt', () => {
  it('numbers cues from one and separates them with a blank line', () => {
    const srt = buildSrt([
      { start: 0, end: 1.5, text: 'หนึ่ง' },
      { start: 1.5, end: 3, text: 'สอง' }
    ])
    expect(srt).toBe(
      [
        '1',
        '00:00:00,000 --> 00:00:01,500',
        'หนึ่ง',
        '',
        '2',
        '00:00:01,500 --> 00:00:03,000',
        'สอง',
        ''
      ].join('\n')
    )
  })

  it('uses a comma before the milliseconds, as SubRip requires', () => {
    expect(buildSrt([{ start: 0.25, end: 0.5, text: 'x' }])).toContain('00:00:00,250')
  })

  it('carries hours and minutes past the one-hour mark', () => {
    const srt = buildSrt([{ start: 3661.007, end: 3662, text: 'x' }])
    expect(srt).toContain('01:01:01,007 --> 01:01:02,000')
  })

  it('clamps a negative start rather than writing a negative timestamp', () => {
    expect(buildSrt([{ start: -2, end: 1, text: 'x' }])).toContain('00:00:00,000')
  })

  it('returns an empty string when there is nothing to write', () => {
    expect(buildSrt([])).toBe('')
  })
})
