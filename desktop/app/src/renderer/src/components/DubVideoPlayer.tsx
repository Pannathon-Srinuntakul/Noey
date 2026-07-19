import { useEffect, useRef, useState } from 'react'
import { ChevronDown, FileText, Film, X } from 'lucide-react'
import { groupScriptLines, type VoLine } from '../lib/dubScript'
import type { DubEditScript } from '../lib/videosLocalApi'

/** Ported 1:1 from web's dub_first video/script UI (frontend/src/pages/VideoPage.tsx:
 * DubMediaTabBar, DubScriptHintPanel, DubScriptVideoOverlay, DubVideoPlayer). */

const DUB_SCRIPT_GLASS = 'bg-black/70 backdrop-blur-md'
const DUB_SCRIPT_GRADIENT = 'bg-linear-to-t from-black/95 via-black/75 to-transparent'

function DubMediaTabBar({
  tab,
  label,
  onChange
}: {
  tab: 'video' | 'script'
  label: string
  onChange: (tab: 'video' | 'script') => void
}): React.JSX.Element {
  return (
    <div className="absolute inset-x-0 top-0 z-30 p-2">
      <div className="flex gap-1 rounded-lg bg-black/40 p-1 backdrop-blur-md">
        <button
          type="button"
          onClick={() => onChange('video')}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium transition-all ${
            tab === 'video'
              ? 'bg-white/25 text-white shadow-sm'
              : 'text-white/65 hover:bg-white/10 hover:text-white'
          }`}
        >
          <Film size={11} /> คลิป
        </button>
        <button
          type="button"
          onClick={() => onChange('script')}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium transition-all ${
            tab === 'script'
              ? 'bg-white/25 text-white shadow-sm'
              : 'text-white/65 hover:bg-white/10 hover:text-white'
          }`}
        >
          <FileText size={11} /> {label}
        </button>
      </div>
    </div>
  )
}

function DubScriptHintPanel({
  open,
  active,
  onOpenFull,
  onClose
}: {
  open: boolean
  active: VoLine
  onOpenFull: () => void
  onClose: () => void
}): React.JSX.Element | null {
  const [render, setRender] = useState(open)
  const [entered, setEntered] = useState(false)

  useEffect(() => {
    if (open) {
      setRender(true)
      const id = requestAnimationFrame(() => {
        requestAnimationFrame(() => setEntered(true))
      })
      return () => cancelAnimationFrame(id)
    }
    setEntered(false)
    const timer = window.setTimeout(() => setRender(false), 300)
    return () => clearTimeout(timer)
  }, [open])

  if (!render) return null

  const meta =
    active.cutCount > 1
      ? `บรรทัด ${active.lineId} · ${active.cutCount} มุม · ${active.outputIn.toFixed(1)}s – ${active.outputOut.toFixed(1)}s`
      : `บรรทัด ${active.lineId} · ${active.outputIn.toFixed(1)}s – ${active.outputOut.toFixed(1)}s`

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-5">
      <div
        className={`pointer-events-auto relative transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] ${
          entered ? 'translate-y-0 opacity-100' : 'translate-y-6 opacity-0'
        }`}
      >
        <button
          type="button"
          onClick={onOpenFull}
          className={`w-full ${DUB_SCRIPT_GRADIENT} px-3 pb-3 pt-10 text-left`}
        >
          <p className="mb-1 text-[10px] font-semibold text-amber-300">{meta}</p>
          <p className="line-clamp-3 text-sm leading-snug text-white">{active.script}</p>
          <p className="mt-1.5 text-[10px] font-medium text-amber-200/80">
            แตะเพื่อดู script ทั้งหมด
          </p>
        </button>
        <button
          type="button"
          onClick={onClose}
          className={`absolute right-2 top-2 rounded-full p-1 text-white/70 ${DUB_SCRIPT_GLASS} hover:text-white`}
          aria-label="ซ่อน script"
        >
          <ChevronDown size={14} />
        </button>
      </div>
    </div>
  )
}

