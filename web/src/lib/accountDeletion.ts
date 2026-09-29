/**
 * Self-service account deletion (PDPA) — the decisions the UI makes on the
 * server's answer, kept out of the component so they are unit-tested.
 *
 * Server: `POST /auth/delete-account` (backend/services/api/routers/account.py,
 * backend/packages/auth/account_deletion.py). It needs re-authentication (the
 * current password, or a Google `reauth_token` for an account with no
 * password), is idempotent, and answers every refusal as
 * `detail: {code, message}` with a Thai message that is safe to show.
 */

import { ApiError } from './api'

export type DeletionAnswer =
  /** A prepaid balance would be forfeited: ask again, then resend with
   * `forfeit_wallet_balance: true`. */
  | { kind: 'wallet'; balanceSatang: number; message: string }
  /** The password was wrong or the Google proof lapsed — stay on the form. */
  | { kind: 'reauth'; message: string }
  /** Anything else: show the message. The account is intact; retry is safe. */
  | { kind: 'message'; message: string }

export function deletionAnswer(err: unknown): DeletionAnswer {
  if (!(err instanceof ApiError)) {
    return {
      kind: 'message',
      message: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ — บัญชียังไม่ถูกลบ ลองใหม่อีกครั้ง'
    }
  }
  if (err.status === 0) {
    return {
      kind: 'message',
      message: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ — บัญชียังไม่ถูกลบ ลองใหม่อีกครั้ง'
    }
  }
  if (err.code === 'wallet_balance') {
    const raw = err.extra?.balance_satang
    const balanceSatang = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
    return { kind: 'wallet', balanceSatang, message: err.detail }
  }
  if (
    err.code === 'wrong_password' ||
    err.code === 'reauth_required' ||
    err.code === 'reauth_invalid'
  ) {
    return { kind: 'reauth', message: err.detail }
  }
  if (err.status === 429) {
    return { kind: 'message', message: 'ลองบ่อยเกินไป — รอสักครู่แล้วลองใหม่' }
  }
  if (err.status === 401) {
    return { kind: 'message', message: 'เซสชันหมดอายุ — เข้าสู่ระบบใหม่แล้วลองอีกครั้ง' }
  }
  // 403 admin_account, 502 billing_cancel_failed, 503 billing_unavailable /
  // deletion_incomplete: the server's Thai message says what to do. A 503
  // `billing_unavailable` message may name STRIPE_SECRET_KEY — an operator
  // variable, not a vendor the UI must hide — but a generic line reads better.
  if (err.code === 'billing_unavailable') {
    return {
      kind: 'message',
      message: 'ยกเลิกแผนที่ชำระเงินอยู่ไม่ได้ในขณะนี้ บัญชียังไม่ถูกลบ — ติดต่อทีมงาน'
    }
  }
  if (err.code && err.detail) return { kind: 'message', message: err.detail }
  return { kind: 'message', message: 'ลบบัญชีไม่สำเร็จ บัญชียังไม่ถูกลบ — ลองใหม่อีกครั้ง' }
}

/** ฿ text for a satang amount, e.g. 12345 → "฿123.45", 5000 → "฿50". */
export function bahtText(satang: number): string {
  const baht = satang / 100
  return `฿${baht.toLocaleString('th-TH', {
    minimumFractionDigits: Number.isInteger(baht) ? 0 : 2,
    maximumFractionDigits: 2
  })}`
}
