/**
 * The door: nothing renders until the browser has proved it can do the work and
 * the media service worker is controlling the page.
 *
 * Both checks are here rather than deeper in the app for the same reason —
 * failing late is worse than failing early. A browser that cannot encode video
 * would let someone import footage, wait through an AI cut, and only fall over
 * at export; a page that renders before the worker claims it shows a broken
 * first clip and no obvious cause.
 */

import { useEffect, useState, type ReactNode } from 'react'
import { BrandMark } from '../components/ui/BrandMark'
import { detectCapabilities, type Capabilities } from './capability'
import { ensureProjectsRoot, requestPersistentStorage } from './fs'

type State =
  | { phase: 'checking' }
  | { phase: 'ready' }
  | { phase: 'unsupported'; caps: Capabilities }
  | { phase: 'failed'; message: string }

async function registerMediaWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) throw new Error('เบราว์เซอร์นี้เล่นไฟล์ในเครื่องไม่ได้')
  // Served from public/ at the site root — a worker under /src/ cannot claim
  // '/', which is the scope every /media/... request needs.
  await navigator.serviceWorker.register('/media-sw.js', { scope: '/' })
  await navigator.serviceWorker.ready
  // `ready` resolves once there is an active worker, but a first visit can
  // still be uncontrolled for a tick — the clip that loads in that window 404s.
  if (!navigator.serviceWorker.controller) {
    await new Promise<void>((resolve) => {
      const done = (): void => {
        navigator.serviceWorker.removeEventListener('controllerchange', done)
        resolve()
      }
      navigator.serviceWorker.addEventListener('controllerchange', done)
      // The worker calls clients.claim() on activate, so this lands quickly;
      // the timeout only stops a pathological case from hanging the app.
      setTimeout(done, 3000)
    })
  }
}

export function WebGate({ children }: { children: ReactNode }): React.JSX.Element {
  const [state, setState] = useState<State>({ phase: 'checking' })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const caps = await detectCapabilities()
        if (cancelled) return
        if (!caps.ok) {
          setState({ phase: 'unsupported', caps })
          return
        }
        await registerMediaWorker()
        await ensureProjectsRoot()
        // Ask before anything is stored, not after: this store holds the only
        // copy of the user's footage, and without it the browser is free to
        // evict the lot under disk pressure. A refusal is not fatal — the
        // storage screen reports the state — so the result is not awaited on
        // the critical path beyond this point.
        void requestPersistentStorage()
        if (!cancelled) setState({ phase: 'ready' })
      } catch (err) {
        if (!cancelled) {
          setState({ phase: 'failed', message: err instanceof Error ? err.message : String(err) })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (state.phase === 'ready') return <>{children}</>

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-ground px-6 text-ink">
      <div className="flex w-full max-w-md flex-col items-center gap-5 text-center">
        <BrandMark size={40} />

        {state.phase === 'checking' && (
          <p className="text-sm text-muted">กำลังเตรียมพื้นที่ทำงาน…</p>
        )}

        {state.phase === 'unsupported' && (
          <>
            <h1 className="text-xl font-semibold">เบราว์เซอร์นี้ยังใช้ไม่ได้</h1>
            <p className="text-sm leading-relaxed text-muted">
              การตัดต่อทั้งหมดทำงานบนเครื่องของคุณ เบราว์เซอร์นี้จึงต้องรองรับ
              {state.caps.missing.map((m, i) => (
                <span key={m}>
                  {i === 0 ? ' ' : ' และ '}
                  <span className="text-ink">{m}</span>
                </span>
              ))}
            </p>
            <p className="text-sm leading-relaxed text-muted">
              เปิดด้วย Chrome หรือ Edge เวอร์ชันล่าสุด หรือ Safari 26 ขึ้นไป แล้วลองอีกครั้ง
            </p>
          </>
        )}

        {state.phase === 'failed' && (
          <>
            <h1 className="text-xl font-semibold">เปิดพื้นที่ทำงานไม่สำเร็จ</h1>
            <p className="text-sm leading-relaxed text-muted">{state.message}</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="h-10 rounded-md border border-border px-4 text-[15px] font-semibold text-ink transition-colors duration-state hover:border-border-strong"
            >
              ลองอีกครั้ง
            </button>
          </>
        )}
      </div>
    </div>
  )
}
