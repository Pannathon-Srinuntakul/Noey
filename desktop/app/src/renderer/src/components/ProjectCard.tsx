import { useEffect, useRef, useState } from 'react'
import { Folder, Loader2, Mic, Pencil, Square, Trash2, XCircle } from 'lucide-react'
import type { LocalProject } from '../../../preload'
import { deleteRemote, type ApiSession } from '../lib/videosLocalApi'
import { useProjectPipeline } from '../lib/useProjectPipeline'
import { isBusy, STEP_LABELS, type ProjectStep } from '../lib/projectFlow'
import { VideoTimelineEditor } from './TimelineEditor'
import DubVideoPlayer from './DubVideoPlayer'
import { EffectsPanel } from './EffectsPanel'

// Same status vocabulary/colors as web's ProjectCard (VideoPage.tsx statusLabel/statusColor),
// mapped onto desktop's finer-grained `step` via the existing isBusy() helper.
function statusLabel(step: ProjectStep): string {
  if (step === 'error') return 'ผิดพลาด'
  if (step === 'done') return 'เสร็จแล้ว'
  if (step === 'waiting_vo') return 'รอ Voiceover'
  if (isBusy(step)) return 'กำลังทำ'
  return 'รอเริ่ม'
}

function statusColor(step: ProjectStep): string {
  if (step === 'error') return 'text-red-600'
  if (step === 'done') return 'text-green-700'
  if (step === 'waiting_vo') return 'text-purple-600'
  if (isBusy(step)) return 'text-blue-600'
  return 'text-amber-600'
}

interface Props {
  project: LocalProject
  session: ApiSession
  onDeleted: (uid: string) => void
}

