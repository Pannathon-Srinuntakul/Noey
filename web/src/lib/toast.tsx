/* eslint-disable react-refresh/only-export-components -- provider + its hook
 * are colocated by design; splitting `useToast` into its own module would
 * force a circular import back to the context defined here. */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import { Toast } from '../components/ui/Toast'

export interface ToastRequest {
  text: string
  /** Second line — the kit's completion toast is a title plus a detail line. */
  detail?: string
  variant?: 'default' | 'ok'
  actionLabel?: string
  onAction?: () => void
  /** Shows the countdown digit — used by the 10s undo bar. */
  showCountdown?: boolean
  durationMs?: number
}

interface ToastApi {
  showToast: (req: ToastRequest) => void
  dismissToast: () => void
}

const ToastContext = createContext<ToastApi | null>(null)

/** One toast at a time, bottom-right — the design has a single slot, so a
 * newer toast replaces the current one rather than stacking. */
export function ToastProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [toast, setToast] = useState<(ToastRequest & { id: number }) | null>(null)
  const nextId = useRef(0)

  const showToast = useCallback((req: ToastRequest) => {
    setToast({ ...req, id: nextId.current++ })
  }, [])

  const dismissToast = useCallback(() => setToast(null), [])

  const api = useMemo(() => ({ showToast, dismissToast }), [showToast, dismissToast])

  return (
    <ToastContext.Provider value={api}>
      {children}
      {toast ? (
        // Keyed by id so replacing a toast restarts its auto-dismiss timer and
        // countdown instead of inheriting the previous one's remaining time.
        <Toast
          key={toast.id}
          text={toast.text}
          detail={toast.detail}
          variant={toast.variant}
          actionLabel={toast.actionLabel}
          onAction={() => {
            toast.onAction?.()
            dismissToast()
          }}
          onDismiss={dismissToast}
          showCountdown={toast.showCountdown}
          durationMs={toast.durationMs}
        />
      ) : null}
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>')
  return ctx
}
