import { useCallback, useEffect } from 'react'
import { useConfirm } from './confirm'
import { useJobs } from './jobs'
import { useToast } from './toast'
import { deleteRemote } from './videosLocalApi'

/**
 * Confirm → hide → 10s undo window → actually delete (HANDOFF §6 item 3).
 *
 * The real deletion is *deferred*, not reversed: the project is removed from
 * the list immediately so it feels instant, but nothing touches disk until
 * the undo window closes. Undoing therefore only has to put the row back —
 * there is no restore-from-trash path to get wrong.
 *
 * A pending delete is flushed when the PAGE goes away, so navigating away or
 * quitting cannot strand a project that is hidden from the list but still on
 * disk.
 */

/**
 * MODULE scope, deliberately.
 *
 * This map used to be a `useRef` flushed by the hook's unmount cleanup. Every
 * delete started from the project detail page then navigated straight to the
 * project list — unmounting the detail page, running the cleanup, and
 * committing the delete instantly. The toast still counted down for ten
 * seconds and its "เลิกทำ" was a silent no-op, so an irreversible action was
 * offered an undo it never had. Route changes must not commit a pending
 * delete; only the page going away should.
 */
const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; run: () => void }>()

function flushPending(): void {
  for (const { timer, run } of pending.values()) {
    clearTimeout(timer)
    run()
  }
  pending.clear()
}

export function useDeleteProject(): (uid: string, name: string) => Promise<void> {
  const { jobFor, session, removeProject, reload } = useJobs()
  const confirm = useConfirm()
  const { showToast } = useToast()

  useEffect(() => {
    // `pagehide` rather than `beforeunload`: it is the one event that also
    // fires when a mobile browser discards the tab, which is exactly when a
    // half-deleted project would otherwise be left behind.
    window.addEventListener('pagehide', flushPending)
    return () => window.removeEventListener('pagehide', flushPending)
  }, [])

  return useCallback(
    async (uid: string, name: string) => {
      const ok = await confirm({
        title: `ลบ "${name}" ?`,
        subtitle: 'ลบแล้วกู้คืนไม่ได้หลังหมดเวลาเลิกทำ',
        destructive: true,
        confirmLabel: 'ลบโปรเจกต์',
        footerNote: 'มีเวลาเลิกทำ 10 วินาทีหลังกดลบ',
        body: (
          <p className="text-[15px] leading-[1.7] text-ink-3">
            จะลบคลิปที่ตัดเสร็จ สคริปต์ และไฟล์ต้นฉบับทั้งหมด ทั้งในเครื่องนี้และในบัญชีของคุณ
          </p>
        )
      })
      if (!ok) return

      const remoteUid = jobFor(uid)?.project.remote?.uid
      removeProject(uid)

      const commit = (): void => {
        pending.delete(uid)
        if (remoteUid) deleteRemote(session, remoteUid).catch(() => undefined)
        void window.noey.projects
          .delete(uid)
          .catch((err) => window.noey.log.write('delete', `failed uid=${uid}: ${String(err)}`))
      }

      const timer = setTimeout(commit, 10_000)
      pending.set(uid, { timer, run: commit })

      showToast({
        text: `ลบ ${name} แล้ว`,
        actionLabel: 'เลิกทำ',
        showCountdown: true,
        onAction: () => {
          const entry = pending.get(uid)
          if (!entry) return // window already closed — nothing to undo
          clearTimeout(entry.timer)
          pending.delete(uid)
          reload()
        }
      })
    },
    [confirm, jobFor, session, removeProject, reload, showToast]
  )
}
