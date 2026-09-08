import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Mic, Play, Square, Trash2 } from 'lucide-react'
import { cn } from '../lib/cn'
import { useConfirm } from '../lib/confirm'
import { dubScenesFor, lineIdAt } from '../lib/dubScenes'
import { groupScriptLines } from '../lib/dubScript'
import { useJobs } from '../lib/jobs'
import { useRouter } from '../lib/router'
import { useToast } from '../lib/toast'
import { assembleVoiceover, takeFileFor, useVoiceoverRecorder } from '../lib/useVoiceover'
import { usePreviewFile } from '../lib/usePreviewFile'
import type { ProjectStep } from '../lib/projectFlow'
import { Button } from '../components/ui/Button'
import { VideoPlayer } from '../components/ui/VideoPlayer'

/** Stand-in when the project is missing — keeps hook identity stable. */
const NO_PATCH = async (): Promise<void> => undefined

function fmtSec(sec: number): string {
  const s = Math.max(0, sec)
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

function fmtTenths(sec: number): string {
  const s = Math.max(0, sec)
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}.${Math.floor((s % 1) * 10)}`
}

/** Live input meter — 24 bars driven by the analyser's peak. */
function LevelMeter({ level }: { level: number }): React.JSX.Element {
  const bars = 24
  const lit = Math.round(Math.min(1, level * 1.6) * bars)
  return (
    <div className="flex h-8 items-end gap-[3px]" aria-hidden>
      {Array.from({ length: bars }, (_, i) => (
        <span
          key={i}
          className={cn(
            'w-[3px] rounded-[1px] transition-[height,background-color] duration-state ease-out',
            // Red, matching the "กำลังอัด" indicator — the meter only ever
            // shows while a take is running.
            i < lit ? 'bg-error' : 'bg-[rgb(243_242_242_/_0.18)]'
          )}
          style={{ height: `${8 + (i % 5) * 4}px` }}
        />
      ))}
    </div>
  )
}

/**
 * `waiting_vo` as a screen of its own (PLAN.md chunk 7, R5 screen 4).
 *
 * This step is the app waiting on the *user*, not on AI, so it reads as a
 * task list: which lines are recorded, which is next, and what is still
 * blocking the render.
 */
export default function VoiceoverPage({ uid }: { uid: string }): React.JSX.Element {
  const { jobFor } = useJobs()
  const { navigate } = useRouter()
  const { showToast } = useToast()
  const confirm = useConfirm()
  const job = jobFor(uid)
  // Captured before the early return so the hooks below keep a stable
  // identity; a missing job is a no-op write.
  const patch = job?.patch ?? NO_PATCH

  const [selected, setSelected] = useState<number | null>(null)
  const [assembling, setAssembling] = useState(false)
  const [playingLineId, setPlayingLineId] = useState<number | null>(null)

  // Not memoized: the script is a handful of segments, and a manual useMemo
  // here defeats the React compiler's own memoization.
  const lines = job?.editScript ? groupScriptLines(job.editScript).filter((l) => l.script) : []
  const scenes = dubScenesFor(job?.editScript ?? null)
  const takes = job?.project.voiceoverTakes ?? {}

  // Reads the takes back off disk first: the recorder's callback was created
  // when the page mounted, so merging into the `takes` it captured would drop
  // every take recorded since.
  const saveTake = async (lineId: number, file: string, durationSec: number): Promise<void> => {
    const current = (await window.noey.projects.get(uid))?.voiceoverTakes ?? {}
    await patch({ voiceoverTakes: { ...current, [String(lineId)]: { file, durationSec } } })
    // Takes are recorded at waiting_vo -- a resting state where nothing else
    // will ever sync. Without this, an evening of recording existed in exactly
    // one browser: the size-diffed push uploads only the new webm.
    job?.syncFiles('voiceover-take')
  }

  const recorder = useVoiceoverRecorder(uid, saveTake)

  // Selection is derived until the user picks a line: with nothing chosen the
  // screen lands on the first line that still needs a take, and it follows
  // along as takes come in. Storing that in an effect instead would fight the
  // recording it is meant to track.
  const firstUnrecorded = lines.find((l) => !takes[String(l.lineId)]) ?? lines[0] ?? null
  const active =
    (selected !== null ? (lines.find((l) => l.lineId === selected) ?? null) : null) ??
    firstUnrecorded
  const recordedCount = lines.filter((l) => takes[String(l.lineId)]).length
  const remaining = lines.length - recordedCount
  const isRecording = recorder.recordingLineId !== null

  // The silent cut is what you voice against — the same cascade the card and
  // detail page use, so this is whatever is actually rendered right now.
  const previewFile = usePreviewFile(
    uid,
    (job?.step ?? 'waiting_vo') as ProjectStep,
    job?.mode ?? 'dub_first',
    job?.mediaKey ?? 0
  )
  const stageVideoRef = useRef<HTMLVideoElement>(null)
  // Which line the PREVIEW is currently inside. Playing the cut SELECTS that
  // line (same state a click sets), so the recorder pane, its script and its
  // buttons all follow the scene on screen instead of only tinting a row.
  // (Distinct from `playingLineId`, which is the take being auditioned.)
  const [previewLineId, setPreviewLineId] = useState<number | null>(null)
  // Set while playback is what moved the selection, so the seek-to-line effect
  // below leaves the playhead alone — otherwise following the video would jump
  // it back to the line's start, over and over.
  const followingRef = useRef(false)
  useEffect(() => {
    let raf = 0
    const tick = (): void => {
      const v = stageVideoRef.current
      // Scene-level lookup: a line's own [first scene, last scene] span
      // overlaps its neighbours' whenever the AI interleaves angles, and the
      // first overlapping span always won.
      const hit = v && !v.paused ? lineIdAt(scenes, v.currentTime) : null
      setPreviewLineId((prev) => (prev === hit ? prev : hit))
      if (hit !== null) {
        setSelected((prev) => {
          if (prev === hit) return prev
          followingRef.current = true
          return hit
        })
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [scenes])

  // Park the preview at the start of whichever line is selected.
  useEffect(() => {
    const v = stageVideoRef.current
    if (!v || !active) return
    if (followingRef.current) {
      followingRef.current = false
      return
    }
    v.currentTime = active.outputIn
  }, [active?.lineId, previewFile])

  // Keep the selected row visible — following playback down a 12-line script
  // otherwise walks the selection off the bottom of the list.
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!active) return
    listRef.current
      ?.querySelector(`[data-line-id="${active.lineId}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [active?.lineId])

  const toggleRecord = useCallback((): void => {
    if (isRecording) recorder.stop()
    else if (active) void recorder.start(active.lineId)
  }, [isRecording, recorder, active])

  // Space is the recorder's primary control (R5 screen 4), but must not
  // hijack typing or re-trigger a held key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== 'Space' || e.repeat) return
      const el = e.target as HTMLElement | null
      if (el && /^(INPUT|TEXTAREA)$/.test(el.tagName)) return
      e.preventDefault()
      toggleRecord()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleRecord])

  if (!job) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted">ไม่พบโปรเจกต์นี้</p>
      </div>
    )
  }

  const playTake = (lineId: number): void => {
    const take = takes[String(lineId)]
    if (!take) return
    // No cache-buster: `urlFor` percent-encodes each path segment, so a "?k=…"
    // appended here became part of the FILE NAME (`line_5.webm%3Fk%3D…`) and
    // main resolved it as a literal file that cannot exist — every audition
    // 404'd silently and played nothing. media:// already answers every request
    // with `Cache-Control: no-store`, so there is nothing to bust.
    const audio = new Audio(window.noey.media.urlFor(uid, take.file))
    setPlayingLineId(lineId)
    audio.onended = () => setPlayingLineId(null)
    audio.onerror = () => setPlayingLineId(null)
    void audio.play()
  }

  const discardTake = async (lineId: number): Promise<void> => {
    const rest = { ...takes }
    delete rest[String(lineId)]
    await patch({ voiceoverTakes: rest })
    await window.noey.projects.deleteFile(uid, takeFileFor(lineId))
    // The sweep (voiceover/ is sweepable now) removes the discarded take's
    // server copy; project.json records the removal either way.
    job?.syncFiles('voiceover-discard')
  }

  const render = async (): Promise<void> => {
    setAssembling(true)
    try {
      const assembled = await assembleVoiceover(
        uid,
        lines.map((l) => l.lineId),
        takes
      )
      navigate({ name: 'progress', uid })
      await job.runFinalWithAudio(assembled.path)
    } catch (err) {
      showToast({ text: `ต่อเสียงพากย์ไม่สำเร็จ — ${String(err)}` })
    } finally {
      setAssembling(false)
    }
  }

  const skip = async (): Promise<void> => {
    const ok = await confirm({
      // Named for what the button ACTUALLY does. It titled itself
      // "เรนเดอร์แบบไม่มีเสียงพากย์?" and labelled the action "เรนเดอร์เลย",
      // then started no render at all — it navigates to the project and toasts
      // "ไม่ต้องเรนเดอร์ซ้ำ", contradicting the dialog the user just agreed to.
      title: 'ใช้คลิปที่ตัดไว้เลย ไม่ต้องพากย์?',
      body: 'คลิปที่ตัดไว้เป็นภาพอย่างเดียวไม่มีเสียงพูด เสียงที่อัดไว้ยังอยู่ กลับมาพากย์แล้วเรนเดอร์ใหม่ได้',
      confirmLabel: 'ใช้เลย'
    })
    if (!ok) return
    navigate({ name: 'detail', uid })
    showToast({ text: 'ใช้คลิปที่ตัดไว้ได้เลย — ไม่ต้องเรนเดอร์ซ้ำ' })
  }

  return (
    // Editor screen, not a content page (HANDOFF §4): one 56px toolbar instead
    // of the 34px page header, so the stage gets the height. The counter and
    // the mic live in the bar because they are standing facts about the
    // session, not cards to read.
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-divider px-4 py-2 md:h-14 md:flex-nowrap md:py-0 md:px-6">
        <Button
          variant="ghost"
          icon={<ArrowLeft size={16} />}
          onClick={() => navigate({ name: 'detail', uid })}
        >
          กลับ
        </Button>
        <span className="h-5 w-px bg-divider" />
        <p className="text-[15px] font-semibold text-ink">
          พากย์แล้ว <span className="tabular-nums">{recordedCount}</span> จาก{' '}
          <span className="tabular-nums">{lines.length}</span> ประโยค
        </p>
        {/* Its own line on a phone. Truncated in the toolbar row it was
            ~10px wide at 360, so a denied microphone permission — the one
            message on this screen that has to be read — showed nothing. */}
        <span
          className={cn(
            'order-last w-full min-w-0 text-sm md:order-none md:w-auto md:flex-1 md:truncate',
            recorder.micError ? 'text-error' : 'text-muted'
          )}
        >
          {recorder.micError ??
            (recorder.micLabel ? `ไมค์: ${recorder.micLabel}` : 'กด Space เพื่อเริ่ม–หยุดอัด')}
        </span>
        {remaining === 0 && lines.length > 0 ? (
          <Button variant="primary" loading={assembling} onClick={() => void render()}>
            เรนเดอร์วิดีโอ
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled
            disabledReason={
              lines.length === 0
                ? 'โปรเจกต์นี้ไม่มีประโยคพากย์'
                : `เหลืออีก ${remaining} ประโยคจึงเรนเดอร์ได้`
            }
          >
            เรนเดอร์วิดีโอ
          </Button>
        )}
      </div>

      {/* Below `lg` the line list goes under the preview: 520px of script beside
          a 250px video needs 800px of width before either is usable. */}
      {/* Below `lg` the column SCROLLS. It used to be overflow-hidden while
          stacked, so a 444px video plus the recorder pushed the record button
          and the take list off the bottom of a phone with no way to reach
          them. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        {/* Left: the cut, playing the line you are about to voice (R5 screen 4).
            Recording to picture is the whole point — without it you are reading
            a script and hoping it lands. Seeks to the line's own in-point
            whenever the selection changes; muted, because the cut's own audio
            would otherwise be picked up by the microphone. */}
        <div className="flex min-w-0 shrink-0 flex-col items-center justify-center gap-3 p-4 lg:min-h-0 lg:flex-1 lg:shrink lg:p-6">
          {previewFile ? (
            <VideoPlayer
              videoRef={stageVideoRef}
              mediaKey={`${uid}-${previewFile}-${job.mediaKey}`}
              src={window.noey.media.urlFor(uid, previewFile)}
              muted
              className="aspect-[9/16] h-[38dvh] w-auto max-w-full shrink-0 rounded-md sm:h-[46dvh] lg:h-[min(70dvh,444px)] lg:w-auto"
            />
          ) : (
            <div className="aspect-[9/16] h-[38dvh] w-auto max-w-full shrink-0 rounded-md bg-media sm:h-[46dvh] lg:h-[min(70dvh,444px)] lg:w-auto" />
          )}
          {active ? (
            <p className="text-[13px] tabular-nums text-muted">
              ช่วงของประโยคนี้ {fmtTenths(active.outputIn)}–{fmtTenths(active.outputOut)}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => void skip()}
            className="text-sm text-muted underline transition-colors duration-state ease-out hover:text-ink"
          >
            ไม่อยากพากย์เองก็ได้ — ข้ามไปใช้คลิปที่ไม่มีเสียงพากย์
          </button>
        </div>

        {/* Right: the line being voiced, its recorder, and every line. */}
        {/* Stacked, this pane sizes to its content and the OUTER column scrolls.
            It used to be `flex-1 overflow-hidden`: a definite-height parent
            hands a `flex-1` child only the leftover height, `overflow-hidden`
            drops its `min-height` floor to 0, and the recorder block alone is
            taller than what a phone leaves after the preview — so ทุกประโยค was
            clipped to nothing with no scrollbar to reach it. */}
        <div className="flex w-full shrink-0 flex-col border-t border-divider lg:min-h-0 lg:w-[520px] lg:flex-none lg:overflow-hidden lg:border-l lg:border-t-0">
          {active ? (
            <div className="shrink-0 border-b border-divider px-6 py-5">
              <p className="text-sm tabular-nums text-muted">
                ประโยคที่ {lines.indexOf(active) + 1} จาก {lines.length} · ยาวประมาณ{' '}
                {Math.max(1, Math.round(active.outputOut - active.outputIn))} วินาที
              </p>
              <p className="mt-2 text-[22px] leading-[1.5] text-ink" style={{ userSelect: 'text' }}>
                {active.script}
              </p>

              {isRecording ? (
                <>
                  {/* The whole recording block is red (R5): a bordered meter box
                      over the status row, so "you are live" is unmistakable. */}
                  <div className="mt-4 flex h-14 items-center justify-center rounded-md border border-[rgb(224_139_132_/_0.5)] bg-[rgb(224_139_132_/_0.06)]">
                    <LevelMeter level={recorder.level} />
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-4">
                    <span className="flex items-center gap-2 text-[15px] font-semibold tabular-nums text-error">
                      <span className="h-2 w-2 rounded-full bg-error" />
                      กำลังอัด {fmtTenths(recorder.elapsedSec)}
                    </span>
                    <Button variant="danger" icon={<Square size={16} />} onClick={recorder.stop}>
                      หยุดอัด
                    </Button>
                  </div>
                </>
              ) : (
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  {/* Button's props are a discriminated union — a conditional
                      `disabled` spread does not typecheck, so branch whole. */}
                  {recorder.hasMic === false ? (
                    <Button
                      variant="primary"
                      icon={<Mic size={16} />}
                      disabled
                      disabledReason="ไม่พบไมโครโฟนในเครื่องนี้ — เสียบไมค์หรือหูฟังที่มีไมค์ก่อน"
                    >
                      {takes[String(active.lineId)] ? 'อัดใหม่ทับ' : 'เริ่มอัด'}
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      icon={<Mic size={16} />}
                      loading={recorder.saving}
                      onClick={() => void recorder.start(active.lineId)}
                    >
                      {takes[String(active.lineId)] ? 'อัดใหม่ทับ' : 'เริ่มอัด'}
                    </Button>
                  )}
                  {takes[String(active.lineId)] ? (
                    <>
                      <Button
                        icon={<Play size={16} />}
                        onClick={() => playTake(active.lineId)}
                        loading={playingLineId === active.lineId}
                      >
                        ฟังเทคที่อัดไว้
                      </Button>
                      <Button
                        variant="ghost"
                        icon={<Trash2 size={16} />}
                        onClick={() => void discardTake(active.lineId)}
                      >
                        ทิ้งเทคนี้
                      </Button>
                    </>
                  ) : null}
                </div>
              )}
              <p className="mt-2.5 text-sm text-muted">
                อัดใหม่ทับได้เรื่อย ๆ ระบบเก็บเทคล่าสุดไว้ใช้
              </p>
            </div>
          ) : (
            <div className="shrink-0 border-b border-divider px-6 py-5">
              <p className="text-sm text-muted">
                โปรเจกต์นี้ไม่มีประโยคพากย์ — เรนเดอร์จากคลิปที่ตัดไว้ได้เลย
              </p>
            </div>
          )}

          <p className="shrink-0 px-6 pt-4 pb-2 text-[15px] font-semibold text-ink">ทุกประโยค</p>
          {/* Stacked, the pane is auto-height, so this list needs a CAP of its
              own or a 30-line script turns the page into an endless scroll and
              `scrollIntoView` drags the preview off screen with it. From `lg`
              it fills the rail as before. */}
          <div
            ref={listRef}
            className="scroll-ghost max-h-[50dvh] overflow-y-auto px-4 pb-4 lg:max-h-none lg:min-h-0 lg:flex-1"
          >
            {lines.map((line, i) => {
              const take = takes[String(line.lineId)]
              // Compare against the resolved selection, not the raw state —
              // with nothing picked yet the highlight must follow the derived
              // "next line to record".
              const isActive = line.lineId === active?.lineId
              const isLineRecording = recorder.recordingLineId === line.lineId
              const isPlaying = line.lineId === previewLineId
              return (
                // The whole row is the target: with the click handler on the
                // text alone you had to hit the glyphs themselves (live report
                // 2026-08-13).
                <div
                  key={line.lineId}
                  data-line-id={line.lineId}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelected(line.lineId)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setSelected(line.lineId)
                    }
                  }}
                  className={cn(
                    'mb-2 flex cursor-pointer items-center gap-3 rounded-md border px-4 py-3 transition-colors duration-state ease-out',
                    isLineRecording
                      ? 'border-error'
                      : isActive
                        ? 'border-accent bg-accent-tint'
                        : isPlaying
                          ? 'border-[rgb(217_164_65_/_0.45)] bg-[rgb(217_164_65_/_0.08)]'
                          : 'border-border hover:border-border-strong'
                  )}
                >
                  <span className="min-w-0 flex-1 truncate text-left text-sm text-ink">
                    <span className="tabular-nums text-muted">{i + 1}</span> · {line.script}
                  </span>
                  <span className="shrink-0 text-sm tabular-nums text-muted">
                    {isLineRecording ? (
                      <span className="text-error">กำลังอัด</span>
                    ) : take ? (
                      `อัดแล้ว ${fmtSec(take.durationSec)}`
                    ) : (
                      'ยังไม่ได้อัด'
                    )}
                  </span>
                  {/* Any take can be auditioned from the list (R5) — the take
                      you want to check is rarely the one you are recording. */}
                  {take && !isLineRecording ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        playTake(line.lineId)
                      }}
                      title="ฟังเทคนี้"
                      aria-label={`ฟังเทคประโยคที่ ${i + 1}`}
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded border border-border text-muted transition-colors duration-state ease-out hover:border-border-strong hover:text-ink sm:h-7 sm:w-7"
                    >
                      <Play size={13} />
                    </button>
                  ) : null}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
