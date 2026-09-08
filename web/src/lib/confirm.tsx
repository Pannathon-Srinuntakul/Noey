/* eslint-disable react-refresh/only-export-components -- provider + its hook
 * are colocated by design; splitting `useConfirm` into its own module would
 * force a circular import back to the context defined here. */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import { Button } from '../components/ui/Button'
import { Dialog } from '../components/ui/Dialog'

export interface ConfirmRequest {
  title: string
  subtitle?: string
  /** Destructive confirms should name the object and list what disappears. */
  body: React.ReactNode
  confirmLabel: string
  cancelLabel?: string
  destructive?: boolean
  footerNote?: React.ReactNode
}

type ConfirmFn = (req: ConfirmRequest) => Promise<boolean>

const ConfirmContext = createContext<ConfirmFn | null>(null)

/** Promise-based confirm dialog — replaces the two-click-then-immediate
 * delete pattern the app used before, and never `window.confirm`. */
export function ConfirmProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [request, setRequest] = useState<ConfirmRequest | null>(null)
  const resolveRef = useRef<((ok: boolean) => void) | null>(null)

  const settle = useCallback((ok: boolean) => {
    resolveRef.current?.(ok)
    resolveRef.current = null
    setRequest(null)
  }, [])

  const confirm = useCallback<ConfirmFn>((req) => {
    // A second confirm while one is open resolves the first as cancelled
    // rather than orphaning its promise forever.
    resolveRef.current?.(false)
    setRequest(req)
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve
    })
  }, [])

  const api = useMemo(() => confirm, [confirm])

  return (
    <ConfirmContext.Provider value={api}>
      {children}
      <Dialog
        open={request !== null}
        onClose={() => settle(false)}
        onConfirm={() => settle(true)}
        title={request?.title ?? ''}
        subtitle={request?.subtitle}
        width={560}
        footerNote={request?.footerNote}
        footerActions={
          <>
            <Button variant="ghost" onClick={() => settle(false)}>
              {request?.cancelLabel ?? 'ยกเลิก'}
            </Button>
            <Button
              variant={request?.destructive ? 'danger' : 'primary'}
              onClick={() => settle(true)}
            >
              {request?.confirmLabel ?? 'ตกลง'}
            </Button>
          </>
        }
      >
        {request?.body}
      </Dialog>
    </ConfirmContext.Provider>
  )
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext)
  if (!ctx) throw new Error('useConfirm must be used inside <ConfirmProvider>')
  return ctx
}
