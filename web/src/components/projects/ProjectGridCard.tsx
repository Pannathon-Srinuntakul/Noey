import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Film, Layers, MoreVertical, Play, RotateCcw, Sparkles } from 'lucide-react'
import type { LocalProject } from '@renderer/platform/types'
import { isBusy, type ProjectStep } from '../../lib/projectFlow'
import { useConfirm } from '../../lib/confirm'
import { useRouter } from '../../lib/router'
import { VideoModal } from '../ui/VideoModal'
import type { ProjectPipeline } from '../../lib/useProjectPipeline'
import { usePreviewFile } from '../../lib/usePreviewFile'
import { seekToPosterFrame } from '../../lib/videoPoster'
import { Button } from '../ui/Button'
import { Menu } from '../ui/Menu'
import { Skeleton } from '../ui/Skeleton'
import { StatusLine, type Status } from '../ui/StatusLine'
import { MODE_LABEL } from '../../lib/modeLabel'
import { canOpenFolder } from '../../lib/platformFeatures'
import { RecutDialog } from './RecutDialog'

/** One status per card — no progress bar, no AI thinking log (those moved to
 * the running-job bar and the progress page respectively, HANDOFF §6 item 7). */
function statusFor(
  step: ProjectStep,
  error?: string | null,
  /** Round number while a recut is running — same `working` status, the label
   * just says which attempt this is (HANDOFF R12.5). */
  recutRound?: number,
  /** speech_highlights: how many clips the render produced — the card's "done"
   * has to say the COUNT, because many-clips is this mode's whole difference. */
  highlightCount?: number
): { status: Status; label: string } {
  // A failed card says WHY on the card (R1 screen 2) — "ทำงานไม่สำเร็จ" alone
  // makes the user open the project just to read the reason.
  if (step === 'error') return { status: 'error', label: error?.trim() || 'ทำงานไม่สำเร็จ' }
  if (step === 'done' && highlightCount) {
    return { status: 'ok', label: `ไฮไลต์พร้อมใช้ ${highlightCount} คลิป` }
  }
  if (step === 'done') return { status: 'ok', label: 'คลิปพร้อมใช้' }
  if (step === 'waiting_vo') return { status: 'ok', label: 'คลิปพร้อมใช้' }
  if (isBusy(step)) {
    return {
      status: 'working',
      label: recutRound ? `กำลังตัดใหม่ · รอบที่ ${recutRound}` : 'กำลังทำงาน'
    }
  }
  return { status: 'idle', label: 'ยังไม่เริ่ม' }
}

/** "15 ส.ค. 07:13" — shared by the meta line and the revert row's sublabel. */
function fmtWhen(iso: string): string {
  const d = new Date(iso)
  return `${d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString(
    'th-TH',
    { hour: '2-digit', minute: '2-digit' }
  )}`
}

function formatMeta(project: LocalProject): string {
  const base = `${fmtWhen(project.updatedAt)} · ${MODE_LABEL[project.mode ?? 'dub_first']}`
  // Appended to the date line rather than shown as its own badge: the card
  // already carries one status line, and two badges on one card read worse
  // than a longer sentence (HANDOFF R12.5).
  const round = project.recutNotes?.at(-1)?.round
  return round ? `${base} · ตัดใหม่รอบที่ ${round}` : base
}

