import { useEffect, useState } from 'react'
import { estimateUsage, type ApiSession } from './videosLocalApi'
import { estimateKey } from './usageEstimate'
import type { EstimateRequest, UsageEstimate as Estimate } from './usageLimits'

/** Quiet period after the last change before asking — dragging clips around
 * or flipping a tier should cost one request, not one per keystroke. */
const DEBOUNCE_MS = 450

/**
 * The server's estimate for `req`, refetched whenever it changes. Null while
 * there is nothing to ask (see `estimateRequestFor`), while loading, and when
 * the request failed — a failed preview is silent on purpose: the start route
 * enforces the limit regardless, and a broken estimate must not block work.
 */
export function useUsageEstimate(
  session: ApiSession,
  req: EstimateRequest | null
): { estimate: Estimate | null; loading: boolean } {
  const key = estimateKey(req)
  const [answer, setAnswer] = useState<{ key: string; estimate: Estimate | null } | null>(null)

  useEffect(() => {
    if (!key) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      estimateUsage(session, JSON.parse(key) as EstimateRequest)
        .then((estimate) => {
          if (!cancelled) setAnswer({ key, estimate })
        })
        .catch(() => {
          if (!cancelled) setAnswer({ key, estimate: null })
        })
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
    // `session` is one object per provider render; the key is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  if (!key) return { estimate: null, loading: false }
  // An answer for an older request is not shown against the new one.
  if (answer?.key !== key) return { estimate: null, loading: true }
  return { estimate: answer.estimate, loading: false }
}
