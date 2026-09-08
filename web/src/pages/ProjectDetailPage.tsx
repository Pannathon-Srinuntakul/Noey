import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeftRight,
  Check,
  Copy,
  Download,
  Film,
  Mic,
  Pencil,
  Sparkles,
  ZoomIn
} from 'lucide-react'
import { cn } from '../lib/cn'
import {
  dubScenesFor,
  lineIdAt,
  linesFromScenes,
  timelineScenesFor,
  type DubScene
} from '../lib/dubScenes'
import { useFxJobs } from '../lib/fxJobs'
import { useJobs } from '../lib/jobs'
import { useRouter } from '../lib/router'
import { useDeleteProject } from '../lib/useDeleteProject'
import { STEP_LABELS, isBusy, stepOrderFor, type ProjectStep } from '../lib/projectFlow'
import { fmtClock } from '../lib/wizardState'
import { MODE_LABEL } from '../lib/modeLabel'
import { usePreviewFile } from '../lib/usePreviewFile'
import { countShotsWithAlternates } from '../lib/shotSwap'
import { canOpenFolder, canUseZoomEffects } from '../lib/platformFeatures'
import { Button } from '../components/ui/Button'
import { StatusLine } from '../components/ui/StatusLine'
import { VideoPlayer } from '../components/ui/VideoPlayer'
import { PageHeader } from '../components/shell/PageHeader'
import ExportVideoModal from '../components/ExportVideoModal'
import { ShotSwapReview } from '../components/projects/ShotSwapReview'

/** Vertical action row that may be disabled with a reason. Branching on the
 * whole element (rather than spreading props) is required by Button's
 * disabled/reason union — see the note in ui/Button.tsx. */