export function ProjectGridCard({
  job,
  onOpen,
  onDelete
}: {
  job: ProjectPipeline
  onOpen: () => void
  onDelete: () => void
}): React.JSX.Element {
  const { navigate } = useRouter()
  const confirm = useConfirm()
  const [menuOpen, setMenuOpen] = useState(false)
  const [playerOpen, setPlayerOpen] = useState(false)
  const [recutOpen, setRecutOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ top?: number; bottom?: number; left: number } | null>(
    null
  )
  const menuRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const step = job.step as ProjectStep
  const busy = isBusy(step)
  // Recut needs a cut to improve on. `isTerminal` would also match `error`,
  // which has its own "ลองใหม่" button on the card.
  const ready = step === 'done' || step === 'waiting_vo'
  const kept = job.project.previousRender
  const recutRound = job.project.recutNotes?.at(-1)?.round
  const highlightCount =
    job.mode === 'speech_highlights'
      ? Number((job.project.highlightIndex as { count?: number } | undefined)?.count) || undefined
      : undefined
  const { status, label } = statusFor(
    step,
    job.error,
    busy ? recutRound : undefined,
    highlightCount
  )

  const onRevert = async (): Promise<void> => {
    if (!kept) return
    const ok = await confirm({
      title: `ย้อนกลับไปคลิปรอบที่ ${kept.round}?`,
      body: 'คลิปรอบล่าสุดจะถูกลบ ย้อนกลับแล้วเรียกคืนไม่ได้',
      confirmLabel: 'ย้อนกลับ',
      destructive: true
    })
    if (ok) await job.revertRecut()
  }
  // Keyed by the same string the <video> is keyed by: when the file or the
  // render changes the key changes, so the error clears itself instead of
  // needing a setState inside an effect.
  const [brokenKey, setBrokenKey] = useState<string | null>(null)
  // One silent retry before believing the error — the first load right after a
  // re-render can catch the file-swap window (same fix as the detail page).
  const [previewNonce, setPreviewNonce] = useState(0)
  const retriedRef = useRef<string | null>(null)
  // Which highlight the big player is on. Always opens at the first: the card
  // shows that one's still, so starting anywhere else would not match the
  // picture that was clicked.
  const [playerIndex, setPlayerIndex] = useState(0)
  const previewFile = usePreviewFile(job.project.uid, step, job.mode, job.mediaKey, {
    fallbackClipFile: job.project.clips?.[0]?.file,
    hasHighlights: (highlightCount ?? 0) > 0
  })

  // speech_highlights ships N finished clips; the picture can only show one, so
  // the player it opens carries all of them (the comment above the picture
  // records that people click it to WATCH, not to navigate).
  const highlights =
    job.mode === 'speech_highlights'
      ? ((
          job.project.highlightIndex as
            { items?: { id: string; durationSec?: number; title?: string }[] } | undefined
        )?.items ?? [])
      : []
  // `title` already exists in highlights/index.json (written when the AI picked
  // the ranges) — the rail shows it so a row says what the highlight is about
  // instead of just "7 · 0:45" (R17c.3).
  const playlist = highlights.map((h, i) => ({
    id: h.id,
    label: String(i + 1),
    durationSec: Number(h.durationSec) || 0,
    title: h.title?.trim() || undefined
  }))
  const playing = playlist[playerIndex]
  const modalFile = playlist.length > 1 && playing ? `highlights/${playing.id}.mp4` : previewFile
  const previewKey = `${job.project.uid}-${previewFile}-${job.mediaKey}-${previewNonce}`
  const broken = brokenKey === previewKey

  /** Menu width + row heights are fixed, so its box can be measured from the
   * trigger without waiting for a layout pass. Flips above the button when the
   * window is too short below — a five-row menu opened on a bottom-row card
   * would otherwise run off the viewport. */
  const openMenu = (): void => {
    const r = triggerRef.current?.getBoundingClientRect()
    if (!r) return
    const MENU_W = 210
    // Upper bound, used only to decide whether the menu fits below the button
    // (one row is taller with a sublabel; the folder row exists only where it
    // can open). Opening upward is anchored by the menu's BOTTOM edge: placing
    // its top at r.top - estimate left a gap as tall as the estimate's excess
    // wherever the real menu was shorter (live report 2026-09-21, web).
    const height = kept ? 210 : 196
    const below = window.innerHeight - r.bottom
    const left = Math.max(8, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8))
    setMenuPos(
      below >= height + 12
        ? { top: r.bottom + 4, left }
        : { bottom: window.innerHeight - r.top + 4, left }
    )
    setMenuOpen(true)
  }

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent): void => {
      // The panel lives in a portal, so it is NOT inside menuRef any more —
      // both have to be checked or the first click inside the menu closes it.
      const t = e.target as Node
      if (!menuRef.current?.contains(t) && !panelRef.current?.contains(t)) setMenuOpen(false)
    }
    // Fixed coordinates were captured at open time; scrolling the grid would
    // leave the panel behind, so it closes instead of drifting.
    const onScrollOrResize = (): void => setMenuOpen(false)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('scroll', onScrollOrResize, true)
      window.removeEventListener('resize', onScrollOrResize)
    }
  }, [menuOpen])

  return (
    <div className="flex w-full max-w-[325px] flex-col overflow-hidden rounded-md border border-border-faint bg-surface">
      {previewFile ? (
        <VideoModal
          open={playerOpen}
          onClose={() => setPlayerOpen(false)}
          src={window.noey.media.urlFor(job.project.uid, modalFile ?? previewFile)}
          // The highlight id has to be IN the key, or switching clips leaves
          // the same <video> element mounted with a new src it never reloads.
          mediaKey={`${job.project.uid}-${modalFile ?? previewFile}-${job.mediaKey}`}
          title={job.project.name}
          playlist={playlist.length > 1 ? playlist : undefined}
          index={playerIndex}
          onIndexChange={setPlayerIndex}
        />
      ) : null}
      {/* Mounted only while open so the typed comment resets with it — a
          reset effect would be a setState inside an effect for no gain. */}
      {recutOpen ? (
        <RecutDialog
          open
          project={job.project}
          onClose={() => setRecutOpen(false)}
          onSubmit={(text, allowWallet) => {
            setRecutOpen(false)
            // Consent rides on the project row and is spent by the start call.
            void (async () => {
              if (allowWallet) await job.patch({ allowWallet: true })
              await job.recut(text)
            })()
          }}
        />
      ) : null}
      {/* Portrait media box: every clip this app makes is 9:16, so a landscape
          thumbnail was cropping ~60% of the frame away (faces, product, the
          whole point of the shot). 3:4 keeps the card scannable in a grid while
          showing most of the frame. */}
      {/* relative + an absolutely-placed video: a 9:16 video laid out in normal
          flow reports its own intrinsic height and pushes the box past its
          aspect-ratio (the card ran 751px tall, three per screen). Taking the
          video out of flow lets the 3:4 ratio actually hold. */}
      <div className="relative aspect-[3/4] w-full shrink-0 overflow-hidden bg-media">
        {previewFile && broken ? (
          // Distinct from "not rendered yet": that one is an empty icon because
          // nothing was made; this says the file that WAS made is gone.
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center">
            <Film size={28} className="text-[rgb(243_242_242_/_0.25)]" />
            <p className="text-[13px] text-muted">ไม่พบไฟล์คลิป</p>
            {canOpenFolder ? (
              <button
                type="button"
                onClick={() => void window.noey.projects.openFolder(job.project.uid)}
                className="text-[13px] text-accent hover:text-accent-hover-text"
              >
                เปิดโฟลเดอร์โปรเจกต์
              </button>
            ) : null}
          </div>
        ) : previewFile ? (
          // The picture is a button: clicking it plays the clip big, which is
          // the thing you actually want from a grid of look-alike thumbnails
          // (live report 2026-08-13). The card's own "เปิดโปรเจกต์" still owns
          // navigation — this only opens the player.
          <button
            type="button"
            title="ดูคลิปจอใหญ่"
            aria-label={`ดูคลิป ${job.project.name} จอใหญ่`}
            onClick={() => {
              setPlayerIndex(0)
              setPlayerOpen(true)
            }}
            className="group absolute inset-0 block cursor-pointer"
          >
            <video
              key={previewKey}
              src={window.noey.media.urlFor(job.project.uid, previewFile)}
              className="absolute inset-0 h-full w-full object-cover"
              muted
              playsInline
              preload="metadata"
              onLoadedMetadata={(e) => seekToPosterFrame(e.currentTarget)}
              // A <video> whose source 404s stays a solid box on bg-media, so a
              // missing file looked exactly like a black clip and nothing said
              // otherwise (live report 2026-08-21).
              onError={() => {
                window.dispatchEvent(new Event('noey:media-auth-stale'))
                // Marker excludes the nonce, or every retry would arm another.
                const base = `${job.project.uid}-${previewFile}-${job.mediaKey}`
                if (retriedRef.current !== base) {
                  retriedRef.current = base
                  window.setTimeout(() => setPreviewNonce((n) => n + 1), 600)
                  return
                }
                setBrokenKey(previewKey)
              }}
            />
            <span className="absolute inset-0 flex items-center justify-center bg-[rgb(23_22_20_/_0.35)] opacity-0 transition-opacity duration-state ease-out group-hover:opacity-100">
              <Play size={26} className="text-ink" fill="currentColor" />
            </span>
            {/* One still cannot speak for six clips. R12.5 keeps the card to a
                single status line (which already says how many), so the count
                goes ON the picture instead of becoming a second badge. */}
            {job.mode === 'speech_highlights' && (highlightCount ?? 0) > 1 ? (
              <span className="absolute bottom-3 left-3 flex h-6 items-center gap-1.5 rounded-[4px] bg-[rgb(23_22_20_/_0.72)] px-2">
                <Layers size={13} className="text-accent" strokeWidth={1.8} />
                <span className="text-[12px] font-semibold tabular-nums text-ink">
                  1/{highlightCount}
                </span>
              </span>
            ) : null}
          </button>
        ) : busy ? (
          <Skeleton variant="media" className="h-full w-full rounded-none" />
        ) : (
          // Nothing rendered yet is a STATE, not a load — a permanent shimmer
          // reads as "still loading" forever (R1 screen 2, second card).
          <div className="flex h-full w-full items-center justify-center">
            <Film size={28} className="text-[rgb(243_242_242_/_0.25)]" />
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col p-4">
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 truncate text-[17px] font-semibold text-ink">{job.project.name}</p>
          <div ref={menuRef} className="relative -mr-1.5 -mt-1.5 shrink-0">
            <button
              ref={triggerRef}
              type="button"
              aria-label="ตัวเลือกเพิ่มเติม"
              onClick={() => (menuOpen ? setMenuOpen(false) : openMenu())}
              className="flex h-8 w-8 items-center justify-center rounded-md text-muted transition-colors duration-state ease-out hover:bg-[rgb(243_242_242_/_0.06)]"
            >
              <MoreVertical size={17} />
            </button>
            {/* Portalled to the body: the card clips its children
                (`overflow-hidden`, for the media corners), so an absolutely
                placed panel is cut off at the card edge — which is exactly
                what swallowed "ลบโปรเจกต์นี้" once the menu grew to five rows
                (live report 2026-08-17). */}
            {menuOpen && menuPos
              ? createPortal(
                  <div
                    ref={panelRef}
                    style={{
                      position: 'fixed',
                      top: menuPos.top,
                      bottom: menuPos.bottom,
                      left: menuPos.left
                    }}
                  >
                    <Menu
                      items={[
                        // Top two are commands, bottom two are file management —
                        // that is what the divider separates.
                        {
                          key: 'recut',
                          label: 'ให้ AI ตัดใหม่',
                          icon: <Sparkles size={15} className="text-accent" />,
                          // Recut re-runs the VIDEO analyze chain — every
                          // speech mode (R17) cuts from the transcript, so a
                          // recut there ran the wrong pipeline (hit live
                          // 2026-09-07 on a speech_scenes project). Guard
                          // matches recut() in useProjectPipeline.
                          disabled:
                            busy ||
                            !ready ||
                            job.mode === 'talking_head' ||
                            job.mode === 'speech_scenes' ||
                            job.mode === 'speech_highlights'
                        },
                        {
                          key: 'revert',
                          label: 'ย้อนกลับคลิปก่อนหน้า',
                          // Kept visible-but-disabled: hiding it would give the two
                          // menus different row counts, moving "ลบโปรเจกต์นี้" under
                          // a cursor that expected the safe row.
                          sublabel: kept ? `รอบที่ ${kept.round} · ${fmtWhen(kept.at)}` : undefined,
                          icon: <RotateCcw size={15} />,
                          disabled: busy || !kept
                        },
                        ...(canOpenFolder
                          ? [
                              { divider: true } as const,
                              { key: 'folder', label: 'เปิดโฟลเดอร์โปรเจกต์' } as const
                            ]
                          : []),
                        { divider: true },
                        { key: 'delete', label: 'ลบโปรเจกต์นี้', destructive: true, disabled: busy }
                      ]}
                      onSelect={(key) => {
                        setMenuOpen(false)
                        if (key === 'recut') setRecutOpen(true)
                        if (key === 'revert') void onRevert()
                        if (key === 'folder') void window.noey.projects.openFolder(job.project.uid)
                        if (key === 'delete') onDelete()
                      }}
                    />
                  </div>,
                  document.body
                )
              : null}
          </div>
        </div>

        <p className="mt-1 text-sm tabular-nums text-muted">{formatMeta(job.project)}</p>

        <div className="my-3.5">
          <StatusLine status={status} label={label} />
        </div>

        <div className="mt-auto">
          {busy ? (
            <Button
              variant="secondary"
              className="w-full"
              onClick={() => navigate({ name: 'progress', uid: job.project.uid })}
            >
              ดูรายละเอียด
            </Button>
          ) : step === 'error' && job.project.billingStop?.walletCanCover ? (
            // The plan's limit refused this run but the top-up balance can pay
            // for it — the way out is one press, with the amount on it.
            <Button
              variant="primary"
              className="w-full"
              onClick={() => void job.continueOnWallet()}
            >
              ใช้ยอดเงินคงเหลือทำต่อ
            </Button>
          ) : step === 'error' ? (
            <Button variant="secondary" className="w-full" onClick={() => void job.retry()}>
              ลองใหม่
            </Button>
          ) : step === 'imported' || step === 'importing' ? (
            // Nothing has been rendered yet: this is a run that never started
            // or was stopped. Start it — opening the manual editor here landed
            // the user on an empty timeline with no way forward (live report
            // 2026-08-13).
            <Button variant="secondary" className="w-full" onClick={() => void job.retry()}>
              เริ่มตัดต่อ
            </Button>
          ) : (
            <Button variant="primary" className="w-full" onClick={onOpen}>
              เปิดโปรเจกต์
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
