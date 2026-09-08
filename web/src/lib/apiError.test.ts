import { describe, expect, it } from 'vitest'

import { apiErrorDetail } from './apiError'

describe('apiErrorDetail', () => {
  it('passes a plain string detail through', () => {
    expect(apiErrorDetail(400, { detail: 'ไม่พบโปรเจกต์' })).toBe('ไม่พบโปรเจกต์')
  })

  it('reads FastAPI 422 validation arrays', () => {
    const body = {
      detail: [
        { loc: ['body', 'cuts', 0, 'in'], msg: 'Input should be a valid number', type: 'float' },
        { loc: ['body', 'mode'], msg: 'Field required', type: 'missing' }
      ]
    }
    const msg = apiErrorDetail(422, body)
    expect(msg).toContain('in: Input should be a valid number')
    expect(msg).toContain('mode: Field required')
    expect(msg).not.toContain('HTTP 422')
  })

  it('falls back to the status when the body says nothing', () => {
    expect(apiErrorDetail(500, {})).toBe('HTTP 500')
    expect(apiErrorDetail(500, null)).toBe('HTTP 500')
    expect(apiErrorDetail(500, 'boom')).toBe('HTTP 500')
    expect(apiErrorDetail(422, { detail: [] })).toBe('HTTP 422')
  })

  it('uses `message` when there is no detail', () => {
    expect(apiErrorDetail(502, { message: 'upstream timed out' })).toBe('upstream timed out')
  })
})