function ActionButton({
  reason,
  icon,
  onClick,
  children
}: {
  /** Non-null disables the button and shows this beside it. */
  reason: string | null
  icon: React.ReactNode
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const shared = 'h-12 w-full justify-start'
  if (reason) {
    return (
      <Button variant="secondary" className={shared} icon={icon} disabled disabledReason={reason}>
        {children}
      </Button>
    )
  }
  return (
    <Button variant="secondary" className={shared} icon={icon} onClick={onClick}>
      {children}
    </Button>
  )
}

/** One line of the script panel. `start` is where clicking it jumps to; which
 * line is CURRENT is decided from the scenes, not from a line span — a line's
 * scenes are interleaved with other lines' (see lib/dubScenes). */
interface TimedLine {
  id: string
  text: string
  start: number
}

/** talking_head's equivalent of the script: the burned-in caption text, read
 * off the saved timeline. The panel used to show a "there is no script" note
 * under a heading that promised the transcript — a whole panel of nothing on a
 * project that HAS the text. */
function captionScenesFor(timeline: Record<string, unknown> | undefined): DubScene[] {
  const captions = timeline?.captions
  if (!Array.isArray(captions)) return []
  return captions
    .map((c, i) => {
      const cap = (c ?? {}) as { text?: unknown; start?: unknown; end?: unknown }
      return {
        lineId: i,
        script: String(cap.text ?? '').trim(),
        start: Number(cap.start ?? 0),
        end: Number(cap.end ?? 0)
      }
    })
    .filter((s) => s.script && s.end > s.start)
}

/** Total source length as MM:SS — the footer's "ต้นฉบับ N ไฟล์ · MM:SS นาที". */
function fmtClipTotal(totalSec: number): string {
  return `${fmtClipClock(totalSec)} นาที`
}

/** "6 นาที 20 วินาที" — how long the last run took (R1 status card). */
function fmtRunTime(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const m = Math.floor(s / 60)
  const r = s % 60
  if (m === 0) return `${r} วินาที`
  return r === 0 ? `${m} นาที` : `${m} นาที ${r} วินาที`
}

/** Bare MM:SS, for the header's meta line. */
/** One row of the speech_highlights index kept on the project (timelines
 * stripped — display metadata only, see stripIndexTimelines). */
interface HighlightItemMeta {
  id: string
  title: string
  why: string
  score: number
  srcIn: number
  srcOut: number
  durationSec: number
  speakers: string[]
}

function fmtClipClock(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export default function ProjectDetailPage({ uid }: { uid: string }): React.JSX.Element {
  const { jobFor } = useJobs()
  const fxJob = useFxJobs().jobFor(uid)
  const { navigate } = useRouter()
  const requestDelete = useDeleteProject()
  const job = jobFor(uid)
  const [exportOpen, setExportOpen] = useState(false)
  const [swapOpen, setSwapOpen] = useState(false)
  const [scriptCopied, setScriptCopied] = useState(false)
  // Playback chrome lives in VideoPlayer (shared overlay transport); this ref
  // is what lets the script panel follow (and drive) the playhead.
  const videoRef = useRef<HTMLVideoElement | null>(null)
  // Polled rather than driven by `timeupdate`: that event fires ~4×/s, which
  // is visibly late for "which line is being said right now".
  const [playheadSec, setPlayheadSec] = useState(0)
  useEffect(() => {
    let raf = 0
    const tick = (): void => {
      const v = videoRef.current
      if (v) {
        const at = v.currentTime
        setPlayheadSec((prev) => (Math.abs(prev - at) < 0.03 ? prev : at))
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const step = job?.step as ProjectStep | undefined
  // speech_highlights (R17.10): which of the N clips the page is showing.
  const highlightIndex = job?.project.highlightIndex as
    { count?: number; items?: HighlightItemMeta[] } | undefined
  const highlightItems: HighlightItemMeta[] = Array.isArray(highlightIndex?.items)
    ? highlightIndex.items
    : []
  const [selectedHighlight, setSelectedHighlight] = useState('h01')
  // Keyed like the player's own remount key, so picking another highlight or
  // re-rendering clears the error without a setState in an effect.
  const [previewBrokenKey, setPreviewBrokenKey] = useState<string | null>(null)
  const previewFile = usePreviewFile(
    uid,
    step ?? 'imported',
    job?.mode ?? 'dub_first',
    job?.mediaKey ?? 0,
    {
      highlightId: selectedHighlight,
      fallbackClipFile: job?.project.clips?.[0]?.file,
      hasHighlights: highlightItems.length > 0
    }
  )

  if (!job || !step) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted">ไม่พบโปรเจกต์นี้</p>
      </div>
    )
  }

  const swapQuestions = countShotsWithAlternates(job.editScript)
  const running = isBusy(step)
  const ready = step === 'done' || step === 'waiting_vo'
  // The voiceover is optional, so `waiting_vo` is a finished clip — but it is
  // NOT the same as `done`, and the card used to tick every remaining stage
  // (planning, final render) as if it were (live report 2026-08-13).
  const awaitingVoiceover = step === 'waiting_vo'
  // How much of the source the AI kept. The AI decides the length from the
  // footage now (no duration quota), so this line is what tells the user a
  // short result was a judgment about their material, not a malfunction.
  const keptSec = job.editScript?.totalEstimatedSec ?? 0
  const sourceSec = (job.project.clips ?? []).reduce((sum, c) => sum + (c.durationSec || 0), 0)
  const showKept = ready && job.mode !== 'talking_head' && keptSec > 0 && sourceSec > 0
  // Scenes first, lines from them: a line's scenes are interleaved with other
  // lines', so only a scene can say which line is on screen right now.
  const scenes =
    job.mode === 'talking_head' || job.mode === 'speech_scenes'
      ? captionScenesFor(job.project.timeline)
      : ready && job.project.voiceoverPath && job.project.timeline
        ? timelineScenesFor(job.project.timeline, job.editScript)
        : dubScenesFor(job.editScript)
  const lines: TimedLine[] = linesFromScenes(scenes)
    .filter((l) => l.script)
    .map((l) => ({ id: `line${l.lineId}`, text: l.script, start: l.start }))
  const script = lines.map((l) => l.text).join('\n')
  const previewBroken = previewBrokenKey === `${uid}-${previewFile}-${job?.mediaKey}`
  const currentLineId = lineIdAt(scenes, playheadSec)
  const activeLineId = currentLineId === null ? null : `line${currentLineId}`
  // R1 screen 3 / the prototype's own state map: mode · where the audio comes
  // from · length · frame size · when. Every part is measured locally (ffprobe
  // wrote the clip metadata at import), so nothing here is invented.
  const firstClip = job.project.clips?.[0]
  const totalClipSec = (job.project.clips ?? []).reduce((s, c) => s + (c.durationSec ?? 0), 0)
  const audioLabel =
    job.mode === 'talking_head' || job.mode === 'speech_scenes' || job.mode === 'speech_highlights'
      ? 'เสียงต้นฉบับ'
      : job.mode === 'highlight'
        ? 'ไม่พากย์'
        : job.project.voiceoverPath
          ? 'พากย์แล้ว'
          : 'ยังไม่ได้พากย์'
  const detailSubtitle = [
    `${MODE_LABEL[job.mode]} · ${audioLabel}`,
    totalClipSec > 0 ? fmtClipClock(totalClipSec) : null,
    firstClip?.width && firstClip?.height ? `${firstClip.width}×${firstClip.height}` : null,
    job.project.updatedAt
      ? new Date(job.project.updatedAt).toLocaleString('th-TH', {
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit'
        })
      : null
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <>
      <PageHeader
        title={job.project.name}
        backLabel="โปรเจกต์ทั้งหมด"
        onBack={() => navigate({ name: 'projects' })}
        subtitle={detailSubtitle}
        actions={
          <>
            {previewFile ? (
              <Button
                variant="primary"
                icon={<Download size={16} />}
                onClick={() => setExportOpen(true)}
              >
                ส่งออกวิดีโอ
              </Button>
            ) : (
              <Button
                variant="primary"
                icon={<Download size={16} />}
                disabled
                disabledReason={running ? 'รอจนกว่างานจะเสร็จ' : 'ยังไม่มีคลิปให้ส่งออก'}
              >
                ส่งออกวิดีโอ
              </Button>
            )}
          </>
        }
      />

      {/* Below `lg` the preview stops sitting beside the actions and goes above
          them, and the pane scrolls as one column instead of two — 270px of
          video plus a column of buttons does not fit a phone side by side. */}
      <div className="scroll-ghost flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 pb-8 pt-5 lg:flex-row lg:overflow-hidden lg:px-8">
        <div className="flex shrink-0 flex-col gap-3 lg:sticky lg:top-0">
          {previewFile && previewBroken ? (
            // A <video> pointed at a missing file is still a solid box, which
            // read as "the clip is black" instead of "the clip is gone".
            <div className="flex aspect-[9/16] w-full max-w-[270px] flex-col items-center justify-center gap-2 rounded-md bg-media px-6 text-center lg:h-[480px]">
              <Film size={30} className="text-[rgb(243_242_242_/_0.25)]" />
              <p className="text-[13px] text-muted">ไม่พบไฟล์คลิป</p>
              {canOpenFolder ? (
                <button
                  type="button"
                  onClick={() => void window.noey.projects.openFolder(uid)}
                  className="text-[13px] text-accent hover:text-accent-hover-text"
                >
                  เปิดโฟลเดอร์โปรเจกต์
                </button>
              ) : null}
            </div>
          ) : previewFile ? (
            <VideoPlayer
              mediaKey={`${uid}-${previewFile}-${job.mediaKey}`}
              videoRef={videoRef}
              src={window.noey.media.urlFor(uid, previewFile)}
              expandTitle={job.project.name}
              className="aspect-[9/16] w-full max-w-[270px] rounded-md lg:h-[480px] lg:w-[270px]"
              onError={() => setPreviewBrokenKey(`${uid}-${previewFile}-${job.mediaKey}`)}
            />
          ) : (
            <div className="aspect-[9/16] w-full max-w-[270px] overflow-hidden rounded-md bg-media lg:h-[480px] lg:w-[270px]" />
          )}
        </div>

        {/* Scrolls: the column was built to fit one screen, but a
            speech_highlights project adds a whole highlights list on top of the
            usual cards and the bottom panels fell off the fold with no way to
            reach them (body itself is overflow:hidden). */}
        <div className="scroll-ghost flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto">
          {/* An editor's AI job keeps running after you leave it (lib/fxJobs).
              Without this row the app looked idle while it worked, so the only
              way to know was to walk back into the editor. */}
          {fxJob ? (
            <button
              type="button"
              onClick={() =>
                navigate({ name: fxJob.kind === 'reedit' ? 'timeline' : 'effectsClip', uid })
              }
              className="flex items-center gap-3 rounded-md border border-accent bg-accent-tint px-5 py-3 text-left"
            >
              <StatusLine status="working" label={`${fxJob.label}…`} />
              <span className="min-w-0 flex-1 truncate text-sm text-muted">{fxJob.progress}</span>
              <span className="shrink-0 text-sm text-accent">เปิดดู</span>
            </button>
          ) : null}

          <div className="rounded-md border border-divider px-5 py-4">
            {/* Status on the left, how long it took on the right (R1 / the
                prototype's detail state) — one row, not two stacked lines. */}
            <div className="flex items-center gap-3">
              <StatusLine
                status={running ? 'working' : step === 'error' ? 'error' : ready ? 'ok' : 'idle'}
                label={
                  running
                    ? 'กำลังทำงาน'
                    : step === 'error'
                      ? (job.error ?? 'ทำงานไม่สำเร็จ')
                      : awaitingVoiceover
                        ? 'คลิปพร้อมใช้ — ยังไม่ได้ใส่เสียงพากย์ (ไม่บังคับ)'
                        : ready && job.mode === 'speech_highlights' && highlightItems.length > 0
                          ? `ไฮไลต์พร้อมใช้ ${highlightItems.length} คลิป`
                          : ready
                            ? 'คลิปพร้อมใช้'
                            : 'ยังไม่เริ่ม'
                }
              />
              {job.project.lastRunSeconds ? (
                <span className="ml-auto shrink-0 text-sm tabular-nums text-muted">
                  ใช้เวลาทำ {fmtRunTime(job.project.lastRunSeconds)}
                </span>
              ) : null}
            </div>
            {ready && job.mode === 'speech_highlights' && highlightItems.length > 0 ? (
              <p className="mt-1.5 text-[13px] tabular-nums text-muted">
                รวม {fmtClock(highlightItems.reduce((a, h) => a + (h.durationSec || 0), 0))}{' '}
                จากต้นฉบับ {fmtClock(sourceSec)}
              </p>
            ) : showKept ? (
              <p className="mt-1.5 text-[13px] tabular-nums text-muted">
                AI คัดไว้ {fmtClock(keptSec)} จากต้นฉบับ {fmtClock(sourceSec)}
              </p>
            ) : null}
            {/* What the run actually did, and the way into its reasoning —
                R1 screen 3 puts both on this card, not only on the progress
                screen the user has already left by the time it is done. */}
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
              {stepOrderFor(job.mode)
                .filter((s) => s !== 'done')
                .map((s, i, all) => {
                  // `done` is filtered out of `all`, so a finished project has
                  // no index in it. At `waiting_vo` only the stages up to the
                  // cut are real — ticking the voiceover-and-after stages there
                  // claimed work that never ran.
                  const currentIdx = all.findIndex((x) => x === step)
                  const reached = step === 'done' || (currentIdx >= 0 && currentIdx >= i)
                  const optional = awaitingVoiceover && currentIdx >= 0 && i >= currentIdx
                  return (
                    <span key={s} className="inline-flex items-center gap-1">
                      {reached ? <Check size={12} className="text-ok" /> : null}
                      <span className={reached ? 'text-ink-3' : undefined}>{STEP_LABELS[s]}</span>
                      {optional && s !== step ? <span>(ถ้าต้องการ)</span> : null}
                    </span>
                  )
                })}
            </div>
            {job.thinking ? (
              <button
                type="button"
                onClick={() => navigate({ name: 'progress', uid })}
                className="mt-2 text-[13px] text-accent underline hover:text-accent-hover-text"
              >
                ดูขั้นตอนที่ AI ตัดสินใจและเหตุผล — เปิดรายละเอียด
              </button>
            ) : null}
          </div>

          {/* speech_highlights (R17.10): the N clips, under the status card and
              above the actions. Row selection drives the preview player; the
              selected row uses the R16 device-list treatment (tint + left
              accent bar), not a new pattern. */}
          {job.mode === 'speech_highlights' && ready && highlightItems.length > 0 ? (
            <div className="rounded-md border border-divider">
              <p className="border-b border-divider px-5 py-3 text-[15px] font-semibold text-ink">
                ไฮไลต์ที่ AI ตัดมา
              </p>
              <div className="flex max-h-[260px] flex-col overflow-y-auto">
                {highlightItems.map((h, i) => {
                  const selected = h.id === selectedHighlight
                  return (
                    <button
                      key={h.id}
                      type="button"
                      onClick={() => setSelectedHighlight(h.id)}
                      className={cn(
                        'flex flex-col items-start gap-1 px-5 py-2.5 text-left sm:flex-row sm:items-center sm:gap-3 transition-colors duration-state ease-out',
                        i > 0 && 'border-t border-divider',
                        selected
                          ? 'border-l-2 border-l-accent bg-accent-tint'
                          : 'border-l-2 border-l-transparent hover:bg-[rgb(243_242_242_/_0.04)]'
                      )}
                    >
                      <span className="w-8 shrink-0 text-[13px] tabular-nums text-muted">
                        {i + 1}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14.5px] text-ink">
                          {h.title || h.id}
                        </span>
                        <span className="block truncate text-[13px] text-muted">{h.why}</span>
                      </span>
                      <span className="shrink-0 text-[13px] tabular-nums text-muted">
                        {fmtClipClock(h.durationSec)}
                        {h.speakers?.length > 1 ? ` · ${h.speakers.length} คนพูด` : ''}
                        {` · เริ่มที่ ${fmtClipClock(h.srcIn)}`}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          ) : null}

          <div className="flex flex-col gap-2.5">
            {/* A project that never rendered has nothing to edit — offer the
                run instead of an empty timeline (live report 2026-08-13). */}
            {step === 'imported' ? (
              <ActionButton
                reason={null}
                icon={<Sparkles size={17} className="text-accent" />}
                onClick={() => void job.retry()}
              >
                เริ่มตัดต่อ
              </ActionButton>
            ) : (
              <ActionButton
                reason={
                  job.mode === 'speech_highlights'
                    ? 'โหมดนี้ยังแก้ไทม์ไลน์ทีละไฮไลต์ไม่ได้'
                    : running
                      ? 'รอจนกว่างานจะเสร็จ'
                      : !ready
                        ? 'ต้องเรนเดอร์คลิปก่อน'
                        : job.editScript ||
                            job.mode === 'talking_head' ||
                            job.mode === 'speech_scenes'
                          ? null
                          : 'ยังไม่มีสคริปต์ให้แก้ไข'
                }
                icon={<Pencil size={17} className="text-accent" />}
                onClick={() => navigate({ name: 'timeline', uid })}
              >
                แก้ไขวิดีโอ
              </ActionButton>
            )}

            {/* R18b ปรับช็อต — pick between frames the AI already compared
                (edit-script modes only; zero AI calls per round). Absent
                entirely once the cut is ready and no shot has an alternative:
                an offer with nothing behind it wastes the press. */}
            {(job.mode === 'dub_first' || job.mode === 'highlight') &&
            (running || !ready || swapQuestions > 0) ? (
              <ActionButton
                reason={running ? 'รอรอบปัจจุบันเสร็จก่อน' : !ready ? 'ต้องเรนเดอร์คลิปก่อน' : null}
                icon={<ArrowLeftRight size={17} className="text-accent" />}
                onClick={() => setSwapOpen(true)}
              >
                {/* The count is on the button so the user knows it is three
                    questions, not nine, before pressing anything. */}
                <span>
                  ปรับช็อต
                  {swapQuestions > 0 ? (
                    <span className="font-normal text-muted">
                      {' '}
                      · {swapQuestions} ช็อตมีตัวเลือกอื่น
                    </span>
                  ) : null}
                </span>
              </ActionButton>
            ) : null}

            {canUseZoomEffects ? (
              <ActionButton
                reason={
                  job.mode === 'speech_highlights'
                    ? 'โหมดนี้ยังแก้ไทม์ไลน์ทีละไฮไลต์ไม่ได้'
                    : running
                      ? 'รอจนกว่างานจะเสร็จ'
                      : ready
                        ? null
                        : 'ต้องเรนเดอร์คลิปก่อน'
                }
                icon={<ZoomIn size={17} className="text-accent" />}
                onClick={() => navigate({ name: 'effectsClip', uid })}
              >
                เอฟเฟกต์การซูม
              </ActionButton>
            ) : null}

            {/* Re-recording stays available after the render (R1 screen 3):
                a finished dub is exactly when you hear a line you want again. */}
            {(job.mode === 'dub_first' || job.mode === 'highlight') &&
            (step === 'waiting_vo' || ready) ? (
              <ActionButton
                reason={null}
                icon={<Mic size={17} className="text-accent" />}
                onClick={() => navigate({ name: 'voiceover', uid })}
              >
                {ready
                  ? 'อัดเสียงพากย์ใหม่'
                  : job.project.voiceoverTakes && Object.keys(job.project.voiceoverTakes).length > 0
                    ? 'พากย์ต่อ'
                    : 'อัดเสียงพากย์'}
              </ActionButton>
            ) : null}
          </div>

          {/* min-h, not just flex-1: once the column scrolls, flex-1 has no
              leftover height to claim and the panel collapsed to 0 px. */}
          <div className="flex min-h-[280px] flex-1 flex-col overflow-hidden rounded-md border border-divider px-5 py-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[15px] font-semibold text-ink">
                {/* The speech modes have no voiceover at all — calling their
                    panel "สคริปต์ที่ใช้พากย์" described a thing that cannot
                    exist in them. */}
                {job.mode === 'dub_first' || job.mode === 'highlight'
                  ? 'สคริปต์ที่ใช้พากย์'
                  : 'คำบรรยายจากการถอดเสียง'}
              </p>
              {script ? (
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(script).catch(() => undefined)
                    setScriptCopied(true)
                    window.setTimeout(() => setScriptCopied(false), 2000)
                  }}
                  className="flex shrink-0 items-center gap-1.5 text-[13px] text-accent hover:text-accent-hover-text"
                >
                  <Copy size={14} />
                  {scriptCopied ? 'คัดลอกแล้ว' : 'คัดลอก'}
                </button>
              ) : null}
            </div>
            {/* Lines, not one text blob: each carries its own output-time
                range, so the one being spoken can light up while the preview
                plays and clicking a line jumps the video to it. */}
            {lines.length > 0 ? (
              <div className="scroll-ghost mt-2.5 min-h-0 flex-1 overflow-y-auto">
                {lines.map((line) => {
                  const active = line.id === activeLineId
                  return (
                    <button
                      key={line.id}
                      type="button"
                      onClick={() => {
                        const v = videoRef.current
                        if (v) v.currentTime = line.start
                      }}
                      className={cn(
                        'block w-full rounded-sm px-2 py-[3px] text-left text-[15px] leading-[1.75] transition-colors duration-state ease-out',
                        active
                          ? 'bg-accent-tint font-semibold text-accent'
                          : 'text-ink-2 hover:bg-[rgb(243_242_242_/_0.05)]'
                      )}
                    >
                      {line.text}
                    </button>
                  )
                })}
              </div>
            ) : (
              <p className="scroll-ghost mt-2.5 min-h-0 flex-1 overflow-y-auto text-[15px] leading-[1.75] text-muted">
                {job.mode === 'dub_first' || job.mode === 'highlight'
                  ? 'ยังไม่มีสคริปต์'
                  : job.mode === 'speech_highlights'
                    ? 'คำบรรยายของแต่ละไฮไลต์อยู่ในไฟล์ .srt ข้างคลิป'
                    : 'ยังไม่มีคำบรรยาย — ถอดเสียงเสร็จแล้วข้อความจะขึ้นตรงนี้'}
              </p>
            )}
            <div className="mt-auto flex items-center gap-6 border-t border-divider pt-3.5 text-[13px]">
              {job.project.clips?.length ? (
                <span className="tabular-nums text-muted">
                  ต้นฉบับ {job.project.clips.length} ไฟล์ ·{' '}
                  {fmtClipTotal(job.project.clips.reduce((s, c) => s + (c.durationSec ?? 0), 0))}
                </span>
              ) : null}
              {canOpenFolder ? (
                <button
                  type="button"
                  onClick={() => void window.noey.projects.openFolder(uid)}
                  className="text-muted underline hover:text-ink"
                >
                  เปิดโฟลเดอร์โปรเจกต์
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  void requestDelete(uid, job.project.name).then(() =>
                    navigate({ name: 'projects' })
                  )
                }}
                className="ml-auto text-error underline hover:text-[rgb(224_139_132_/_0.75)]"
              >
                ลบโปรเจกต์นี้
              </button>
            </div>
          </div>
        </div>
      </div>

      {swapOpen ? <ShotSwapReview job={job} onClose={() => setSwapOpen(false)} /> : null}
      {exportOpen ? (
        <ExportVideoModal
          projectUid={uid}
          projectName={job.project.name}
          running={running}
          onClose={() => setExportOpen(false)}
        />
      ) : null}
    </>
  )
}
