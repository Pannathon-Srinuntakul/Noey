import { useEffect, useMemo, useState } from 'react'
import { Download } from 'lucide-react'
import { fmtSize, selectedIds, selectedSummary, toKindRows, type Artifact } from '../lib/artifacts'
import { ArtifactChecklist } from './ArtifactChecklist'
import { Button } from './ui/Button'
import { Dialog } from './ui/Dialog'
import { useJobs } from '../lib/jobs'
import { useToast } from '../lib/toast'

/**
 * "ส่งออกวิดีโอ" — the same checklist ส่งไปมือถือ uses, writing to disk.
 *
 * The button used to export one file with no question asked: whatever the
 * preview happened to be showing. Which file that was depended on the project's
 * step and on a probe race, so "ส่งออก" and "ส่งไปมือถือ" could hand over
 * different things from the same project (live report 2026-08-13).
 *
 * One ticked file goes through a Save dialog; several go into a folder the user
 * picks (see main/lanReceive's exportProjectArtifacts).
 */
export default function ExportVideoModal({
  projectUid,
  projectName,
  /** True while a render is in flight — the artifacts on disk are the PREVIOUS
   * render, which is worth saying out loud before someone posts one. */
  running,
  onClose
}: {
  projectUid: string
  projectName: string
  running: boolean
  onClose: () => void
}): React.JSX.Element {
  const { showToast } = useToast()
  const { jobFor, session } = useJobs()
  const [artifacts, setArtifacts] = useState<Artifact[] | null>(null)
  const [checked, setChecked] = useState<Set<Artifact['kind']>>(new Set(['final']))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      // Refresh what the server holds BEFORE listing.
      //
      // `artifacts()` runs in the platform layer, which has no session and can
      // only read the cached manifest. On a project whose files live on the
      // server and not in this browser — one opened elsewhere, or synced
      // before this cache existed — a stale or absent cache made the checklist
      // come up empty and say "ยังไม่มีไฟล์ให้ส่งออก" about a project the user
      // is looking at a finished preview of. The download itself always worked.
      const remoteUid = jobFor(projectUid)?.project.remote?.uid
      if (remoteUid) {
        const { serverManifest } = await import('../lib/projectSync')
        await serverManifest(session, remoteUid, projectUid).catch(() => [])
      }
      if (cancelled) return
      try {
        const list = await window.noey.lan.artifacts(projectUid)
        if (!cancelled) setArtifacts(list as Artifact[])
      } catch {
        if (!cancelled) setError('อ่านรายการไฟล์ของโปรเจกต์ไม่ได้')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [projectUid, jobFor, session])

  const rows = useMemo(() => (artifacts ? toKindRows(artifacts) : new Map()), [artifacts])
  const { files, bytes } = selectedSummary(rows, checked)

  const toggle = (kind: Artifact['kind']): void => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
      return next
    })
  }

  const run = async (): Promise<void> => {
    setError(null)
    setBusy(true)
    try {
      const result = await window.noey.projects.exportArtifacts(
        projectUid,
        selectedIds(rows, checked),
        projectName
      )
      // null = the user cancelled the dialog; the modal stays open so they can
      // pick again rather than losing the ticks they just made.
      if (result) {
        showToast({
          text: result.files === 1 ? 'ส่งออกไฟล์แล้ว' : `ส่งออก ${result.files} ไฟล์แล้ว`,
          detail: result.dir,
          variant: 'ok'
        })
        onClose()
      }
    } catch (err) {
      void window.noey.log.write('export', `failed uid=${projectUid}: ${String(err)}`)
      // The real reason, in the box — which is already selectable. There is no
      // log folder in a browser (`platform/misc.ts` keeps an in-memory ring
      // and `openFolder` only console.logs it), so pointing at one left the
      // user with a failure and nowhere to look.
      setError(`ส่งออกไม่สำเร็จ — ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="ส่งออกวิดีโอ"
      subtitle={`${projectName} · เลือกไฟล์ที่จะส่งออก`}
      width={620}
      footerNote={files > 0 ? `เลือกไว้ ${files} ไฟล์ · ${fmtSize(bytes)}` : undefined}
      footerActions={
        <>
          <Button variant="ghost" onClick={onClose}>
            ยกเลิก
          </Button>
          {files > 0 ? (
            <Button
              variant="primary"
              icon={<Download size={16} />}
              loading={busy}
              onClick={() => void run()}
            >
              ส่งออก
            </Button>
          ) : (
            <Button
              variant="primary"
              icon={<Download size={16} />}
              disabled
              disabledReason="เลือกอย่างน้อย 1 รายการ"
            >
              ส่งออก
            </Button>
          )}
        </>
      }
    >
      {error ? (
        <p
          className="mb-4 rounded-md border border-error px-4 py-3 text-sm text-error"
          style={{ userSelect: 'text' }}
        >
          {error}
        </p>
      ) : null}
      {running ? (
        <p className="mb-4 rounded-md border border-divider px-4 py-3 text-sm text-muted">
          โปรเจกต์นี้กำลังเรนเดอร์อยู่ — ไฟล์ที่ได้ตอนนี้คือของรอบก่อนหน้า
        </p>
      ) : null}
      <ArtifactChecklist
        artifacts={artifacts}
        rows={rows}
        checked={checked}
        onToggle={toggle}
        emptyNote="ยังไม่มีไฟล์ให้ส่งออก — เรนเดอร์โปรเจกต์ให้เสร็จก่อน"
      />
    </Dialog>
  )
}