function DubScriptVideoOverlay({
  open,
  lines,
  activeLineId,
  onClose,
  onLineClick,
  registerRef
}: {
  open: boolean
  lines: VoLine[]
  activeLineId: number | null
  onClose: () => void
  onLineClick: (outputIn: number) => void
  registerRef: (lineId: number, el: HTMLElement | null) => void
}): React.JSX.Element | null {
  const [render, setRender] = useState(open)
  const [entered, setEntered] = useState(false)
  const totalSec = lines.length > 0 ? lines[lines.length - 1].outputOut : 0
  const cutCount = lines.reduce((n, l) => n + l.cutCount, 0)

  useEffect(() => {
    if (open) {
      setRender(true)
      const id = requestAnimationFrame(() => {
        requestAnimationFrame(() => setEntered(true))
      })
      return () => cancelAnimationFrame(id)
    }
    setEntered(false)
    const timer = window.setTimeout(() => setRender(false), 320)
    return () => clearTimeout(timer)
  }, [open])

  if (!render) return null

  return (
    <div className="absolute inset-0 z-10 flex flex-col justify-end overflow-hidden">
      <button
        type="button"
        aria-label="ปิด script overlay"
        onClick={onClose}
        className={`absolute inset-0 ${DUB_SCRIPT_GLASS} transition-opacity duration-300 ease-out ${
          entered ? 'opacity-100' : 'opacity-0'
        }`}
      />
      <div
        className={`relative flex max-h-[92%] flex-col border-t border-white/10 ${DUB_SCRIPT_GLASS} shadow-[0_-12px_40px_rgba(0,0,0,0.45)] transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] ${
          entered ? 'translate-y-0' : 'translate-y-full'
        }`}
        role="dialog"
        aria-modal="true"
        aria-label="Script ทั้งหมด"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-white/15 px-3 py-2.5">
          <div>
            <p className="text-xs font-semibold text-white drop-shadow-sm">Script ทั้งหมด</p>
            <p className="text-[10px] text-white/70">
              {lines.length} บรรทัด · {cutCount} มุม · ~{Math.round(totalSec)} วิ · แตะเพื่อ jump
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-white/80 hover:bg-white/15 hover:text-white"
            aria-label="ปิด"
          >
            <X size={16} />
          </button>
        </div>
        <div className="scroll-ghost min-h-0 flex-1 overflow-y-auto p-2">
          {lines.map((line) => {
            const isActive = activeLineId === line.lineId
            return (
              <button
                key={line.lineId}
                type="button"
                ref={(el) => registerRef(line.lineId, el)}
                onClick={() => onLineClick(line.outputIn)}
                className={`mb-2 w-full rounded-md border px-3 py-2.5 text-left shadow-sm last:mb-0 ${
                  isActive
                    ? 'border-amber-500 bg-amber-50 ring-1 ring-amber-400/40'
                    : 'border-stone-200 bg-white hover:border-stone-300 hover:bg-stone-50'
                }`}
              >
                <div className="mb-1.5 flex flex-wrap items-center gap-2">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-amber-600 text-[10px] font-bold text-white">
                    {line.lineId}
                  </span>
                  <span className="rounded bg-stone-900 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-white">
                    {line.outputIn.toFixed(1)}s – {line.outputOut.toFixed(1)}s
                  </span>
                  {line.cutCount > 1 && (
                    <span className="rounded bg-purple-100 px-1.5 py-0.5 text-[10px] font-medium text-purple-800">
                      {line.cutCount} มุม
                    </span>
                  )}
                </div>
                <p className="text-[13px] leading-relaxed text-stone-900">{line.script}</p>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

interface Props {
  src: string
  mediaKey: number
  editScript: DubEditScript | null
}

export default function DubVideoPlayer({ src, mediaKey, editScript }: Props): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const segmentRefs = useRef<Map<number, HTMLElement>>(new Map())
  const wasPlayingBeforeOverlayRef = useRef(false)
  const [tab, setTab] = useState<'video' | 'script'>('video')
  const [currentTime, setCurrentTime] = useState(0)
  const [scriptOverlayOpen, setScriptOverlayOpen] = useState(false)
  const [hintExpanded, setHintExpanded] = useState(false)

  const scriptLines: VoLine[] = editScript ? groupScriptLines(editScript) : []
  // highlight mode (no voiceover) never has real script text — fall back to
  // the AI's per-scene visualDescription so the tab shows something useful
  // instead of a blank "Script" panel, and relabel it accordingly.
  const hasRealScript = scriptLines.some((l) => l.script)
  const lines: VoLine[] = scriptLines.map((l) => ({ ...l, script: l.script || l.visualDescription }))
  const hasContent = lines.some((l) => l.script)
  const tabLabel = hasRealScript ? 'Script' : 'โน้ตฉาก'
  const active = lines.find((l) => currentTime >= l.outputIn && currentTime < l.outputOut) ?? null

  useEffect(() => {
    if (!scriptOverlayOpen || !active) return
    const el = segmentRefs.current.get(active.lineId)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [scriptOverlayOpen, active?.lineId])

  function openScriptOverlay(): void {
    const video = videoRef.current
    wasPlayingBeforeOverlayRef.current = video ? !video.paused : false
    video?.pause()
    setHintExpanded(false)
    setScriptOverlayOpen(true)
  }

  function closeScriptOverlay(): void {
    setScriptOverlayOpen(false)
    const video = videoRef.current
    if (!video || !wasPlayingBeforeOverlayRef.current) return
    window.setTimeout(() => void video.play(), 280)
  }

  function seekTo(outputIn: number): void {
    const video = videoRef.current
    if (!video) return
    video.currentTime = outputIn + 0.02
    setScriptOverlayOpen(false)
    window.setTimeout(() => void video.play(), 280)
  }

  return (
    <div className="relative aspect-9/16 w-full overflow-hidden rounded-lg bg-black">
      {hasContent && <DubMediaTabBar tab={tab} label={tabLabel} onChange={setTab} />}

      {tab === 'video' ? (
        <>
          <video
            ref={videoRef}
            key={mediaKey}
            src={src}
            controls
            playsInline
            preload="metadata"
            className="h-full w-full bg-black object-contain"
            onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
            onSeeked={(e) => setCurrentTime(e.currentTarget.currentTime)}
          />
          <DubScriptVideoOverlay
            open={scriptOverlayOpen}
            lines={lines}
            activeLineId={active?.lineId ?? null}
            onClose={closeScriptOverlay}
            onLineClick={seekTo}
            registerRef={(lineId, el) => {
              if (el) segmentRefs.current.set(lineId, el)
              else segmentRefs.current.delete(lineId)
            }}
          />
          {!scriptOverlayOpen && hasContent && !hintExpanded && (
            <button
              type="button"
              onClick={() => (active ? setHintExpanded(true) : openScriptOverlay())}
              className={`absolute bottom-12 right-2 z-5 flex items-center gap-1.5 rounded-full border border-white/10 px-3 py-1.5 text-[11px] font-medium text-white shadow-lg ${DUB_SCRIPT_GLASS} hover:bg-black/80`}
            >
              <FileText size={12} />
              {active ? `บรรทัด ${active.lineId}` : `${tabLabel} ${lines.length}`}
            </button>
          )}
          {!scriptOverlayOpen && active && (
            <DubScriptHintPanel
              open={hintExpanded}
              active={active}
              onOpenFull={openScriptOverlay}
              onClose={() => setHintExpanded(false)}
            />
          )}
        </>
      ) : (
        <div className="scroll-ghost h-full overflow-y-auto p-2 pt-12">
          {lines.map((line) => (
            <div
              key={line.lineId}
              className="mb-2 w-full rounded-md border border-stone-200 bg-white px-3 py-2.5 text-left shadow-sm last:mb-0"
            >
              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-amber-600 text-[10px] font-bold text-white">
                  {line.lineId}
                </span>
                <span className="rounded bg-stone-900 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-white">
                  {line.outputIn.toFixed(1)}s – {line.outputOut.toFixed(1)}s
                </span>
                {line.cutCount > 1 && (
                  <span className="rounded bg-purple-100 px-1.5 py-0.5 text-[10px] font-medium text-purple-800">
                    {line.cutCount} มุม
                  </span>
                )}
              </div>
              <p className="text-[13px] leading-relaxed text-stone-900">{line.script}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
