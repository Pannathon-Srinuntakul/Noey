import { useEffect, useState } from 'react'
import { ApiError, type PlanChangePreview } from '../../lib/api'
import { PLAN_CONSENT, planChangeBody, planLabel } from '../../lib/planLadder'
import { Button } from '../ui/Button'
import { Checkbox } from '../ui/Checkbox'
import { Dialog } from '../ui/Dialog'

/**
 * "เปลี่ยนเป็นแผน …" (docs/design/editor-limits.md §6). Asks the server what
 * the change costs NOW (prorated) and from next month, then — only once the
 * billing consent is ticked — goes on. The server re-checks the consent; the
 * disabled button is only the first check.
 *
 * `onConfirm` resolves when the change is done or the payment page is open;
 * it rejects with the reason to show otherwise.
 */
export function PlanChangeDialog({
  tier,
  loadPreview,
  onConfirm,
  onClose
}: {
  tier: string | null
  loadPreview: (tier: string) => Promise<PlanChangePreview>
  onConfirm: (tier: string) => Promise<void>
  onClose: () => void
}): React.JSX.Element | null {
  const [preview, setPreview] = useState<PlanChangePreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [agree, setAgree] = useState(false)
  const [busy, setBusy] = useState(false)

  // Mounted per tier (the caller keys it), so state starts fresh each time.
  useEffect(() => {
    if (!tier) return
    let cancelled = false
    loadPreview(tier)
      .then((p) => {
        if (!cancelled) setPreview(p)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.detail : 'โหลดราคาไม่สำเร็จ')
      })
    return () => {
      cancelled = true
    }
    // `loadPreview` is a fresh closure per render; the tier is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tier])

  if (!tier) return null
  // Moving to Free charges nothing, so it needs no billing consent.
  const needsConsent = tier !== 'free'
  const unavailable = preview?.mode === 'unavailable'
  const ready = preview !== null && !unavailable && (!needsConsent || agree)

  const confirm = async (): Promise<void> => {
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      await onConfirm(tier)
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : String((err as Error)?.message ?? err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`เปลี่ยนเป็นแผน ${planLabel(tier)}`}
      width={560}
      footerNote={
        needsConsent && !agree && preview && !unavailable ? (
          <span className="text-[13px] text-muted">ติ๊กยอมรับเงื่อนไขก่อน</span>
        ) : undefined
      }
      footerActions={
        <>
          <Button variant="secondary" onClick={onClose}>
            ยกเลิก
          </Button>
          {ready ? (
            <Button variant="primary" loading={busy} onClick={() => void confirm()}>
              {preview?.direction === 'upgrade' && preview.mode !== 'mock'
                ? 'ไปหน้าชำระเงิน'
                : 'ยืนยันเปลี่ยนแผน'}
            </Button>
          ) : (
            // Tooltip, not inline text: the footer note already says why, and
            // an inline reason printed it twice and pushed past the dialog edge.
            <Button
              variant="primary"
              reasonAs="tooltip"
              disabled
              disabledReason={
                unavailable
                  ? 'ระบบชำระเงินยังไม่พร้อม'
                  : !preview
                    ? 'กำลังโหลดราคา'
                    : 'ติ๊กยอมรับเงื่อนไขก่อน'
              }
            >
              {preview?.direction === 'upgrade' || !preview ? 'ไปหน้าชำระเงิน' : 'ยืนยันเปลี่ยนแผน'}
            </Button>
          )}
        </>
      }
    >
      {preview ? (
        <p className="text-sm leading-[1.7] text-ink-3">
          {unavailable ? 'ระบบชำระเงินยังไม่พร้อม ลองใหม่ภายหลัง' : planChangeBody(preview)}
        </p>
      ) : !error ? (
        <p className="text-sm text-muted">กำลังคำนวณราคา…</p>
      ) : null}
      {needsConsent && preview && !unavailable ? (
        <div className="mt-4">
          <Checkbox checked={agree} onChange={setAgree} label={PLAN_CONSENT} />
        </div>
      ) : null}
      {error ? (
        <p className="mt-3 text-sm text-error" style={{ userSelect: 'text' }}>
          {error}
        </p>
      ) : null}
    </Dialog>
  )
}
