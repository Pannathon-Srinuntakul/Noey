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

  it('words a billing refusal instead of showing HTTP 402', () => {
    const msg = apiErrorDetail(402, {
      detail: { code: 'limit_reached', window: 'weekly', resets_at: null, wallet_can_cover: false }
    })
    expect(msg).toBe('โควตารายสัปดาห์หมดแล้ว')
    expect(apiErrorDetail(503, { detail: { code: 'service_paused', message: 'พักระบบ' } })).toBe(
      'พักระบบ'
    )
  })

  it('reads the message of any other object detail', () => {
    expect(apiErrorDetail(409, { detail: { message: 'ชนกัน' } })).toBe('ชนกัน')
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

describe('responseErrorDetail', () => {
  it('maps a transport failure (status 0, non-JSON body) to the Thai message, never "HTTP 0"', async () => {
    const { responseErrorDetail } = await import('./apiError')
    const res = {
      status: 0,
      json: () => JSON.parse('Failed to fetch') as unknown
    }
    expect(responseErrorDetail(res)).toBe('เชื่อมต่อ server ไม่ได้ ลองใหม่อีกครั้ง')
  })

  it('still reads a JSON detail', async () => {
    const { responseErrorDetail } = await import('./apiError')
    expect(responseErrorDetail({ status: 404, json: () => ({ detail: 'ไม่พบโปรเจกต์' }) })).toBe(
      'ไม่พบโปรเจกต์'
    )
  })

  it('falls back to HTTP <status> for a non-JSON server error', async () => {
    const { responseErrorDetail } = await import('./apiError')
    const res = { status: 502, json: () => JSON.parse('<html>Bad gateway</html>') as unknown }
    expect(responseErrorDetail(res)).toBe('HTTP 502')
  })
})
