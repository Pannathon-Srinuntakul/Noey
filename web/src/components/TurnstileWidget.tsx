import { useEffect, useRef, useState } from 'react'
import { loadTurnstile } from '../lib/turnstile'

/**
 * Cloudflare Turnstile, rendered explicitly (the page is an SPA — implicit
 * rendering only scans the document once). Reports each fresh token through
 * `onToken` and '' when it expires or errors. Tokens are single-use: bump
 * `resetKey` after every attempt that spent one.
 *
 * Renders nothing without a site key (the build did not set one).
 */
export function TurnstileWidget({
  siteKey,
  onToken,
  resetKey = 0
}: {
  siteKey: string
  onToken: (token: string) => void
  resetKey?: number
}): React.JSX.Element | null {
  const container = useRef<HTMLDivElement>(null)
  const widgetId = useRef<string | null>(null)
  const onTokenRef = useRef(onToken)
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    onTokenRef.current = onToken
  }, [onToken])

  useEffect(() => {
    if (!siteKey) return
    let cancelled = false
    loadTurnstile()
      .then((api) => {
        if (cancelled || !container.current || widgetId.current) return
        widgetId.current = api.render(container.current, {
          sitekey: siteKey,
          language: 'th',
          theme: 'dark',
          size: 'flexible',
          callback: (token: string) => onTokenRef.current(token),
          'expired-callback': () => onTokenRef.current(''),
          'error-callback': () => onTokenRef.current('')
        })
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true)
      })
    return () => {
      cancelled = true
      if (widgetId.current) window.turnstile?.remove(widgetId.current)
      widgetId.current = null
    }
  }, [siteKey])

  useEffect(() => {
    if (resetKey && widgetId.current) {
      onTokenRef.current('')
      window.turnstile?.reset(widgetId.current)
    }
  }, [resetKey])

  if (!siteKey) return null
  return (
    <div>
      {/* 65px = the widget's own height, reserved so the button does not jump. */}
      <div ref={container} className="min-h-[65px]" />
      {loadFailed ? (
        <p className="mt-1 text-[13px] text-error">
          โหลดตัวยืนยันว่าไม่ใช่บอทไม่สำเร็จ — ตรวจอินเทอร์เน็ตแล้วโหลดหน้านี้ใหม่
        </p>
      ) : null}
    </div>
  )
}
