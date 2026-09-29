/**
 * Settings → บัญชี: sign-in methods (Google link / unlink) and self-service
 * account deletion (PDPA).
 *
 * Server contract: docs/google-sign-in.md, backend routers `auth_google.py`
 * and `account.py`. Both cards read the account's CURRENT state from
 * `GET /auth/me` (`has_password`, `google_linked`, `google_email`) rather than
 * the profile captured at sign-in, which predates any link made since.
 *
 * Destructive steps go through the app's own dialogs (`Dialog`, `useConfirm`)
 * — never `window.confirm`.
 */

import { useCallback, useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { Session } from '../../App'
import { ApiError, deleteAccount, googleConfig, googleUnlink, me, type Me } from '../../lib/api'
import { bahtText, deletionAnswer } from '../../lib/accountDeletion'
import { useConfirm } from '../../lib/confirm'
import { withFreshToken } from '../../lib/freshToken'
import {
  beginGoogle,
  googleErrorText,
  peekGoogleOutcome,
  takeGoogleOutcome,
  type GoogleOutcome
} from '../../lib/googleAuth'
import { useToast } from '../../lib/toast'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Input } from '../ui/Input'

function Card({
  title,
  hint,
  children
}: {
  title: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="rounded-md border border-divider p-5">
      <p className="text-item font-semibold text-ink">{title}</p>
      {hint ? <p className="mt-1 text-sm leading-[1.6] text-muted">{hint}</p> : null}
      <div className="mt-3.5">{children}</div>
    </section>
  )
}

function Notice({
  tone,
  children
}: {
  tone: 'ok' | 'error'
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <p
      role={tone === 'error' ? 'alert' : 'status'}
      className={`mb-3 rounded-md border px-3 py-2.5 text-[13px] leading-relaxed ${
        tone === 'error' ? 'border-error bg-error-tint text-error' : 'border-divider text-ink'
      }`}
      style={{ userSelect: 'text' }}
    >
      {children}
    </p>
  )
}

/**
 * The account as the server sees it now, plus whether Google sign-in is
 * configured there. `reload` after a link/unlink.
 */
function useAccountState(session: Session): {
  profile: Me | null
  googleEnabled: boolean
  reload: () => Promise<void>
} {
  const [profile, setProfile] = useState<Me | null>(null)
  const [googleEnabled, setGoogleEnabled] = useState(false)

  const reload = useCallback(async (): Promise<void> => {
    try {
      setProfile(await withFreshToken(session, me))
    } catch {
      // The cards fall back to the password path; nothing here is fatal.
    }
  }, [session])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [p, c] = await Promise.all([
        withFreshToken(session, me).catch(() => null),
        googleConfig(session.baseUrl).catch(() => ({ enabled: false }))
      ])
      if (cancelled) return
      if (p) setProfile(p)
      setGoogleEnabled(c.enabled === true)
    })()
    return () => {
      cancelled = true
    }
  }, [session])

  return { profile, googleEnabled, reload }
}

// ── sign-in methods ─────────────────────────────────────────────────────────

