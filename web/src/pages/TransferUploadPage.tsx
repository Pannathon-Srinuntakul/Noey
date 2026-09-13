import { useRef, useState } from 'react'
import { Check, Loader2, Upload } from 'lucide-react'
import { cn } from '../lib/cn'
import { BACKEND_URL } from '../lib/backendUrl'

/**
 * The page a phone lands on after scanning the รับจากมือถือ QR.
 *
 * Deliberately OUTSIDE the app: no login (the single-use token in the URL is
 * the whole credential), no capability gate (this page needs a file input and
 * nothing else — the mobile "ยังไม่รองรับ" gate must never block it, because a
 * phone is exactly who it is for), no service worker, no OPFS. main.tsx routes
 * `/transfer/<token>` here before anything else mounts.
 *
 * Uploads go straight to the backend relay (`routers/transfer.py`); the
 * desktop computer's browser polls the same ticket and pulls the files down,
 * then deletes them — the server keeps nothing.
 *
 * XHR rather than fetch for the upload: a phone video is hundreds of MB over
 * an unpredictable radio, and upload progress is the difference between
 * "working" and "frozen". fetch still has no portable upload progress.
 */

interface Row {
  name: string
  bytes: number
  state: 'uploading' | 'done' | 'error'
  percent: number
  error?: string
}

function fmtMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function TransferUploadPage({ token }: { token: string }): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  // One at a time: parallel uploads on a phone radio starve each other and
  // every progress bar crawls; a queue keeps one honest bar moving.
  const queueRef = useRef<Promise<void>>(Promise.resolve())

  const uploadOne = (file: File, rowIndex: number): Promise<void> =>
    new Promise((resolve) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `${BACKEND_URL}/videos/transfer/${token}/upload`)
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return
        const percent = Math.round((e.loaded / e.total) * 100)
        setRows((prev) => prev.map((r, i) => (i === rowIndex ? { ...r, percent } : r)))
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          setRows((prev) =>
            prev.map((r, i) => (i === rowIndex ? { ...r, state: 'done', percent: 100 } : r))
          )
        } else {
          let detail = 'ส่งไม่สำเร็จ — ลองใหม่อีกครั้ง'
          try {
            detail = (JSON.parse(xhr.responseText) as { detail?: string }).detail ?? detail
          } catch {
            /* not JSON — keep the generic line */
          }
          setRows((prev) =>
            prev.map((r, i) => (i === rowIndex ? { ...r, state: 'error', error: detail } : r))
          )
        }
        resolve()
      }
      xhr.onerror = () => {
        setRows((prev) =>
          prev.map((r, i) =>
            i === rowIndex
              ? { ...r, state: 'error', error: 'ส่งไม่สำเร็จ (เน็ตหลุด) — ลองใหม่อีกครั้ง' }
              : r
          )
        )
        resolve()
      }
      const form = new FormData()
      form.append('file', file, file.name)
      xhr.send(form)
    })

  // Row indices come from a ref, NOT from reading state inside the updater:
  // queueing an upload is a side effect, and React (StrictMode, and free to do
  // so any time) may run an updater twice — which sent every clip to the
  // server TWICE (caught live in verification, 2026-09-09). The updater below
  // is pure; the queueing happens exactly once out here.
  const nextIndexRef = useRef(0)
  const addFiles = (files: File[]): void => {
    if (files.length === 0) return
    const start = nextIndexRef.current
    nextIndexRef.current += files.length
    setRows((prev) => [
      ...prev,
      ...files.map<Row>((f) => ({
        name: f.name,
        bytes: f.size,
        state: 'uploading',
        percent: 0
      }))
    ])
    files.forEach((f, i) => {
      queueRef.current = queueRef.current.then(() => uploadOne(f, start + i))
    })
  }

  const doneCount = rows.filter((r) => r.state === 'done').length
  const busy = rows.some((r) => r.state === 'uploading')

  return (
    <div className="flex min-h-dvh flex-col items-center bg-ground px-5 pb-[max(24px,env(safe-area-inset-bottom))] pt-10 text-ink">
      <div className="w-full max-w-md">
        <h1 className="text-[22px] font-semibold">ส่งวิดีโอไปที่คอม</h1>
        <p className="mt-1.5 text-sm leading-[1.6] text-muted">
          เลือกคลิปจากเครื่องนี้ แล้วมันจะไปโผล่ในหน้าสร้างวิดีโอบนคอมเอง
          ส่งเสร็จแล้วปิดหน้านี้ได้เลย
        </p>

        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className={cn(
            'mt-6 flex h-[140px] w-full flex-col items-center justify-center gap-2.5 rounded-md',
            'border border-dashed border-[rgb(217_164_65_/_0.5)] bg-[rgb(217_164_65_/_0.05)]'
          )}
        >
          <Upload size={26} className="text-accent" strokeWidth={1.6} />
          <span className="text-[16px] font-semibold">เลือกวิดีโอ</span>
          <span className="text-[13px] text-muted">เลือกได้ทีละหลายไฟล์</span>
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="video/*"
          multiple
          hidden
          onChange={(e) => {
            addFiles(Array.from(e.currentTarget.files ?? []))
            e.currentTarget.value = ''
          }}
        />

        {rows.length > 0 ? (
          <div className="mt-5 flex flex-col gap-2.5">
            {rows.map((r, i) => (
              <div key={`${r.name}-${i}`} className="rounded-md border border-divider px-4 py-3">
                <div className="flex items-center gap-2.5">
                  {r.state === 'done' ? (
                    <Check size={15} className="shrink-0 text-ok" />
                  ) : r.state === 'error' ? null : (
                    <Loader2 size={15} className="shrink-0 animate-spin text-accent" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-[15px]">{r.name}</span>
                  <span className="shrink-0 text-[13px] tabular-nums text-muted">
                    {r.state === 'uploading' ? `${r.percent}%` : fmtMB(r.bytes)}
                  </span>
                </div>
                {r.state === 'uploading' ? (
                  <div className="mt-2.5 h-1 rounded-[2px] bg-[rgb(243_242_242_/_0.18)]">
                    <div
                      className="h-1 rounded-[2px] bg-accent transition-[width] duration-state ease-out"
                      style={{ width: `${r.percent}%` }}
                    />
                  </div>
                ) : null}
                {r.state === 'error' ? (
                  <p className="mt-1.5 text-[13px] leading-[1.5] text-error">{r.error}</p>
                ) : null}
              </div>
            ))}
            {!busy && doneCount > 0 ? (
              <p className="mt-1 text-center text-sm text-ok">
                ส่งแล้ว {doneCount} ไฟล์ — ดูต่อที่หน้าจอคอมได้เลย
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
