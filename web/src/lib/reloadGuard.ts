import { useEffect } from 'react'
import { useConfirm } from './confirm'
import { useJobs } from './jobs'

/**
 * Ask in the app's own dialog before a keyboard reload while any project has
 * work in flight.
 *
 * Only the keyboard reload can be caught. A browser gives a page no say over
 * its toolbar reload button or the tab closing beyond its own generic prompt,
 * and the owner wants the app's dialog, not that prompt (2026-09-21).
 *
 * Reloading no longer throws a paid AI run away — the pipeline finds the
 * server's job again (`findRunningJob` in useProjectPipeline) — but the work
 * done in the browser (shrinking the video, uploading it, rendering) starts
 * over, which is what the dialog says.
 */
/** F5, or Cmd/Ctrl+R with or without Shift. Matched on `code`, not `key`: with
 * a Thai layout active, Cmd+R reports key "พ". */
export function isReloadShortcut(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey'>
): boolean {
  return e.key === 'F5' || ((e.metaKey || e.ctrlKey) && e.code === 'KeyR')
}

export function useReloadGuard(): void {
  const { runningJobs } = useJobs()
  const confirm = useConfirm()
  const busy = runningJobs.length

  useEffect(() => {
    if (busy === 0) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!isReloadShortcut(e)) return
      e.preventDefault()
      void confirm({
        title: 'รีโหลดตอนนี้เลยไหม?',
        body: `มี ${busy} โปรเจกต์กำลังทำงานอยู่ งาน AI บนเซิร์ฟเวอร์ไม่หายและไม่เสียโควตาซ้ำ แอปจะต่อกลับให้เองหลังรีโหลด แต่ขั้นที่ทำในเครื่อง เช่น ย่อวิดีโอ อัปโหลด หรือเรนเดอร์ จะเริ่มใหม่`,
        confirmLabel: 'รีโหลดเลย',
        cancelLabel: 'อยู่ต่อ'
      }).then((ok) => {
        if (ok) window.location.reload()
      })
    }
    // Capture phase, so an editor's own shortcut handler cannot see Cmd+R first.
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [busy, confirm])
}
