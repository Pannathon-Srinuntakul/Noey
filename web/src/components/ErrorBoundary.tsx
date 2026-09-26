import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from './ui/Button'

/**
 * The last line before a white screen.
 *
 * React unmounts the whole tree when a render throws and nothing catches it.
 * In this app that meant a bad frame in one screen — a caption line with no
 * text, a timeline entry an older build wrote — took the running job's host
 * with it, and the only way back was a manual reload that nobody knew to do
 * because the page was simply blank. Mounted BELOW the job providers so a
 * render that is mid-way keeps going, and around the route only, so the
 * shell and its navigation survive too.
 *
 * A class on purpose: `getDerivedStateFromError` has no hook equivalent.
 */
interface Props {
  children: ReactNode
  /** Where the failure is written. Injected so the boundary has no import of
   * the platform shim (and is trivially testable). */
  onError?: (message: string) => void
}

interface State {
  failed: boolean
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    const stack = info.componentStack?.split('\n').slice(0, 6).join(' > ') ?? ''
    this.props.onError?.(`${message}${stack ? ` — ${stack}` : ''}`)
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div
          role="alert"
          className="flex w-full max-w-[420px] flex-col gap-4 rounded-md border border-border-faint bg-surface p-6"
        >
          <p className="text-lg font-semibold text-ink">เกิดข้อผิดพลาด — โหลดหน้าใหม่</p>
          <p className="text-sm text-muted">
            หน้านี้แสดงผลไม่ได้ งานที่กำลังทำอยู่ยังทำต่อ และโปรเจกต์ของคุณยังอยู่ครบ
            โหลดหน้าใหม่แล้วเปิดอีกครั้งได้เลย
          </p>
          <div className="flex justify-end">
            <Button variant="primary" onClick={() => window.location.reload()}>
              โหลดหน้าใหม่
            </Button>
          </div>
        </div>
      </div>
    )
  }
}