export default function ProjectCard({
  project: initial,
  session,
  onDeleted
}: Props): React.JSX.Element {
  const {
    project,
    step,
    mode,
    progressMsg,
    thinking,
    editScript,
    error,
    mediaKey,
    showEditor,
    setShowEditor,
    runFinal,
    retry,
    stop,
    stopping,
    openEditor
  } = useProjectPipeline(initial, session)

  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const thinkingScrollRef = useRef<HTMLDivElement>(null)
  const stickThinkingBottomRef = useRef(true)

  const THINKING_NEAR_BOTTOM_PX = 48

  const isThinkingNearBottom = (el: HTMLDivElement): boolean =>
    el.scrollHeight - el.scrollTop - el.clientHeight <= THINKING_NEAR_BOTTOM_PX

  const handleThinkingScroll = (): void => {
    const el = thinkingScrollRef.current
    if (!el) return
    stickThinkingBottomRef.current = isThinkingNearBottom(el)
  }

  useEffect(() => {
    if (!thinking) {
      stickThinkingBottomRef.current = true
      return
    }
    if (!stickThinkingBottomRef.current) return
    const el = thinkingScrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [thinking])

  const date = new Date(project.createdAt).toLocaleString('th-TH', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  })

  const doDelete = async (): Promise<void> => {
    setDeleting(true)
    try {
      await window.noey.projects.delete(project.uid)
      if (project.remote?.uid) {
        deleteRemote(session, project.remote.uid).catch(() => undefined)
      }
      onDeleted(project.uid)
    } finally {
      setDeleting(false)
    }
  }

  if (showEditor) {
    return (
      <VideoTimelineEditor
        uid={project.uid}
        mode={mode}
        onClose={() => setShowEditor(false)}
        onSaved={() => setShowEditor(false)}
      />
    )
  }

  return (
    <div className="rounded-xl border border-[#5b3a1a]/20 bg-[#fffdf7] p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-[#5b3a1a]/50">{date}</p>
          <p className="mt-0.5 truncate font-medium text-[#5b3a1a]">{project.name}</p>
          <p className="mt-0.5 text-[10px] whitespace-nowrap text-[#5b3a1a]/45">
            {mode === 'talking_head' ? 'Talking Head Edit' : 'Dub First Edit'}
            {project.targetDurationSec ? ` · ~${project.targetDurationSec} วิ` : ''}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          <span
            className={`whitespace-nowrap rounded-full bg-current/10 px-2.5 py-0.5 text-xs font-semibold ${statusColor(step)}`}
          >
            {statusLabel(step)}
          </span>
          {confirmDelete ? (
            <>
              <button
                onClick={doDelete}
                disabled={deleting}
                className="whitespace-nowrap rounded-lg px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-40"
              >
                ยืนยัน
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="whitespace-nowrap rounded-lg px-2 py-1 text-xs text-[#5b3a1a]/50 hover:bg-black/5"
              >
                ยกเลิก
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              disabled={deleting}
              title="ลบโปรเจกต์"
              className="rounded-lg p-1.5 text-[#5b3a1a]/40 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
            >
              {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            </button>
          )}
        </div>
      </div>

      {project.clips.length > 0 && (
        <button
          type="button"
          onClick={() => window.noey.projects.openFolder(project.uid)}
          className="mt-2 flex items-center gap-1.5 text-[10px] text-[#5b3a1a]/50 underline hover:text-[#5b3a1a]"
        >
          <Folder size={11} /> เปิดโฟลเดอร์โปรเจกต์
        </button>
      )}

      {isBusy(step) && (
        <>
          <div className="mt-3 flex items-center justify-between gap-2">
            <p className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-[#5b3a1a]/80">
              <Loader2 size={12} className="animate-spin shrink-0 text-amber-600" />
              <span className="truncate">{progressMsg || STEP_LABELS[step]}</span>
            </p>
            <button
              type="button"
              onClick={() => void stop()}
              disabled={stopping}
              className="flex shrink-0 items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-2 py-1 text-[10px] font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50"
            >
              <Square size={10} fill="currentColor" />
              {stopping ? 'กำลังหยุด…' : 'หยุด'}
            </button>
          </div>
          {thinking && (
            <div className="mt-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2">
              <p className="mb-1 text-[10px] font-medium text-zinc-400">AI กำลังคิด…</p>
              <div
                ref={thinkingScrollRef}
                onScroll={handleThinkingScroll}
                className="scroll-light max-h-32 overflow-y-auto font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-zinc-500"
              >
                {thinking}
              </div>
            </div>
          )}
        </>
      )}

      {step === 'waiting_vo' && (
        <div className="mt-3 space-y-3">
          <DubVideoPlayer
            key={mediaKey}
            mediaKey={mediaKey}
            src={window.noey.media.urlFor(project.uid, 'final_silent.mp4')}
            editScript={editScript}
          />
          <button
            type="button"
            onClick={() => void runFinal()}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-purple-600 px-3 py-2.5 text-xs font-semibold text-white shadow hover:bg-purple-700"
          >
            <Mic size={13} /> เลือกไฟล์เสียงพากย์
          </button>
          <button
            type="button"
            onClick={openEditor}
            disabled={!editScript}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-[#5b3a1a]/30 px-3 py-2 text-xs font-medium text-[#5b3a1a] hover:bg-amber-50 disabled:opacity-40"
          >
            <Pencil size={12} /> แก้ไขวิดีโอ (timeline editor)
          </button>
        </div>
      )}

      {step === 'error' && (
        <div className="mt-2 space-y-1.5">
          <p className="flex items-start gap-1.5 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
            <XCircle size={13} className="mt-0.5 shrink-0" />
            {error ?? project.error}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => void retry()}
              className="rounded-lg border border-red-300/60 px-2.5 py-1 text-xs text-red-700 hover:bg-red-50"
            >
              ลองใหม่
            </button>
            <button
              onClick={() => window.noey.log.openFolder()}
              className="text-xs text-red-700/50 underline hover:text-red-700"
            >
              เปิดโฟลเดอร์ log
            </button>
          </div>
        </div>
      )}

      {step === 'done' && (
        <div className="mt-3 space-y-2">
          <DubVideoPlayer
            key={mediaKey}
            mediaKey={mediaKey}
            src={window.noey.media.urlFor(project.uid, 'final.mp4')}
            editScript={editScript}
          />
          <button
            onClick={openEditor}
            disabled={mode === 'talking_head' && !project.timeline}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-[#5b3a1a]/30 px-3 py-2 text-xs font-medium text-[#5b3a1a] hover:bg-amber-50 disabled:opacity-40"
          >
            <Pencil size={12} /> แก้ไขวิดีโอ
          </button>
          <EffectsPanel project={project} session={session} baseFile="final.mp4" />
        </div>
      )}
    </div>
  )
}
