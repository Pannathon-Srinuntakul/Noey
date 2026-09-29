import { describe, expect, it } from 'vitest'
import { ApiError, errorFromResponse } from './api'
import { bahtText, deletionAnswer } from './accountDeletion'

/** The shape the server really sends: `detail: {code, message, ...}`. */
function refused(status: number, detail: Record<string, unknown>): ApiError {
  const body = JSON.stringify({ detail })
  return errorFromResponse({ status, json: () => JSON.parse(body) })
}

describe('errorFromResponse keeps the code and extras', () => {
  it('carries code, Thai message and balance', () => {
    const err = refused(409, {
      code: 'wallet_balance',
      message: 'ยังมียอดเงินคงเหลือ',
      balance_satang: 12345
    })
    expect(err.code).toBe('wallet_balance')
    expect(err.detail).toBe('ยังมียอดเงินคงเหลือ')
    expect(err.extra?.balance_satang).toBe(12345)
  })

  it('has no code for a string detail', () => {
    const err = errorFromResponse({ status: 400, json: () => ({ detail: 'nope' }) })
    expect(err.code).toBeNull()
    expect(err.detail).toBe('nope')
  })
})

describe('deletionAnswer', () => {
  it('asks again for a wallet balance', () => {
    const a = deletionAnswer(
      refused(409, { code: 'wallet_balance', message: 'm', balance_satang: 5000 })
    )
    expect(a).toEqual({ kind: 'wallet', balanceSatang: 5000, message: 'm' })
  })

  it('tolerates a missing balance', () => {
    const a = deletionAnswer(refused(409, { code: 'wallet_balance', message: 'm' }))
    expect(a.kind === 'wallet' && a.balanceSatang).toBe(0)
  })

  it('keeps the form open for re-auth failures', () => {
    for (const code of ['wrong_password', 'reauth_required', 'reauth_invalid']) {
      expect(deletionAnswer(refused(400, { code, message: 'รหัสผ่านไม่ถูกต้อง' }))).toEqual({
        kind: 'reauth',
        message: 'รหัสผ่านไม่ถูกต้อง'
      })
    }
  })

  it('shows the server message for admin / incomplete / billing cancel', () => {
    const m = 'ลบข้อมูลได้ไม่ครบในครั้งนี้ บัญชียังไม่ถูกลบ — กรุณาลองใหม่อีกครั้ง'
    expect(deletionAnswer(refused(503, { code: 'deletion_incomplete', message: m }))).toEqual({
      kind: 'message',
      message: m
    })
  })

  it('never shows the billing_unavailable message (it names an env variable)', () => {
    const a = deletionAnswer(
      refused(503, { code: 'billing_unavailable', message: 'x (STRIPE_SECRET_KEY not set)' })
    )
    expect(a.message).not.toMatch(/STRIPE/)
  })

  it('maps transport and throttling to Thai', () => {
    expect(deletionAnswer(new TypeError('Failed to fetch')).message).toMatch(/ยังไม่ถูกลบ/)
    expect(deletionAnswer(new ApiError(429, 'Too Many Requests')).message).toMatch(/บ่อยเกินไป/)
    expect(deletionAnswer(new ApiError(500, 'Internal Server Error')).message).not.toMatch(
      /Internal/
    )
  })
})

describe('bahtText', () => {
  it('formats satang as baht', () => {
    expect(bahtText(5000)).toBe('฿50')
    expect(bahtText(12345)).toBe('฿123.45')
    expect(bahtText(123456700)).toBe('฿1,234,567')
  })
})
