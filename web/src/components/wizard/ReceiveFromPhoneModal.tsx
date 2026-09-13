import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { Check, Loader2, Smartphone } from 'lucide-react'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { authedFetch } from '../../lib/authedFetch'
import type { ApiSession } from '../../lib/videosLocalApi'

/**
 * รับจากมือถือ, web edition.
 *
 * The desktop app does this over LAN (its main process runs a listener). A
 * browser cannot listen on anything, so the web goes through the backend as a
 * COURIER (`routers/transfer.py`): this modal opens a ticket, shows its QR,
 * polls what the phone has sent, and on นำเข้า pulls each file down as a
 * `File` for the wizard's normal picked-file path — then DELETEs the ticket,
 * so the server keeps nothing. Closing without importing also deletes it.
 *
 * The QR encodes `<this origin>/transfer/<token>` — a page main.tsx renders
 * for phones without login or the capability gate.
 */

interface TicketFile {
  index: number
  name: string
  bytes: number
}

function fmtMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function ReceiveFromPhoneModal({
  session,
  onClose,
  onReceived
}: {
  session: ApiSession
  onClose: () => void
  /** The downloaded clips, ready for the same path a file picker feeds. */
  onReceived: (files: File[]) => void
}): React.JSX.Element {
  const [token, setToken] = useState<string | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [files, setFiles] = useState<TicketFile[]>([])
  const [error, setError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  // The ticket outlives renders but not the modal: closing deletes it, and the
  // ref is what the cleanup can still read after state is gone.
  const tokenRef = useRef<string | null>(null)

  // Open a ticket + draw its QR.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await authedFetch(session, '/videos/transfer', { method: 'POST' })
        if (!res.ok) throw new Error('เปิดรอบรับไฟล์ไม่สำเร็จ — ลองใหม่อีกครั้ง')
        const { token: t } = (await res.json()) as { token: string }
        if (cancelled) return
        tokenRef.current = t
        setToken(t)
        const url = `${window.location.origin}/transfer/${t}`
        setQr(await QRCode.toDataURL(url, { margin: 1, width: 480 }))
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      cancelled = true
      // Whatever happened, the server must not keep the footage: close the
      // ticket on the way out. (After a successful import this 404s — the
      // import already deleted it — which the catch swallows.)
      const t = tokenRef.current
      if (t) {
        void authedFetch(session, `/videos/transfer/${t}`, { method: 'DELETE' }).catch(
          () => undefined
        )
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Poll what the phone has sent so far.
  useEffect(() => {
    if (!token) return
    let cancelled = false
    const tick = async (): Promise<void> => {
      try {
        const res = await authedFetch(session, `/videos/transfer/${token}`)
        if (!res.ok) return
        const status = (await res.json()) as { files: TicketFile[] }
        if (!cancelled) setFiles(status.files)
      } catch {
        // A missed poll is just the next poll's problem.
      }
    }
    void tick()
    const timer = window.setInterval(() => void tick(), 2500)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  const importAll = async (): Promise<void> => {
    if (!token || files.length === 0) return
    setImporting(true)
    try {
      const out: File[] = []
      for (const f of files) {
        const res = await authedFetch(session, `/videos/transfer/${token}/files/${f.index}`)
        if (!res.ok) throw new Error(`ดึงไฟล์ ${f.name} ไม่สำเร็จ — ลองอีกครั้ง`)
        const blob = await res.blob()
        out.push(new File([blob], f.name, { type: blob.type || 'video/mp4' }))
      }
      // Bytes are in hand — the relay's copy goes now, not on unmount, so the
      // window where the server holds footage is as short as it can be.
      await authedFetch(session, `/videos/transfer/${token}`, { method: 'DELETE' }).catch(
        () => undefined
      )
      tokenRef.current = null
      onReceived(out)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setImporting(false)
    }
  }

  return (
    <Dialog open onClose={onClose} title="รับวิดีโอจากมือถือ" width={560}>
      <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start sm:gap-6">
        <div className="shrink-0">
          {qr ? (
            // White padding around the code — dark-theme background eats the
            // quiet zone and some phone cameras refuse to lock on.
            <img
              src={qr}
              alt="QR สำหรับเปิดหน้าอัพโหลดบนมือถือ"
              className="h-[210px] w-[210px] rounded-md bg-white p-2"
            />
          ) : (
            <div className="flex h-[210px] w-[210px] items-center justify-center rounded-md bg-media">
              <Loader2 size={22} className="animate-spin text-muted" />
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <p className="text-sm leading-[1.7] text-ink-2">
            สแกน QR ด้วยกล้องมือถือ แล้วเลือกวิดีโอจากเครื่อง ไฟล์จะมาโผล่ในรายการด้านล่างเอง
          </p>
          <p className="text-[13px] leading-[1.6] text-muted">
            ใช้ได้ 30 นาทีต่อรอบ · ไฟล์ถูกลบออกจากตัวกลางทันทีที่รับเข้าเครื่องนี้แล้ว
          </p>

          {files.length === 0 ? (
            <p className="flex items-center gap-2 rounded-md border border-divider px-4 py-3 text-sm text-muted">
              <Smartphone size={15} className="shrink-0" />
              รอไฟล์จากมือถือ…
              <Loader2 size={14} className="ml-auto shrink-0 animate-spin text-accent" />
            </p>
          ) : (
            <div className="flex max-h-[180px] flex-col gap-1.5 overflow-y-auto">
              {files.map((f) => (
                <p
                  key={f.index}
                  className="flex items-center gap-2 rounded-md border border-divider px-4 py-2.5 text-sm"
                >
                  <Check size={14} className="shrink-0 text-ok" />
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  <span className="shrink-0 text-[13px] tabular-nums text-muted">
                    {fmtMB(f.bytes)}
                  </span>
                </p>
              ))}
            </div>
          )}

          {error ? <p className="text-[13px] leading-[1.5] text-error">{error}</p> : null}

          <div className="mt-1 flex items-center justify-end gap-3">
            <Button variant="ghost" onClick={onClose}>
              ยกเลิก
            </Button>
            {files.length > 0 ? (
              <Button variant="primary" loading={importing} onClick={() => void importAll()}>
                {importing ? 'กำลังนำเข้า…' : `นำเข้า ${files.length} ไฟล์`}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </Dialog>
  )
}