function GoogleLinkCard({
  session,
  profile,
  googleEnabled,
  outcome,
  onChanged
}: {
  session: Session
  profile: Me | null
  googleEnabled: boolean
  outcome: GoogleOutcome | null
  onChanged: () => Promise<void>
}): React.JSX.Element | null {
  const confirm = useConfirm()
  const { showToast } = useToast()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(() => {
    if (outcome?.kind === 'linked')
      return { tone: 'ok', text: `เชื่อมต่อบัญชี Google (${outcome.googleEmail}) แล้ว` }
    if (outcome?.kind === 'error' && outcome.intent === 'link')
      return { tone: 'error', text: outcome.message }
    return null
  })

  const linked = profile?.google_linked === true
  // A server without Google configured shows nothing here — unless the
  // account is already linked, which must stay visible and unlinkable.
  if (!linked && !googleEnabled) return null
  if (!profile) return null

  const link = async (): Promise<void> => {
    setBusy(true)
    setNotice(null)
    try {
      await withFreshToken(session, (baseUrl, accessToken) =>
        beginGoogle({
          baseUrl,
          origin: window.location.origin,
          intent: 'link',
          returnTo: 'settings',
          accessToken
        })
      )
    } catch (err) {
      setNotice({ tone: 'error', text: googleErrorText(err) })
      setBusy(false)
    }
  }

  const unlink = async (): Promise<void> => {
    const ok = await confirm({
      title: 'ยกเลิกการเชื่อมต่อ Google?',
      body: `จะเข้าสู่ระบบด้วยบัญชี Google (${profile.google_email ?? ''}) ไม่ได้อีก ต้องใช้อีเมลและรหัสผ่านแทน`,
      confirmLabel: 'ยกเลิกการเชื่อมต่อ',
      destructive: true
    })
    if (!ok) return
    setBusy(true)
    setNotice(null)
    try {
      await withFreshToken(session, googleUnlink)
      showToast({ text: 'ยกเลิกการเชื่อมต่อ Google แล้ว', variant: 'ok' })
      await onChanged()
    } catch (err) {
      const text =
        err instanceof ApiError && err.code === 'password_required'
          ? 'กรุณาตั้งรหัสผ่านก่อนยกเลิกการเชื่อมต่อ Google — ออกจากระบบแล้วใช้ “ลืมรหัสผ่าน” ด้วยอีเมลนี้ ไม่อย่างนั้นจะเข้าสู่ระบบไม่ได้อีก'
          : err instanceof ApiError && err.code === 'no_google_link'
            ? 'บัญชีนี้ไม่ได้เชื่อมต่อกับ Google อยู่แล้ว'
            : googleErrorText(err)
      setNotice({ tone: 'error', text })
      await onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card
      title="วิธีเข้าสู่ระบบ"
      hint="เชื่อมต่อบัญชี Google เพื่อเข้าสู่ระบบได้โดยไม่ต้องพิมพ์รหัสผ่าน"
    >
      {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
      {linked ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="min-w-0 break-words text-sm text-ink" style={{ userSelect: 'text' }}>
            เชื่อมต่อกับ Google แล้ว
            {profile.google_email ? (
              <span className="text-muted"> · {profile.google_email}</span>
            ) : null}
          </p>
          <Button variant="secondary" loading={busy} onClick={() => void unlink()}>
            ยกเลิกการเชื่อมต่อ
          </Button>
        </div>
      ) : (
        <Button variant="secondary" loading={busy} onClick={() => void link()}>
          เชื่อมต่อ Google
        </Button>
      )}
    </Card>
  )
}

// ── delete account ──────────────────────────────────────────────────────────

function DeleteAccountDialog({
  open,
  session,
  profile,
  googleEnabled,
  reauthToken,
  initialError,
  onClose,
  onDeleted
}: {
  open: boolean
  session: Session
  profile: Me | null
  googleEnabled: boolean
  /** A fresh Google re-auth proof (5 minutes), when the person just did one. */
  reauthToken: string | null
  initialError: string | null
  onClose: () => void
  onDeleted: () => void
}): React.JSX.Element {
  const confirm = useConfirm()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(initialError)
  const [busy, setBusy] = useState(false)
  const [reauthBusy, setReauthBusy] = useState(false)

  // An older server does not send `has_password`: assume the password path,
  // which is the only one it has.
  const usePassword = profile?.has_password !== false
  const canGoogleReauth = !usePassword && (profile?.google_linked ?? false) && googleEnabled
  const ready = usePassword ? password.length > 0 : Boolean(reauthToken)

  const startReauth = async (): Promise<void> => {
    setReauthBusy(true)
    setError(null)
    try {
      await withFreshToken(session, (baseUrl, accessToken) =>
        beginGoogle({
          baseUrl,
          origin: window.location.origin,
          intent: 'reauth',
          returnTo: 'settings',
          accessToken
        })
      )
    } catch (err) {
      setError(googleErrorText(err))
      setReauthBusy(false)
    }
  }

  const submit = async (): Promise<void> => {
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    const proof = usePassword ? { password } : { reauth_token: reauthToken ?? '' }
    try {
      let forfeit = false
      for (;;) {
        try {
          await withFreshToken(session, (baseUrl, accessToken) =>
            deleteAccount(baseUrl, accessToken, {
              ...proof,
              ...(forfeit ? { forfeit_wallet_balance: true } : {})
            })
          )
          onDeleted()
          return
        } catch (err) {
          const answer = deletionAnswer(err)
          if (answer.kind === 'wallet' && !forfeit) {
            const ok = await confirm({
              title: `ยอดเงินคงเหลือ ${bahtText(answer.balanceSatang)} จะหายไป`,
              body: 'ยังมียอดเงินคงเหลือในกระเป๋า ซึ่งจะหายไปและขอคืนไม่ได้เมื่อลบบัญชี ต้องการลบต่อหรือไม่?',
              confirmLabel: 'ลบบัญชีและสละยอดเงิน',
              destructive: true
            })
            if (!ok) return
            forfeit = true
            continue
          }
          setError(answer.message)
          return
        }
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      onConfirm={() => void submit()}
      title="ลบบัญชีถาวร"
      subtitle={profile?.email ?? session.profile.email}
      width={560}
      footerActions={
        <>
          <Button variant="ghost" onClick={onClose}>
            ยกเลิก
          </Button>
          {ready ? (
            <Button variant="danger" loading={busy} onClick={() => void submit()}>
              ลบบัญชีถาวร
            </Button>
          ) : (
            <Button
              variant="danger"
              disabled
              disabledReason={usePassword ? 'กรอกรหัสผ่านก่อน' : 'ยืนยันตัวตนด้วย Google ก่อน'}
            >
              ลบบัญชีถาวร
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4 text-sm leading-[1.6] text-ink-2">
        <div>
          <p>สิ่งที่จะถูกลบและกู้คืนไม่ได้:</p>
          <ul className="mt-1.5 list-disc pl-5 text-muted">
            <li>โปรเจกต์ วิดีโอ และไฟล์ทั้งหมดบนเซิร์ฟเวอร์</li>
            <li>สไตล์ที่บันทึกไว้ และการเชื่อมต่อ Google</li>
            <li>แผนที่ชำระเงินอยู่จะถูกยกเลิกทันที (ไม่คืนเงินส่วนที่เหลือ)</li>
            <li>สำเนาในเบราว์เซอร์นี้</li>
          </ul>
          <p className="mt-2 text-muted">
            ประวัติการชำระเงินและการใช้งานจะถูกเก็บไว้โดยไม่ระบุตัวตนตามที่กฎหมายบัญชีและภาษีกำหนด
          </p>
        </div>

        {error ? <Notice tone="error">{error}</Notice> : null}

        {usePassword ? (
          <Input
            id="delete-account-password"
            label="ยืนยันด้วยรหัสผ่านปัจจุบัน"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
        ) : reauthToken ? (
          <Notice tone="ok">ยืนยันตัวตนกับ Google แล้ว — กด “ลบบัญชีถาวร” ภายใน 5 นาที</Notice>
        ) : canGoogleReauth ? (
          <div>
            <p className="mb-2 text-muted">บัญชีนี้ไม่มีรหัสผ่าน — ยืนยันตัวตนกับ Google ก่อนลบ</p>
            <Button variant="secondary" loading={reauthBusy} onClick={() => void startReauth()}>
              ยืนยันตัวตนด้วย Google
            </Button>
          </div>
        ) : (
          <Notice tone="error">
            บัญชีนี้ไม่มีรหัสผ่าน และตอนนี้ยืนยันตัวตนกับ Google ไม่ได้ — ตั้งรหัสผ่านผ่าน
            “ลืมรหัสผ่าน” ก่อน แล้วกลับมาลบบัญชี
          </Notice>
        )}
      </div>
    </Dialog>
  )
}

function DeleteAccountCard({
  session,
  profile,
  googleEnabled,
  outcome,
  onDeleted
}: {
  session: Session
  profile: Me | null
  googleEnabled: boolean
  outcome: GoogleOutcome | null
  onDeleted: () => void
}): React.JSX.Element {
  // A Google re-auth return opens the dialog again, with the proof (or the
  // reason it failed) — the person left from this dialog.
  // Read once, at mount: an initializer, so the expiry check is not re-run
  // (impurely) on every render.
  const [initial] = useState(() => ({
    proof:
      outcome?.kind === 'reauth' && outcome.expiresAt > Date.now() ? outcome.reauthToken : null,
    error: outcome?.kind === 'error' && outcome.intent === 'reauth' ? outcome.message : null
  }))
  const reauthError = initial.error
  const [open, setOpen] = useState(Boolean(initial.proof || initial.error))
  const [reauthToken, setReauthToken] = useState<string | null>(initial.proof)

  return (
    <Card title="ลบบัญชี" hint="ลบบัญชีและข้อมูลทั้งหมดของคุณออกจากระบบอย่างถาวร ย้อนกลับไม่ได้">
      <Button variant="danger" icon={<Trash2 size={16} />} onClick={() => setOpen(true)}>
        ลบบัญชี…
      </Button>
      {profile?.is_admin ? (
        <p className="mt-2 text-sm text-muted">
          บัญชีผู้ดูแลระบบลบเองไม่ได้ — ให้ผู้ดูแลระบบคนอื่นถอดสิทธิ์ผู้ดูแลก่อน
        </p>
      ) : null}
      {/* Keyed so each opening starts from an empty form. */}
      <DeleteAccountDialog
        key={open ? 'open' : 'closed'}
        open={open}
        session={session}
        profile={profile}
        googleEnabled={googleEnabled}
        reauthToken={reauthToken}
        initialError={open ? reauthError : null}
        onClose={() => {
          setOpen(false)
          // A proof is single-purpose and short-lived: closing drops it.
          setReauthToken(null)
        }}
        onDeleted={onDeleted}
      />
    </Card>
  )
}

/** Both account cards; picks up a Google return that landed on this tab. */
export function AccountSecurity({
  session,
  onAccountDeleted
}: {
  session: Session
  onAccountDeleted: () => void
}): React.JSX.Element {
  const { profile, googleEnabled, reload } = useAccountState(session)
  // Peek during render (StrictMode may run an initializer twice), clear once
  // committed, so the outcome is shown exactly once per return.
  const [outcome] = useState<GoogleOutcome | null>(() => peekGoogleOutcome())
  useEffect(() => {
    if (outcome) takeGoogleOutcome()
  }, [outcome])

  return (
    <>
      <GoogleLinkCard
        session={session}
        profile={profile}
        googleEnabled={googleEnabled}
        outcome={outcome}
        onChanged={reload}
      />
      <DeleteAccountCard
        session={session}
        profile={profile}
        googleEnabled={googleEnabled}
        outcome={outcome}
        onDeleted={onAccountDeleted}
      />
    </>
  )
}
