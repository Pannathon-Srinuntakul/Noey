import { useEffect, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { BrandMark } from '../components/ui/BrandMark'
import { ApiError, login, me } from '../lib/api'
import type { Session } from '../App'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'

/** The backend returns English detail strings; show Thai to the user and keep
 * the original in the log folder for support. Unknown details fall back to a
 * generic line rather than leaking server wording into the UI. */
function loginErrorText(err: unknown): string {
  if (!(err instanceof ApiError)) return 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ — ตรวจอินเทอร์เน็ตแล้วลองใหม่'
  const detail = err.detail.toLowerCase()
  if (detail.includes('invalid credentials') || err.status === 401)
    return 'อีเมลหรือรหัสผ่านไม่ถูกต้อง'
  if (err.status === 429) return 'ลองเข้าสู่ระบบบ่อยเกินไป — รอสักครู่แล้วลองใหม่'
  if (err.status >= 500) return 'เซิร์ฟเวอร์มีปัญหาชั่วคราว — ลองใหม่อีกครั้ง'
  return 'เข้าสู่ระบบไม่สำเร็จ'
}

export default function LoginPage({
  backendUrl,
  onLogin
}: {
  backendUrl: string
  onLogin: (s: Session) => void
}): React.JSX.Element {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [checking, setChecking] = useState(false)
  const [copied, setCopied] = useState(false)

  /** "ตรวจการเชื่อมต่อและลองใหม่" must actually reach the server — the design
   * removed opening the log folder as the way out of a failed sign-in. */
  const checkConnection = async (): Promise<void> => {
    setChecking(true)
    setError(null)
    try {
      // Any answer at all means the network and the host are fine; a 401/404
      // is still a reachable server, so only a thrown fetch counts as down.
      await me(backendUrl, 'connection-probe').catch((err: unknown) => {
        if (err instanceof ApiError) return
        throw err
      })
      setError('เชื่อมต่อเซิร์ฟเวอร์ได้ตามปกติ — ลองเข้าสู่ระบบอีกครั้งได้เลย')
    } catch {
      setError(`ยังต่อเซิร์ฟเวอร์ไม่ได้ (${backendUrl}) — ตรวจอินเทอร์เน็ตแล้วลองใหม่`)
    } finally {
      setChecking(false)
    }
  }

  const copyDiagnostics = async (): Promise<void> => {
    const report = [
      `เซิร์ฟเวอร์: ${backendUrl}`,
      `อีเมล: ${email || '(ยังไม่ได้กรอก)'}`,
      `เวลา: ${new Date().toISOString()}`,
      `ข้อความผิดพลาด: ${error ?? '(ไม่มี)'}`
    ].join('\n')
    await navigator.clipboard.writeText(report).catch(() => undefined)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  }

  useEffect(() => {
    window.noey.auth.load().then((stored) => {
      if (stored) setEmail(stored.email)
    })
  }, [])

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const pair = await login(backendUrl, email, password)
      const profile = await me(backendUrl, pair.access_token)
      await window.noey.auth.save({
        baseUrl: backendUrl,
        email,
        accessToken: pair.access_token,
        refreshToken: pair.refresh_token
      })
      onLogin({
        baseUrl: backendUrl,
        accessToken: pair.access_token,
        refreshToken: pair.refresh_token,
        profile
      })
    } catch (err) {
      void window.noey.log.write('login', `failed for ${email}: ${String(err)}`)
      setError(loginErrorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    // `items-safe-center` keeps the TOP reachable: plain centring pushes the
    // overflow past the start edge, so on a short viewport (a phone in
    // landscape, or with the keyboard up) the top of the card could not be
    // scrolled to at all.
    <div className="flex flex-1 items-safe-center justify-center overflow-y-auto px-5 py-8">
      <div className="w-full max-w-[420px]">
        <div className="mb-8 flex items-center gap-2.5">
          <BrandMark size={26} className="text-accent" />
          <span className="font-display text-[28px] text-ink">Noey Studio</span>
        </div>

        <form onSubmit={submit} className="rounded-md border border-border-faint bg-surface p-8">
          <h1 className="text-2xl font-semibold text-ink">เข้าสู่ระบบ</h1>
          <p className="mb-6 mt-1 text-sm text-muted">
            ตัดต่อได้เลยในเบราว์เซอร์ งานเก็บไว้ในบัญชีของคุณ เปิดต่อจากเครื่องไหนก็ได้
          </p>

          <div className="flex flex-col gap-4">
            <Input
              label="อีเมล"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
              required
              id="login-email"
            />
            <div>
              <div className="mb-1.5 flex items-baseline justify-between">
                <label htmlFor="login-password" className="text-sm text-muted">
                  รหัสผ่าน
                </label>
                <button
                  type="button"
                  onClick={() =>
                    setError(
                      'ลืมรหัสผ่าน — ตั้งรหัสใหม่ได้จากแอปบนมือถือ แล้วกลับมาเข้าสู่ระบบอีกครั้ง'
                    )
                  }
                  className="text-sm text-accent underline hover:text-accent-hover-text"
                >
                  ลืมรหัสผ่าน
                </button>
              </div>
              {/* The reveal toggle lives inside the field's border (R1 screen 1),
                  so focus styling stays on the wrapper rather than the input:
                  the global `*:focus-visible` ring would otherwise be drawn
                  around the bare inner input, INSIDE the field's own border.
                  `data-focus-ring="none"` opts the input out of it (that rule
                  is unlayered, so no utility class can override it). */}
              <div
                className={`flex h-10 w-full items-center rounded-md border bg-transparent pr-1 pl-3 transition-colors duration-state ease-out focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[color:var(--color-accent)] ${
                  error ? 'border-error' : 'border-border'
                }`}
              >
                <input
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  data-focus-ring="none"
                  className="min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'ซ่อนรหัสผ่าน' : 'ดูรหัสผ่าน'}
                  title={showPassword ? 'ซ่อนรหัสผ่าน' : 'ดูรหัสผ่าน'}
                  className="rounded p-1.5 text-muted transition-colors duration-state hover:text-ink"
                >
                  {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
            </div>

            {error ? (
              <div className="rounded-md border border-error bg-error-tint px-3 py-2.5">
                <p
                  className="text-[13px] leading-relaxed text-error"
                  style={{ userSelect: 'text' }}
                >
                  {error}
                </p>
                <button
                  type="button"
                  onClick={copyDiagnostics}
                  className="mt-1 text-[13px] text-muted underline hover:text-ink"
                >
                  {copied ? 'คัดลอกแล้ว' : 'คัดลอกข้อมูลแจ้งปัญหา'}
                </button>
              </div>
            ) : null}

            <Button type="submit" variant="primary" loading={busy} className="w-full">
              {busy ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบ'}
            </Button>
          </div>
        </form>

        <p className="mt-5 text-center text-sm text-muted">
          เข้าไม่ได้?{' '}
          <button
            type="button"
            onClick={checkConnection}
            disabled={checking}
            className="text-accent underline hover:text-accent-hover-text disabled:opacity-60"
          >
            {checking ? 'กำลังตรวจการเชื่อมต่อ…' : 'ตรวจการเชื่อมต่อและลองใหม่'}
          </button>{' '}
          ·{' '}
          <button
            type="button"
            onClick={copyDiagnostics}
            className="text-accent underline hover:text-accent-hover-text"
          >
            {copied ? 'คัดลอกแล้ว' : 'คัดลอกข้อมูลแจ้งปัญหา'}
          </button>
        </p>
      </div>
    </div>
  )
}
