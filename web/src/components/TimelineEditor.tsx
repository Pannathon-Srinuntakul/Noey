/**
 * Video timeline editor — R3.
 *
 * Three regions: video stage (centre) + inspector (right) + timeline (bottom).
 * The timeline is STATIC with a MOVING playhead: the current time
 * (`currentTimeRef`) is the source of truth and the playhead is a positioned
 * element painted imperatively — scrolling the timeline never changes the time
 * (the pre-R3 editor was the inverse: a fixed centre playhead with
 * `scrollLeft` as the clock).
 *
 * Time domains:
 * - edited (ตัดแล้ว): t ∈ [0, sum of cut durations], cuts back-to-back.
 * - source (ต้นฉบับ): t is LOCAL to the active source file; files stack as
 *   parallel lanes sharing one time axis (R3 sub-frame จ), so there is no
 *   concatenated "global" source domain anymore.
 *
 * Pure geometry/edit math lives in lib/timelineMath.ts (unit-tested).
 * The screen's pieces — lanes, dialogs, the ruler, the shortcut table and the
 * layout constants — live in components/timeline/; this file is the editor.
 *
 * Its state is split into hooks in components/timeline/hooks/: useEditorHistory
 * (undo/redo, kept for the session), useTimelineViewport (zoom, scroll and the
 * imperative playhead paint), usePreviewPlayer (the two <video> elements and
 * everything that moves the clock), useDraftAutosave and useWindowKeydown.
 * What they share — the cut list, the selection, the view — stays here, and
 * the cut list has exactly one writer: writeCuts.
 *
 * What it renders is split the same way: the header, the preview, the
 * inspector's parts, the toolbar, the ruler, each lane and the playhead are
 * memo()'d components in components/timeline/, handed props that keep their
 * identity — every function a useStableCallback wrapper or a state setter,
 * every array and map memoized — so a trim, a seek or a keystroke renders only
 * the parts it changed. The time itself never renders anything: it is painted
 * to the DOM, and the one thing that must follow it in React, the voiceover
 * line being spoken, is told through paintTime's onPaint.
 */
import type { DragEndEvent } from '@dnd-kit/core'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  captionDeriver,
  editorApi,
  initialCaptionEdits,
  initialCaptionTimeBase,
  initialCaptionStyle,
  initialMusic,
  type CaptionLine,
  type EditCut,
  type EditorMusic,
  type EditTimeline,
  type MusicPatch
} from '../lib/editorApi'
import { formatUserError, musicSupported } from '../lib/editorApi'
import type { CaptionStyle } from '../lib/captionStyle'
import { captionLinesToSrt } from '../lib/captionLines'
import {
  applyCaptionEdit,
  deleteCaptionEdit,
  newCaptionEditId,
  resolveCaptionLines
} from '../lib/captionEdits'
import {
  MIN_CUT_SEC,
  DEFAULT_NEW_CUT_SEC,
  captionChipSpans,
  captionChipSpansFromOutput,
  dragCaptionEdge,
  clamp,
  computeEditedDuration,
  computeEditedSegments,
  cutLineId,
  findEditedSegment,
  findSourceCutAtTime,
  lineScriptFor,
  mapSourceTimeToOutput,
  normalizeDubCuts,
  removedSpanStats,
  snapCaptionEdge,
  cutBoundariesSec,
  sourceNeighborBounds,
  splitCutAt,
  voiceoverLineBlocks,
  withDuplicate,
  withNewAngle,
  withNewScene,
  withReorder,
  type CaptionChipSpan,
  type TrimEdge
} from '../lib/timelineMath'
import { decodeAudioPeaks } from '../lib/waveform'
import { TimelineViewportContext } from '../lib/timelineViewport'
import { useFilmstripStrips } from '../lib/useFilmstripStrips'
import { Tabs } from './ui/Tabs'
import { useFxJobs } from '../lib/fxJobs'
import {
  highestNewCutNumber,
  sameCaptionStyle,
  sameMusic,
  type EditorSnapshot
} from '../lib/editorHistory'
import { useStableCallback } from '../lib/useStableCallback'
import { canUseAiReedit } from '../lib/platformFeatures'
import { FRAME_SEC, HEADER_COL_PX, RULER_PX } from './timeline/constants'
import { isTypingTarget, matchesShortcutParts } from './timeline/shortcuts'
import { TimelineRuler } from './timeline/TimelineRuler'
import type { TrimSnapContext, WorkingCut } from './timeline/types'
import { aiReeditPayload, cutPayload } from './timeline/cutPayload'
import { useDraftAutosave } from './timeline/hooks/useDraftAutosave'
import { useEditorHistory } from './timeline/hooks/useEditorHistory'
import { usePreviewPlayer } from './timeline/hooks/usePreviewPlayer'
import { useTimelineViewport } from './timeline/hooks/useTimelineViewport'
import { useWindowKeydown } from './timeline/hooks/useWindowKeydown'
import { AiReeditDialog, type AiReeditLine } from './timeline/dialogs/AiReeditDialog'
import { CaptionStyleDialog } from './timeline/dialogs/CaptionStyleDialog'
import { ShortcutsSheet } from './timeline/dialogs/ShortcutsSheet'
import { BeatTicks } from './timeline/BeatTicks'
import { EditorHeader } from './timeline/EditorHeader'
import { ErrorBar } from './timeline/ErrorBar'
import { Playhead } from './timeline/Playhead'
import { PreparingScreen } from './timeline/PreparingScreen'
import { PreviewPane, type PreviewVideoEvents } from './timeline/PreviewPane'
import { TimelineToolbar } from './timeline/TimelineToolbar'
import { CaptionFooter, CaptionTabBody } from './timeline/inspector/CaptionTab'
import { SceneActions } from './timeline/inspector/SceneActions'
import { ScriptTab } from './timeline/inspector/ScriptTab'
import { SelectedSceneHeader } from './timeline/inspector/SelectedSceneHeader'
import { CaptionLane } from './timeline/lanes/CaptionLane'
import { ImageLane } from './timeline/lanes/ImageLane'
import { MusicLane } from './timeline/lanes/MusicLane'
import { SourceLanes } from './timeline/lanes/SourceLanes'
import { VoiceoverLane } from './timeline/lanes/VoiceoverLane'

interface Props {
  uid: string
  mode: string
  /** Shown in the overlay's own title strip, like the shell's would be. */
  projectName?: string
  onClose: () => void
  /** Called after a successful save — caller should re-poll project status. */
  onSaved: () => void
}

/** Caption style steps closer together than this are one edit — see
 * changeCaptionStyle. */
const CAPTION_STYLE_BURST_MS = 400

/** Stable empty list — a fresh `[]` per render would restart the extraction. */
const EMPTY_FILMSTRIP_CLIPS: { id: string; file: string }[] = []

/**
 * A click must not leave keyboard focus on a button or a scene block. The next
 * key (Space to play, an arrow to nudge) then drew the global gold focus ring
 * around it, and Space could press a focused button (owner, 2026-09-22:
 * "ไม่ว่าจะกดอะไรฉันก็ไม่ต้องการให้มันขึ้นโฟกัสแบบนี้"). Preventing the
 * mousedown default keeps focus where it was without cancelling the click or
 * dnd-kit's pointer events; a text box that had focus is blurred, which commits
 * it, so the next Space plays instead of typing. Text fields, sliders and
 * dialogs keep the default — they need focus to work.
 */
function keepFocusOffControls(e: React.MouseEvent): void {
  const target = e.target as HTMLElement
  if (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return
  if (!target.closest('button, a, [role="button"], [data-cut-block]')) return
  e.preventDefault()
  const active = document.activeElement
  if (active instanceof HTMLElement && active !== document.body) active.blur()
}

/**
 * Memoized: its route re-renders on every jobs-store publish — each draft save
 * is one — and the editor has nothing to redraw for it.
 */
export const VideoTimelineEditor = memo(function VideoTimelineEditor({
  uid,
  mode,
  projectName,
  onClose,
  onSaved
}: Props) {
  // AI re-edit runs at app level so leaving the editor doesn't kill it.
  const fxJobs = useFxJobs()
  const isDub = mode === 'dub_first' || mode === 'highlight'
  const isHighlight = mode === 'highlight'
  // The editor is configured before it mounts (TimelineRoute), so this is
  // fixed for the editor's life.
  const canHaveMusic = musicSupported()
  const [timeline, setTimeline] = useState<EditTimeline | null>(null)
  const [cuts, setCuts] = useState<WorkingCut[]>([])
  const [editorPhase, setEditorPhase] = useState<'loading' | 'preparing' | 'ready'>('loading')
  const [prepareHint, setPrepareHint] = useState('')
  // Set once the timeline + first preview are in: from then on only the
  // filmstrip is being waited for, and the effect below owns the flip to
  // 'ready' (strips landed / failed / wait cap / user pressed skip).
  const [filmstripGateArmed, setFilmstripGateArmed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // What "ลองอีกครั้ง" on the error bar re-runs — only a failed save is retryable.
  const [errorRetry, setErrorRetry] = useState<'save' | null>(null)
  const [saving, setSaving] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'source' | 'edited'>('edited')
  // The caption lines the user EDITED (captionEdits.ts) — what history,
  // the draft and the save carry. null = captions off. The lines on screen
  // are derived from the cut and these, below.
  const [captionEdits, setCaptionEdits] = useState<CaptionLine[] | null>(null)
  const captionEditsRef = useRef<CaptionLine[] | null>(null)
  const [deriveCaptions] = useState(() => captionDeriver())
  // Which clock the lines are on — see initialCaptionTimeBase. dub_first
  // captions are OUTPUT-timed; treating them as source time dropped all but
  // one chip from the lane (live 2026-08-13).
  const captionsOnOutputClock = initialCaptionTimeBase() === 'output'
  const [captionCursor, setCaptionCursor] = useState(0)
  const [captionStyle, setCaptionStyle] = useState<CaptionStyle | null>(null)
  const [captionStyleOpen, setCaptionStyleOpen] = useState(false)
  const [inspectorTab, setInspectorTab] = useState<'script' | 'caption'>('script')

  const [srtBusy, setSrtBusy] = useState(false)
  const [srtNote, setSrtNote] = useState<string | null>(null)
  /** Scene boundaries in the SAME clock the caption lines are stored in — the
   * window-level drag handler reads this, so it has to be a ref. dub lines are
   * output-time; talking_head lines are source-time (see captionsOnOutputClock),
   * and snapping against the wrong clock would move edges to nonsense. */
  const boundariesRef = useRef<number[]>([])

  // The lines on screen as of the last commit, for code that runs outside
  // render — the preview's caption overlay, a caption edit's lookup.
  const captionLinesRef = useRef<CaptionLine[] | null>(null)
  const [music, setMusic] = useState<EditorMusic | null>(null)
  const [musicPeaks, setMusicPeaks] = useState<number[] | null>(null)
  const [musicDurationSec, setMusicDurationSec] = useState(0)
  const [snapToBeatEnabled, setSnapToBeatEnabled] = useState(true)
  const [musicBusy, setMusicBusy] = useState(false)
  const [musicDraft, setMusicDraft] = useState<MusicPatch | null>(null)

  const currentTimeRef = useRef(0)
  const musicAudioRef = useRef<HTMLAudioElement>(null)
  const [videoDuration, setVideoDuration] = useState(0)
  const [previewSource, setPreviewSource] = useState<string | null>(null)
  const isCutBlockEditingRef = useRef(false)
  const cutsRef = useRef<WorkingCut[]>([])
  const viewModeRef = useRef<'source' | 'edited'>('edited')
  const newCutCounter = useRef(0)
  // Thumbnail lanes: the `filmstrip` job decodes every source's strip once
  // (engine/jobs/filmstrip.ts), the lanes draw the JPEGs into a canvas. Nothing about
  // them lives in this component's state — see FilmstripCanvas.
  const filmstripSources = editorApi.filmstripSources()
  const filmstrip = useFilmstripStrips(
    filmstripSources?.localUid ?? null,
    filmstripSources?.clips ?? EMPTY_FILMSTRIP_CLIPS
  )
  const strips = filmstrip.strips
  const [shortcutsOpen, setShortcutsOpen] = useState(false)

  // AI re-edit (dub_first, pre-render only) — selection is by voiceoverLineId.
  const [aiPanelOpen, setAiPanelOpen] = useState(false)
  const [aiChecked, setAiChecked] = useState<Set<number>>(new Set())
  const [aiInstruction, setAiInstruction] = useState('')
  // Busy/error for the AI re-edit come from the app-level job store (the work
  // outlives this screen); only a locally-raised error lives here.
  const [localAiError, setLocalAiError] = useState<string | null>(null)
  // The voiceover line the playhead is inside — the VO lane's "speaking" one.
  // Set by onPaint below, and only when the line changes.
  const [playingLineId, setPlayingLineId] = useState<number | null>(null)
  const playingLineIdRef = useRef<number | null>(null)

  // Mirrors for the fields a snapshot has to read from event handlers
  // (captionLinesRef is declared above; cutsRef is written by writeCuts
  // itself).
  const captionStyleRef = useRef<CaptionStyle | null>(null)
  const musicRef = useRef<EditorMusic | null>(null)
  useEffect(() => {
    captionStyleRef.current = captionStyle
  }, [captionStyle])

  // The caption size slider and colour pickers call changeCaptionStyle on
  // every input step. A burst of steps is one edit: one undo step (pushed
  // only when the previous step is more than CAPTION_STYLE_BURST_MS old) and
  // one project write, of the last value, once the burst goes quiet.
  const captionStyleStepAtRef = useRef(0)
  const captionStyleWriteRef = useRef<{ timer: number; style: CaptionStyle } | null>(null)
  const flushCaptionStyleWrite = (): void => {
    const pending = captionStyleWriteRef.current
    if (!pending) return
    captionStyleWriteRef.current = null
    window.clearTimeout(pending.timer)
    void editorApi.updateCaptionStyle(pending.style)
  }
  // Leaving the editor mid-burst still lands the last value.
  useEffect(
    () => () => {
      const pending = captionStyleWriteRef.current
      if (!pending) return
      captionStyleWriteRef.current = null
      window.clearTimeout(pending.timer)
      void editorApi.updateCaptionStyle(pending.style)
    },
    []
  )
  useEffect(() => {
    musicRef.current = music
  }, [music])
  useEffect(() => {
    viewModeRef.current = viewMode
  }, [viewMode])

  const playOrderMap = useMemo(() => new Map(cuts.map((c, i) => [c.id, i + 1])), [cuts])

  // ---- derived data ----------------------------------------------------------
  // Memoized, so each part below is handed the same array or map until what it
  // is built from changes — the parts are memo()'d, and a new one per render
  // would render them anyway. The frame loop reads the layout from here too,
  // instead of laying the cut list out again on every frame.

  const editedSegments = useMemo(() => computeEditedSegments(cuts), [cuts])
  const editedDur = useMemo(() => computeEditedDuration(cuts), [cuts])
  // Each block's start on the edited clock, computed once per cut change
  // instead of once PER BLOCK per render (it was O(n²) on every drag frame).
  const editedInById = useMemo(
    () => new Map(editedSegments.map((s) => [s.cut.id, s.editedIn])),
    [editedSegments]
  )
  const voBlocks = useMemo(
    () => (isDub && viewMode === 'edited' ? voiceoverLineBlocks(cuts) : []),
    [isDub, viewMode, cuts]
  )
  // The caption chips and the scene boundaries depend only on each scene's
  // range and place in the order. Keyed on exactly that, an edit that moves
  // nothing — typing a line's script replaces its cuts — keeps both arrays,
  // and the caption and music lanes skip the render.
  const cutRangesKey = cuts.map((c) => `${c.in}:${c.out}`).join('|')
  // Everything the caption derivation reads from a cut: its footage, its
  // place, and for a dub its line and script — retyping a line re-splits it.
  const captionCutsKey = cuts
    .map(
      (c) => `${c.source}:${c.in}:${c.out}:${c.voiceoverLineId ?? ''}:${c.voiceoverScript ?? ''}`
    )
    .join('|')
  // The lines on screen: derived from the cut as it is NOW, with the user's
  // edits laid over — the same resolution the render runs, so the lane, the
  // overlay and the exported .srt follow every trim, delete and reorder.
  const captionLines = useMemo(
    () =>
      captionEdits === null
        ? null
        : resolveCaptionLines(deriveCaptions ? deriveCaptions(cuts) : [], captionEdits, cuts),
    [captionEdits, captionCutsKey, deriveCaptions]
  )
  const capSpans = useMemo(
    () =>
      captionLines && viewMode === 'edited'
        ? captionsOnOutputClock
          ? captionChipSpansFromOutput(cuts, captionLines)
          : captionChipSpans(cuts, captionLines)
        : [],
    [captionLines, viewMode, captionsOnOutputClock, cutRangesKey]
  )
  /** Scene boundaries on the output clock — what music snaps to. */
  const outputCutBoundaries = useMemo(() => cutBoundariesSec(cuts), [cutRangesKey])
  // The same boundaries in the clock the caption lines are stored in — what a
  // dragged caption edge snaps to (see boundariesRef).
  const captionSnapBoundaries = useMemo(
    () => (captionsOnOutputClock ? outputCutBoundaries : cuts.flatMap((c) => [c.in, c.out])),
    [captionsOnOutputClock, outputCutBoundaries, cutRangesKey]
  )
  const thStats = useMemo(
    () => (!isDub && timeline ? removedSpanStats(cuts, timeline.sources) : null),
    [isDub, timeline, cuts]
  )
  const cutsBySource = useMemo(
    () =>
      new Map((timeline?.sources ?? []).map((s) => [s.id, cuts.filter((c) => c.source === s.id)])),
    [timeline, cuts]
  )
  const sourceDurationById = useMemo(() => {
    const byId = new Map<string, number>()
    for (const s of timeline?.sources ?? []) if (!byId.has(s.id)) byId.set(s.id, s.durationSec)
    return byId
  }, [timeline])
  const laneDurationById = useMemo(
    () => new Map((timeline?.sources ?? []).map((s) => [s.id, getSourceDurationSec(s.id)])),
    [timeline, cuts, previewSource, videoDuration]
  )
  const effectiveMusic: EditorMusic | null = useMemo(
    () => (music ? { ...music, ...musicDraft } : null),
    [music, musicDraft]
  )
  // Only while the dialog is open — nothing else reads it.
  const aiLines = useMemo(() => {
    if (!aiPanelOpen) return []
    const seen = new Map<number, AiReeditLine>()
    for (const c of cuts) {
      const lid = cutLineId(c)
      const existing = seen.get(lid)
      if (existing) existing.cutCount += 1
      else seen.set(lid, { id: lid, script: lineScriptFor(cuts, lid), cutCount: 1 })
    }
    return Array.from(seen.values()).sort((a, b) => a.id - b.id)
  }, [aiPanelOpen, cuts])

  // Every paint of the clock — each frame while playing — passes through here.
  // Selection says what you are EDITING; this says what the clip is SAYING —
  // while it plays you want to read along without every scene change stealing
  // your selection. It used to be derived from a `currentTime` state that only
  // moved on `timeupdate`, so the highlight trailed a playing line by up to a
  // quarter of a second.
  const onPaint = useStableCallback((t: number) => {
    const lineId =
      voBlocks.find((b) => t >= b.outStart && t < b.outStart + b.durationSec)?.lineId ?? null
    if (lineId === playingLineIdRef.current) return
    playingLineIdRef.current = lineId
    setPlayingLineId(lineId)
  })

  function getSourceDurationSec(sourceId: string | null): number {
    if (!timeline || !sourceId) return videoDuration
    const meta = timeline.sources.find((s) => s.id === sourceId)?.durationSec ?? 0
    const maxCutOut = cuts
      .filter((c) => c.source === sourceId)
      .reduce((m, c) => Math.max(m, c.out), 0)
    const loadedVideo = previewSource === sourceId ? videoDuration : 0
    return Math.max(meta, loadedVideo, maxCutOut)
  }

  /** Longest source file — the shared time axis all source lanes sit under. */
  function getSourceAxisDurationSec(): number {
    if (!timeline) return videoDuration
    return timeline.sources.reduce((m, s) => Math.max(m, getSourceDurationSec(s.id)), 0)
  }

  /** Total duration of the domain the playhead currently lives in. Source mode
   * is LOCAL to the active file (lanes share the axis, the clock is the file's). */
  function getActiveDurationSec(): number {
    return viewMode === 'edited' ? editedDur : getSourceDurationSec(previewSource)
  }

  /** The time axis the lanes are drawn to: the edited sequence, or in source
   * view the longest file (every source lane shares one axis). */
  function getAxisDurationSec(): number {
    return viewMode === 'edited' ? editedDur : getSourceAxisDurationSec()
  }

  /** The state as it is right now, with any part the caller already holds. */
  function snapshotNow(overrides?: Partial<EditorSnapshot>): EditorSnapshot {
    return {
      cuts: cutsRef.current,
      captionLines: captionEditsRef.current,
      captionStyle: captionStyleRef.current,
      music: musicRef.current,
      ...overrides
    }
  }

  /**
   * Put a snapshot back on screen AND on disk.
   *
   * Caption appearance and the music track are not editor-local: they live on
   * the project and the music mix is re-rendered from them, so restoring them
   * means writing them back through the same seam that changed them. Cuts and
   * caption lines are editor-local until the next save/draft-save.
   */
  async function applySnapshot(next: EditorSnapshot): Promise<void> {
    writeCuts(next.cuts)
    setSelectedId((id) => (id && next.cuts.some((c) => c.id === id) ? id : null))
    setCaptionEdits(next.captionLines)
    captionEditsRef.current = next.captionLines

    // A burst still waiting to write would land AFTER this restore and undo
    // it; the snapshot is what goes to disk now. Ending the burst also makes
    // the next change its own undo step.
    if (captionStyleWriteRef.current) {
      window.clearTimeout(captionStyleWriteRef.current.timer)
      captionStyleWriteRef.current = null
    }
    captionStyleStepAtRef.current = 0
    if (!sameCaptionStyle(next.captionStyle, captionStyleRef.current)) {
      setCaptionStyle(next.captionStyle)
      captionStyleRef.current = next.captionStyle
      if (next.captionStyle) {
        void editorApi.updateCaptionStyle(next.captionStyle).catch(() => undefined)
      }
    }

    if (!sameMusic(next.music, musicRef.current)) {
      const target = next.music
      setMusic(target)
      musicRef.current = target
      setMusicDraft(null)
      setMusicBusy(true)
      try {
        await editorApi.setMusic(target)
      } catch (err) {
        setError(formatUserError(err))
        setErrorRetry(null)
      } finally {
        setMusicBusy(false)
      }
    }
  }

  const {
    push: pushHistory,
    pushNow: pushHistoryNow,
    beginEdit,
    commitEdit,
    settleEdit,
    undo,
    redo,
    canUndo,
    canRedo,
    editCount,
    resume
  } = useEditorHistory(uid, snapshotNow, applySnapshot)

  function beginCutBlockEdit() {
    isCutBlockEditingRef.current = true
    beginEdit()
  }

  function commitCutBlockEdit() {
    isCutBlockEditingRef.current = false
    commitEdit()
  }

  const {
    pxPerSec,
    setPxPerSec,
    pxPerSecRef,
    viewportRef,
    playheadRef,
    playheadLineRef,
    seekbarRef,
    timeLabelRef,
    isScrubbingSeekbarRef,
    viewportStore,
    getContentWidthPx,
    paintTime,
    followPlayhead,
    resumeFollow,
    revealPlayhead,
    onViewportScroll,
    timeAtClientX,
    fitToScreen,
    queueScrollShift
  } = useTimelineViewport({
    editorPhase,
    viewMode,
    cuts,
    videoDuration,
    currentTimeRef,
    getActiveDurationSec,
    getAxisDurationSec,
    onPaint
  })

  // The frame loop runs across renders; through this it keeps the music on the
  // track as it is NOW. It used to hold the render it started in, so a music
  // move or trim made while playing was seeked back to the old spot every
  // frame until something restarted the loop (a pause, a cut edit, the next
  // source file).
  const syncMusicAudioLatest = useStableCallback((t: number, allowPlay: boolean) =>
    syncMusicAudio(t, allowPlay)
  )
  const {
    videoARef,
    videoBRef,
    captionOverlayRef,
    holdFrameRef,
    playRangeRef,
    editedActiveCutIdRef,
    isPlaying,
    setIsPlaying,
    previewSrc,
    setPreviewSrc,
    loadPreviewFor,
    selectCut,
    showCutFrame,
    applyScrubTime,
    pauseForScrub,
    resumeAfterScrub,
    onRulerPointerDown,
    onLaneBackgroundPointerDown,
    onSourceLanePointerDown,
    togglePlay,
    nudgePlayhead,
    switchViewMode,
    syncCaptionOverlay,
    isActiveVideoEvent,
    onTimeUpdate,
    onVideoLoadedMetadata,
    syncTimeFromVideo,
    onVideoEnded,
    onVideoPaused
  } = usePreviewPlayer({
    uid,
    timeline,
    cuts,
    cutsRef,
    editedSegments,
    editedInById,
    editedDur,
    editorPhase,
    viewMode,
    viewModeRef,
    setViewMode,
    setSelectedId,
    previewSource,
    setPreviewSource,
    videoDuration,
    setVideoDuration,
    currentTimeRef,
    captionLinesRef,
    captionsOnOutputClock,
    isCutBlockEditingRef,
    getSourceDurationSec,
    getActiveDurationSec,
    viewport: { paintTime, followPlayhead, resumeFollow, revealPlayhead, timeAtClientX, pxPerSec },
    syncMusicAudio: syncMusicAudioLatest,
    setError,
    setErrorRetry
  })

  // The filmstrip half of the preparing gate. Bounded at 8s: past that the
  // in-lane pending wash takes over and the user edits while lanes fill in.
  useEffect(() => {
    if (!filmstripGateArmed || editorPhase === 'ready') return
    if (filmstrip.status === 'ready' || filmstrip.status === 'error' || filmstrip.total === 0) {
      setEditorPhase('ready')
      return
    }
    setPrepareHint(
      filmstrip.total > 1
        ? `กำลังเตรียมภาพตัวอย่างวิดีโอ… (${Math.min(filmstrip.done + 1, filmstrip.total)}/${filmstrip.total})`
        : 'กำลังเตรียมภาพตัวอย่างวิดีโอ…'
    )
    const cap = window.setTimeout(() => setEditorPhase('ready'), 8000)
    return () => window.clearTimeout(cap)
  }, [filmstripGateArmed, editorPhase, filmstrip.status, filmstrip.done, filmstrip.total])

  useEffect(() => {
    let cancelled = false
    setEditorPhase('loading')
    setFilmstripGateArmed(false)
    setPrepareHint('')
    setError(null)
    setPreviewSrc(null)
    setPreviewSource(null)
    editorApi
      .getEditTimeline(uid)
      .then(async (t) => {
        if (cancelled) return
        setTimeline(t)
        const loaded: EditorSnapshot = {
          cuts: normalizeDubCuts(t.cuts),
          captionLines: initialCaptionEdits() ?? null,
          captionStyle: initialCaptionStyle() ?? null,
          music: initialMusic() ?? null
        }
        // Resume this session's undo history when the editor reopens on the
        // very state it was left in. The history's cut ids win: the content
        // is identical, and the stacks refer to cuts by those ids.
        const resumed = resume(loaded)
        // New cuts are named new1, new2, …; carry on past any the resumed
        // history already holds, or one id could name two cuts.
        newCutCounter.current = resumed ? highestNewCutNumber(resumed) : 0
        const startCuts = resumed ? resumed.at.cuts : loaded.cuts
        writeCuts(startCuts)
        setCaptionEdits(loaded.captionLines)
        captionEditsRef.current = loaded.captionLines
        setCaptionStyle(loaded.captionStyle)
        setMusic(loaded.music)
        setEditorPhase('preparing')
        if (cancelled) return
        const firstCut = startCuts[0]
        if (firstCut) {
          setSelectedId(firstCut.id)
          editedActiveCutIdRef.current = firstCut.id
          playRangeRef.current = { in: firstCut.in, out: firstCut.out }
          setPrepareHint('กำลังโหลดตัวอย่างเล่น…')
          await loadPreviewFor(firstCut.source)
        }
        // The thumbnail lanes gate the door, bounded: a lane-less editor reads
        // as broken ("thumbnail ตรง timeline มันไม่แสดงเลย", owner 2026-09-09),
        // so the preparing screen holds until the strips are in hand — but a
        // COLD first extraction of a long source is tens of seconds of work,
        // and locking someone out of the editor for thumbnails is the worse
        // trade past a point. The separate effect below flips to 'ready' when
        // the strips land, on failure, or after the wait cap — and a warm
        // reopen (cached manifests) passes through in one frame.
        if (!cancelled) setFilmstripGateArmed(true)
      })
      .catch((e) => {
        if (!cancelled) {
          setError(formatUserError(e))
          setEditorPhase('ready')
        }
      })
    return () => {
      cancelled = true
    }
  }, [uid])

  // Repaint on every caption edit so the overlay shows the text being typed.
  useEffect(() => {
    captionLinesRef.current = captionLines
    syncCaptionOverlay()
  }, [captionLines])

  // Decode the attached music file client-side into a peak array for the
  // waveform canvas (shared with the wizard's MusicRangePicker).
  useEffect(() => {
    if (!music?.path) {
      setMusicPeaks(null)
      setMusicDurationSec(0)
      return
    }
    let cancelled = false
    const src = window.noey.media.urlFor(uid, music.path)
    void decodeAudioPeaks(src)
      .then(({ peaks, durationSec }) => {
        if (cancelled) return
        setMusicPeaks(peaks)
        setMusicDurationSec(durationSec)
      })
      .catch(async (err: unknown) => {
        void window.noey.log.write('TimelineEditor', `music waveform decode failed: ${String(err)}`)
        // No waveform, but the LENGTH still matters: the trim handles and their
        // clamps are built from it, and without one the track cannot be
        // trimmed at all. ffprobe reads containers Web Audio refuses.
        try {
          const abs = await window.noey.projects.resolvePath(uid, music.path)
          const probed = Number((await window.noey.sidecar.probe(abs)).duration)
          if (!cancelled && Number.isFinite(probed) && probed > 0) setMusicDurationSec(probed)
        } catch {
          // Leave it at 0 — the UI then offers no trim rather than a wrong one.
        }
      })
    return () => {
      cancelled = true
    }
  }, [music?.path, uid])

  const commitMusic = async (patch: MusicPatch): Promise<void> => {
    if (!music) return
    const next = { ...music, ...patch }
    if (sameMusic(next, music)) return
    // Before the change, and once per COMMITTED move: the audio track reports
    // a live draft while the block is being dragged and calls this only on
    // pointer-up, so one drag is one undo step.
    pushHistoryNow()
    setMusic(next)
    musicRef.current = next
    setMusicBusy(true)
    try {
      await editorApi.updateMusic(patch)
    } catch (err) {
      setError(formatUserError(err))
      setErrorRetry(null)
    } finally {
      setMusicBusy(false)
    }
  }

  // Seeks/starts/stops the hidden <audio> element to match the main preview's
  // timeline-domain position `t`.
  function syncMusicAudio(t: number, allowPlay: boolean): void {
    const a = musicAudioRef.current
    const em = effectiveMusic
    if (!a || !em || !em.path || viewModeRef.current !== 'edited') {
      if (a && !a.paused) a.pause()
      return
    }
    const trimIn = em.trimInSec
    const trimOut = em.trimOutSec ?? musicDurationSec
    const blockDur = Math.max(trimOut - trimIn, 0)
    const start = em.offsetSec
    const end = start + blockDur
    const inWindow = blockDur > 0 && !em.muted && t >= start && t < end
    if (!inWindow || !allowPlay) {
      if (!a.paused) a.pause()
      if (inWindow) {
        const target = trimIn + (t - start)
        if (Number.isFinite(target) && Math.abs(a.currentTime - target) > 0.05)
          a.currentTime = target
      }
      return
    }
    const target = trimIn + (t - start)
    if (Math.abs(a.currentTime - target) > 0.25) a.currentTime = target
    if (a.paused) void a.play().catch(() => undefined)
  }

  useEffect(() => {
    const a = musicAudioRef.current
    if (!a) return
    a.src = music?.path ? window.noey.media.urlFor(uid, music.path) : ''
    // editorPhase dep: the <audio> element only mounts once editorPhase becomes
    // 'ready' — see the pre-R3 editor's identical note.
  }, [music?.path, uid, editorPhase])

  useEffect(() => {
    const a = musicAudioRef.current
    if (!a || !effectiveMusic) return
    a.volume = effectiveMusic.muted ? 0 : effectiveMusic.volume
  }, [effectiveMusic?.volume, effectiveMusic?.muted, editorPhase])

  useEffect(() => {
    syncMusicAudio(currentTimeRef.current, isPlaying)
  }, [
    effectiveMusic?.offsetSec,
    effectiveMusic?.trimInSec,
    effectiveMusic?.trimOutSec,
    effectiveMusic?.muted,
    musicDurationSec,
    viewMode,
    editorPhase
  ])

  useEffect(() => {
    if (!isPlaying) syncMusicAudio(currentTimeRef.current, false)
  }, [isPlaying, editorPhase])

  const handlePickMusic = async (): Promise<void> => {
    const before = musicRef.current
    setMusicBusy(true)
    try {
      const next = await editorApi.pickMusic()
      // Pushed only once the picker actually returned something different —
      // cancelling the file dialog must not leave an empty step in the history.
      if (!sameMusic(next ?? null, before)) pushHistory(snapshotNow({ music: before }))
      setMusic(next ?? null)
      musicRef.current = next ?? null
    } catch (err) {
      setError(formatUserError(err))
      setErrorRetry(null)
    } finally {
      setMusicBusy(false)
    }
  }

  const handleRemoveMusic = async (): Promise<void> => {
    if (!musicRef.current) return
    pushHistoryNow()
    setMusicBusy(true)
    try {
      await editorApi.removeMusic()
      setMusic(null)
      musicRef.current = null
      setMusicPeaks(null)
    } catch (err) {
      setError(formatUserError(err))
      setErrorRetry(null)
    } finally {
      setMusicBusy(false)
    }
  }

  function deleteSelectedCut() {
    if (selectedId) deleteCut(selectedId)
  }

  // ---- edits ---------------------------------------------------------------

  /**
   * The ONE writer of the cut list. `cutsRef` moves in the same call, so a
   * handler that runs before the next render — the next drag frame, a
   * shortcut, the history push of the edit itself — reads the list as it is
   * now. It used to be mirrored by an effect a commit later, and the edits
   * worked around that lag by reading `prev` inside setCuts updaters, which
   * put their history pushes in render (twice under StrictMode). A second
   * writer brings the lag back, and a mirror effect could write an older list
   * over a newer one.
   */
  function writeCuts(next: WorkingCut[]): void {
    cutsRef.current = next
    setCuts(next)
  }

  /**
   * One cut edit, one undo step — pushed here, by the handler that made the
   * edit. `edit` gets the current list and returns the new one, or null (or
   * the same list) when there is nothing to do, which records nothing.
   */
  function editCuts(edit: (prev: WorkingCut[]) => WorkingCut[] | null): WorkingCut[] | null {
    const prev = cutsRef.current
    const next = edit(prev)
    if (!next || next === prev) return null
    pushHistory(snapshotNow({ cuts: prev }))
    writeCuts(next)
    return next
  }

  /** A live edit from a drag frame — no history of its own: the drag is
   * bracketed by beginCutBlockEdit/commitCutBlockEdit and recorded once. */
  function updateCut(id: string, patch: Partial<WorkingCut>) {
    writeCuts(cutsRef.current.map((c) => (c.id === id ? { ...c, ...patch } : c)))
  }

  /**
   * A trim drag on the edited lane: apply the new edge, keep the preview on
   * the frame at that edge, and — for the LEFT edge — keep the edge under the
   * pointer.
   *
   * Blocks sit in a row that starts at 0, so a block's left edge is fixed by
   * the cuts before it: lowering `in` grows the block to the RIGHT and slides
   * its thumbnails along — dragging the left handle backwards looked like the
   * shot moving forward (live report 2026-09-21). Scrolling the lane by the
   * same amount the block grew moves everything before the block left instead,
   * so the handle follows the pointer and the block's right edge and every cut
   * after it stay put — the way CapCut trims a clip's head.
   */
  function trimCut(cut: WorkingCut, edge: TrimEdge, patch: Partial<WorkingCut>, prevIn: number) {
    updateCut(cut.id, patch)
    // Source-view blocks sit at their source time: nothing before them moves.
    if (viewModeRef.current === 'edited' && edge === 'left' && patch.in !== undefined) {
      queueScrollShift((prevIn - patch.in) * pxPerSec)
    }
    // The preview shows the edge being trimmed — loading the scene's file if
    // another is on screen; in the edited view a click does not load it
    // (selectCut). A hair
    // inside the out-point so the frame shown is one that stays.
    const now = cutsRef.current.find((c) => c.id === cut.id) ?? { ...cut, ...patch }
    showCutFrame(
      now,
      edge === 'left' ? (patch.in ?? cut.in) : Math.max((patch.out ?? cut.out) - 0.04, 0)
    )
  }

  function deleteCut(id: string) {
    editCuts((prev) => (prev.some((c) => c.id === id) ? prev.filter((c) => c.id !== id) : null))
    if (selectedId === id) setSelectedId(null)
  }

  function addCut(
    sourceId: string,
    atSec: number,
    durationSec: number,
    opts?: { insertAtPlayhead?: boolean; afterCutId?: string }
  ) {
    const start = clamp(atSec, 0, Math.max(durationSec, 0))
    const end = clamp(start + DEFAULT_NEW_CUT_SEC, start + MIN_CUT_SEC, durationSec)
    newCutCounter.current += 1
    const cutId = `new${newCutCounter.current}`
    const added = editCuts((prev) =>
      withNewScene(prev, {
        id: cutId,
        source: sourceId,
        start,
        end,
        isDub,
        atPlayhead: opts?.insertAtPlayhead ?? false,
        afterCutId: opts?.afterCutId
      })
    )
    // The scene you just added is the one you edit next — as in any editor
    // (owner, 2026-09-22). Selection only: the playhead stays where it is.
    if (added) setSelectedId(cutId)
  }

  function addMontageCut() {
    if (!selectedCut || !isDub || !timeline) return
    const lineId = cutLineId(selectedCut)
    const srcDur = timeline.sources.find((s) => s.id === selectedCut.source)?.durationSec ?? 60
    const start = clamp(selectedCut.out, 0, Math.max(srcDur - MIN_CUT_SEC, 0))
    const end = clamp(start + DEFAULT_NEW_CUT_SEC, start + MIN_CUT_SEC, srcDur)
    newCutCounter.current += 1
    const cutId = `new${newCutCounter.current}`
    const added = editCuts((prev) =>
      withNewAngle(prev, { id: cutId, source: selectedCut.source, lineId, start, end })
    )
    // Selected, like a new scene — see addCut.
    if (added) setSelectedId(cutId)
  }

  function addSceneAtPlayhead() {
    if (!timeline) return
    // In edited mode the playhead is an output position — the new scene starts
    // at the SOURCE position under the playhead, in that scene's file, and
    // plays right after that scene: the list's order is the timeline there, and
    // placing it by source time put it wherever that time fell in an AI-ordered
    // cut — often first (bug hunt #31).
    const seg = viewMode === 'edited' ? findEditedSegment(cuts, currentTimeRef.current) : null
    const sourceId = seg?.cut.source ?? previewSource ?? timeline.sources[0]?.id
    if (!sourceId) return
    const dur = getSourceDurationSec(sourceId)
    let atSrc = currentTimeRef.current
    if (viewMode === 'edited') {
      atSrc = seg ? seg.cut.in + (currentTimeRef.current - seg.editedIn) : 0
    }
    addCut(sourceId, clamp(atSrc, 0, Math.max(dur - MIN_CUT_SEC, 0)), dur, {
      insertAtPlayhead: true,
      afterCutId: seg?.cut.id
    })
  }

  /** แยกที่หัวเล่น (S) — split the scene under the playhead into two. */
  function splitAtPlayhead() {
    const t = currentTimeRef.current
    const list = cutsRef.current
    let cutId: string | null = null
    let atSrc = 0
    if (viewMode === 'edited') {
      const seg = findEditedSegment(list, t)
      if (!seg) return
      cutId = seg.cut.id
      atSrc = seg.cut.in + (t - seg.editedIn)
    } else {
      const c = findSourceCutAtTime(list, previewSource, t)
      if (!c) return
      cutId = c.id
      atSrc = t
    }
    newCutCounter.current += 1
    const newId = `new${newCutCounter.current}`
    editCuts((prev) => splitCutAt(prev, cutId, atSrc, newId))
  }

  /** ทำซ้ำ — duplicate the selected scene right after itself. */
  function duplicateSelectedCut() {
    if (!selectedCut) return
    newCutCounter.current += 1
    const cutId = `new${newCutCounter.current}`
    editCuts((prev) => withDuplicate(prev, selectedCut.id, cutId, isDub))
  }

  /** ตั้งจุดเข้า/จุดออก ([ / ]) — trim the selected cut to the playhead. */
  function setPointAtPlayhead(edge: TrimEdge) {
    if (!selectedCut) return
    const t = currentTimeRef.current
    let atSrc: number
    let minIn = 0
    let maxOut = getSourceDurationSec(selectedCut.source)
    if (viewMode === 'edited') {
      const seg = computeEditedSegments(cuts).find((s) => s.cut.id === selectedCut.id)
      if (!seg || t < seg.editedIn - 0.001 || t > seg.editedOut + 0.001) return
      atSrc = selectedCut.in + (t - seg.editedIn)
    } else {
      // The source view's clock belongs to the file on screen: a time from
      // another file means nothing for this scene. And the scene may not grow
      // over its lane neighbours — the drag-trim stops at them too (bug hunt
      // #12: ] stretched a 2–4 s scene to 30 s from another clip's lane).
      if (selectedCut.source !== previewSource) return
      atSrc = t
      const lane = cuts.filter((c) => c.source === selectedCut.source)
      ;({ minIn, maxOut } = sourceNeighborBounds(selectedCut, lane, maxOut))
    }
    if (edge === 'left') {
      if (atSrc > selectedCut.out - MIN_CUT_SEC) return
      const nextIn = Math.max(atSrc, minIn)
      editCuts((prev) => prev.map((c) => (c.id === selectedCut.id ? { ...c, in: nextIn } : c)))
    } else {
      if (atSrc < selectedCut.in + MIN_CUT_SEC) return
      const nextOut = Math.min(atSrc, maxOut)
      editCuts((prev) => prev.map((c) => (c.id === selectedCut.id ? { ...c, out: nextOut } : c)))
    }
  }

  /** Typing a line's script — recorded once per focus by beginEdit/commitEdit. */
  function updateLineScript(lineId: number, script: string) {
    const prev = cutsRef.current
    const firstId = prev.find((c) => cutLineId(c) === lineId)?.id
    if (!firstId) return
    writeCuts(
      prev.map((c) => {
        if (cutLineId(c) !== lineId) return c
        if (c.id === firstId) return { ...c, voiceoverScript: script }
        return { ...c, voiceoverScript: '' }
      })
    )
  }

  function handleSequenceDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    // Not a plain arrayMove: that could pull one angle away from its
    // voiceover line, or drop a scene between another line's angles — see
    // withReorder.
    editCuts((prev) => withReorder(prev, String(active.id), String(over.id), isDub))
  }

  function writeCaptionEdits(next: CaptionLine[]): void {
    captionEditsRef.current = next
    setCaptionEdits(next)
  }

  /** The line on screen named `id` — the ref, not this render's memo, since a
   * drag calls this once per frame from outside render. */
  function shownCaptionLine(id: string): CaptionLine | undefined {
    return (
      captionLinesRef.current?.find((l) => l.id === id) ??
      captionEditsRef.current?.find((l) => l.id === id && !l.deleted)
    )
  }

  /** Change a line on screen. Returns the id it goes by from now on: a
   * derived line becomes an edit, with its own id, the first time it is
   * touched. */
  function updateCaptionLine(id: string, patch: Partial<CaptionLine>): string {
    const edits = captionEditsRef.current
    const shown = shownCaptionLine(id)
    if (!edits || !shown) return id
    const res = applyCaptionEdit(edits, shown, patch, cutsRef.current, newCaptionEditId)
    if (res.edits !== edits) writeCaptionEdits(res.edits)
    return res.id
  }

  function deleteCaptionLine(id: string): void {
    const edits = captionEditsRef.current
    const shown = shownCaptionLine(id)
    if (!edits || !shown) return
    pushHistoryNow()
    writeCaptionEdits(deleteCaptionEdit(edits, shown, cutsRef.current, newCaptionEditId))
  }

  const { saveDraftNow, draftSavedAt } = useDraftAutosave({
    editorPhase,
    saving,
    editCount,
    cuts,
    captionLines: captionEdits,
    isDub,
    cutsRef,
    captionLinesRef: captionEditsRef
  })

  /**
   * The one way out of the editor. Leaves at once and lets the draft finish
   * behind it: the pipeline that writes it outlives this screen. It used to
   * await that write first — over the network, with no busy state — so on a
   * slow server the back button did nothing for up to a minute ("แก้ไขแล้ว
   * มันกดกลับไปหน้าโปรเจกต์ไม่ได้", live report 2026-09-21).
   */
  function requestClose(): void {
    // Typing that never lost focus is still an open edit: record it, so the
    // history kept for this session has it as a step.
    settleEdit()
    void saveDraftNow()
    onClose()
  }

  async function handleSave() {
    if (cuts.length === 0) {
      setError('ต้องมีอย่างน้อย 1 ฉาก')
      setErrorRetry(null)
      return
    }
    setSaving(true)
    setError(null)
    setErrorRetry(null)
    try {
      const payload: EditCut[] = cutPayload(cuts, isDub)
      await editorApi.saveEditTimeline(uid, payload, captionEdits ?? undefined)
      onSaved()
      onClose()
    } catch (e) {
      setError(formatUserError(e))
      setErrorRetry('save')
    } finally {
      setSaving(false)
    }
  }

  function toggleAiLine(lineId: number) {
    setAiChecked((prev) => {
      const next = new Set(prev)
      if (next.has(lineId)) next.delete(lineId)
      else next.add(lineId)
      return next
    })
  }

  /**
   * Hand the re-edit to the app-level job store rather than awaiting it here:
   * closing the editor while the AI is thinking used to throw the answer away
   * (and hide the fact that anything was running). `fxResult` below applies it
   * whenever the editor is on screen again.
   */
  function handleAiReedit(): void {
    if (!aiInstruction.trim()) return
    setLocalAiError(null)
    fxJobs.clearError(uid)
    const payload: EditCut[] = aiReeditPayload(cuts)
    const selectedLineIds = Array.from(aiChecked)
    const instruction = aiInstruction.trim()
    void fxJobs.run(uid, 'reedit', 'AI กำลังแก้การตัด', () =>
      editorApi.requestAiReedit(uid, payload, selectedLineIds, instruction)
    )
    setAiChecked(new Set())
    setAiInstruction('')
    setAiPanelOpen(false)
  }

  const fxJob = fxJobs.jobFor(uid)
  const fxResult = fxJobs.resultFor(uid)
  const aiBusy = fxJob?.kind === 'reedit'
  const aiError = localAiError ?? fxJobs.errorFor(uid) ?? null
  useEffect(() => {
    if (!fxResult || fxResult.kind !== 'reedit') return
    // Deferred: applying the answer is a fresh update, not part of this commit.
    const t = window.setTimeout(() => {
      pushHistory(snapshotNow())
      writeCuts(fxResult.value as EditCut[])
      setSelectedId(null)
      fxJobs.clearResult(uid)
    }, 0)
    return () => window.clearTimeout(t)
  }, [fxResult, fxJobs, uid])

  const canAiReedit = canUseAiReedit && isDub && timeline?.editTarget === 'edit_script'
  const selectedCut = cuts.find((c) => c.id === selectedId) ?? null
  // What the inspector's header shows of the selected scene — its source and
  // range. Typing its line's script replaces the cut object without changing
  // either, and must not redraw the header on every keystroke.
  const headerCut = useMemo(
    () => selectedCut,
    [selectedCut?.id, selectedCut?.source, selectedCut?.in, selectedCut?.out]
  )

  // ---- keyboard ------------------------------------------------------------

  function onKeyDown(e: KeyboardEvent) {
    // Already handled — a block picked up with Enter moves on the arrows and
    // drops on Esc, and neither may also nudge the playhead or close the editor.
    if (e.defaultPrevented) return
    if (e.code === 'Escape') {
      // In a text, number or timecode field Esc belongs to the field: it
      // leaves it (a timecode field reverts its draft itself, first). It used
      // to close the whole editor from the middle of a sentence.
      if (isTypingTarget(e.target)) {
        e.preventDefault()
        ;(e.target as HTMLElement).blur()
        return
      }
      if (shortcutsOpen) {
        e.preventDefault()
        setShortcutsOpen(false)
        return
      }
      if (editorPhase === 'ready') {
        e.preventDefault()
        void requestClose()
      }
      return
    }

    if (editorPhase !== 'ready' || !previewSrc) return
    if (isTypingTarget(e.target)) return

    const isQuestion = e.key === '?' || (e.code === 'Slash' && e.shiftKey)
    if (isQuestion && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      setShortcutsOpen((open) => !open)
      return
    }

    if (matchesShortcutParts(e, [{ type: 'key', code: 'Space' }])) {
      e.preventDefault()
      togglePlay()
      return
    }

    if (matchesShortcutParts(e, [{ type: 'mod' }, { type: 'key', code: 'KeyZ' }]) && !e.shiftKey) {
      e.preventDefault()
      undo()
      return
    }

    if (
      matchesShortcutParts(e, [{ type: 'mod' }, { type: 'key', code: 'KeyY' }]) ||
      matchesShortcutParts(e, [{ type: 'mod' }, { type: 'shift' }, { type: 'key', code: 'KeyZ' }])
    ) {
      e.preventDefault()
      redo()
      return
    }

    if (
      matchesShortcutParts(e, [{ type: 'key', code: 'Delete' }]) ||
      matchesShortcutParts(e, [{ type: 'key', code: 'Backspace' }])
    ) {
      e.preventDefault()
      deleteSelectedCut()
      return
    }

    if (matchesShortcutParts(e, [{ type: 'mod' }, { type: 'key', code: 'KeyS' }])) {
      e.preventDefault()
      if (!saving && cuts.length > 0) void handleSave()
      return
    }

    if (matchesShortcutParts(e, [{ type: 'key', code: 'KeyS' }])) {
      e.preventDefault()
      splitAtPlayhead()
      return
    }

    if (matchesShortcutParts(e, [{ type: 'key', code: 'KeyN' }])) {
      e.preventDefault()
      addSceneAtPlayhead()
      return
    }

    if (isDub && matchesShortcutParts(e, [{ type: 'key', code: 'KeyM' }])) {
      e.preventDefault()
      addMontageCut()
      return
    }

    if (matchesShortcutParts(e, [{ type: 'key', code: 'BracketLeft' }])) {
      e.preventDefault()
      setPointAtPlayhead('left')
      return
    }

    if (matchesShortcutParts(e, [{ type: 'key', code: 'BracketRight' }])) {
      e.preventDefault()
      setPointAtPlayhead('right')
      return
    }

    if (
      matchesShortcutParts(e, [{ type: 'mod' }, { type: 'key', code: 'Digit1' }]) ||
      matchesShortcutParts(e, [{ type: 'mod' }, { type: 'key', code: 'Numpad1' }])
    ) {
      e.preventDefault()
      switchViewMode('source')
      return
    }

    if (
      matchesShortcutParts(e, [{ type: 'mod' }, { type: 'key', code: 'Digit2' }]) ||
      matchesShortcutParts(e, [{ type: 'mod' }, { type: 'key', code: 'Numpad2' }])
    ) {
      e.preventDefault()
      switchViewMode('edited')
      return
    }

    if (matchesShortcutParts(e, [{ type: 'shift' }, { type: 'key', code: 'ArrowLeft' }])) {
      e.preventDefault()
      nudgePlayhead(-1)
      return
    }

    if (matchesShortcutParts(e, [{ type: 'shift' }, { type: 'key', code: 'ArrowRight' }])) {
      e.preventDefault()
      nudgePlayhead(1)
      return
    }

    if (matchesShortcutParts(e, [{ type: 'key', code: 'ArrowLeft' }])) {
      e.preventDefault()
      nudgePlayhead(-FRAME_SEC)
      return
    }

    if (matchesShortcutParts(e, [{ type: 'key', code: 'ArrowRight' }])) {
      e.preventDefault()
      nudgePlayhead(FRAME_SEC)
      return
    }

    if (matchesShortcutParts(e, [{ type: 'key', code: 'Home' }])) {
      e.preventDefault()
      applyScrubTime(0, true)
      return
    }

    if (matchesShortcutParts(e, [{ type: 'key', code: 'End' }])) {
      e.preventDefault()
      applyScrubTime(getActiveDurationSec(), true)
    }
  }
  useWindowKeydown(onKeyDown)

  // ---- derived render values ----------------------------------------------

  const axisDur = viewMode === 'edited' ? editedDur : getSourceAxisDurationSec()
  const contentW = getContentWidthPx()
  boundariesRef.current = captionSnapBoundaries
  const captionCursorIdx = captionLines
    ? clamp(captionCursor, 0, Math.max(captionLines.length - 1, 0))
    : 0
  const cursorLine = captionLines?.[captionCursorIdx]
  const showTabs = isDub
  const activeInspectorTab = showTabs ? inspectorTab : 'caption'

  // "ท่อนที่ตรงกับฉากนี้" has to mean it: selecting a scene moves the caption
  // cursor onto the first line inside that scene, if there is one. Typing in
  // the box must not yank the cursor, so this only reacts to the selection.
  useEffect(() => {
    if (!captionLines || captionLines.length === 0 || !selectedCut) return
    const seg = computeEditedSegments(cuts).find((x) => x.cut.id === selectedCut.id)
    const [winIn, winOut] = captionsOnOutputClock
      ? [seg?.editedIn ?? 0, seg?.editedOut ?? 0]
      : [selectedCut.in, selectedCut.out]
    const idx = captionLines.findIndex((l) => l.end > winIn + 0.01 && l.start < winOut - 0.01)
    if (idx >= 0) setCaptionCursor(idx)
  }, [selectedId])

  function jumpToCaption(idx: number) {
    if (!captionLines || captionLines.length === 0) return
    const next = clamp(idx, 0, captionLines.length - 1)
    setCaptionCursor(next)
    const line = captionLines[next]
    if (captionsOnOutputClock) {
      // Already an output time — only the source view needs a conversion, and
      // there is none to make (a line can span scenes there), so stay put.
      if (viewMode === 'edited') applyScrubTime(line.start + 0.01, true)
    } else if (viewMode === 'edited') {
      const mapped = mapSourceTimeToOutput(cuts, line.start + 0.01)
      if (mapped !== null) applyScrubTime(mapped, true)
    } else {
      applyScrubTime(line.start, true)
    }
  }

  /**
   * "ส่งออก .srt" (R7): the lines as they are RIGHT NOW, not the ones the last
   * render burned in. Written into the project dir first so the existing
   * export-file dialog can copy it out — no new main-process surface needed.
   */
  async function exportSrt(): Promise<void> {
    if (!captionLines || captionLines.length === 0) return
    setSrtBusy(true)
    setSrtNote(null)
    try {
      const text = captionLinesToSrt(captionLines)
      const rel = 'captions/subtitles_edit.srt'
      await window.noey.projects.writeFile(uid, rel, new TextEncoder().encode(text))
      const dest = await window.noey.projects.exportFile(uid, rel, 'subtitles.srt')
      setSrtNote(dest ? `บันทึกไว้ที่ ${dest}` : null)
    } catch (e) {
      setSrtNote(formatUserError(e))
    } finally {
      setSrtBusy(false)
    }
  }

  /** Retime a caption by dragging one of its edges on the คำบรรยาย track. */
  function dragCaption(chip: CaptionChipSpan, edge: TrimEdge, e: React.PointerEvent): void {
    e.stopPropagation()
    e.preventDefault()
    const line = captionLines?.find((l) => l.id === chip.id)
    if (!line) return
    // The first move turns a derived line into an edit with its own id; every
    // later frame has to address that one.
    let targetId = chip.id
    const startX = e.clientX
    const from = { start: line.start, end: line.end }
    beginEdit()
    // One update per frame, the newest pointer position winning — see
    // bindTrimDrag. Each update renders the editor.
    let lastX = startX
    let frame = 0
    const apply = (): void => {
      frame = 0
      const deltaSec = (lastX - startX) / pxPerSecRef.current
      const patch = dragCaptionEdge(from, chip, edge, deltaSec)
      // A caption that spills a few frames past a cut reads as a mistake in the
      // finished clip, and hitting the boundary by hand is fiddly — pull the
      // dragged edge onto the nearest scene boundary within ~10px.
      // Snap the edge BEING DRAGGED — dragCaptionEdge always returns both
      // fields, so which one moved has to come from `edge`, not from an
      // undefined check.
      const tol = 10 / Math.max(pxPerSecRef.current, 1)
      const snapped = snapCaptionEdge(patch, edge, boundariesRef.current, tol)
      targetId = updateCaptionLine(targetId, snapped)
    }
    const onMove = (ev: PointerEvent): void => {
      lastX = ev.clientX
      if (!frame) frame = window.requestAnimationFrame(apply)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      // Land the last position before the edit is committed to history.
      if (frame) {
        window.cancelAnimationFrame(frame)
        apply()
      }
      commitEdit()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  function copyErrorReport() {
    const report = `โปรเจกต์ ${uid} · ${new Date().toISOString()}\n${error ?? ''}`
    void navigator.clipboard?.writeText(report).catch(() => undefined)
  }

  // ---- stable handlers ------------------------------------------------------
  // The parts rendered below are memo()'d: each skips a render only when every
  // prop is the same as last time. So each function it gets is a
  // useStableCallback wrapper — one identity for the editor's life, calling
  // this render's handler — or a state setter; a plain closure here would be
  // new on every render and render every part on every render.

  const onBack = useStableCallback(requestClose)
  const onUndo = useStableCallback(undo)
  const onRedo = useStableCallback(redo)
  const onSave = useStableCallback(handleSave)
  const openShortcuts = useStableCallback(() => setShortcutsOpen(true))
  const closeShortcuts = useStableCallback(() => setShortcutsOpen(false))
  const openAiPanel = useStableCallback(() => setAiPanelOpen(true))
  const closeAiPanel = useStableCallback(() => {
    if (!aiBusy) setAiPanelOpen(false)
  })
  const onToggleAiLine = useStableCallback(toggleAiLine)
  const onSubmitAiReedit = useStableCallback(handleAiReedit)
  const openCaptionStyle = useStableCallback(() => setCaptionStyleOpen(true))
  const closeCaptionStyle = useStableCallback(() => setCaptionStyleOpen(false))
  const changeCaptionStyle = useStableCallback((next: CaptionStyle) => {
    if (sameCaptionStyle(next, captionStyleRef.current)) return
    const now = performance.now()
    if (now - captionStyleStepAtRef.current > CAPTION_STYLE_BURST_MS) pushHistoryNow()
    captionStyleStepAtRef.current = now
    setCaptionStyle(next)
    captionStyleRef.current = next
    if (captionStyleWriteRef.current) window.clearTimeout(captionStyleWriteRef.current.timer)
    captionStyleWriteRef.current = {
      style: next,
      timer: window.setTimeout(flushCaptionStyleWrite, CAPTION_STYLE_BURST_MS)
    }
  })
  const onCopyError = useStableCallback(copyErrorReport)
  const dismissError = useStableCallback(() => {
    setError(null)
    setErrorRetry(null)
  })
  const skipPreparing = useStableCallback(() => setEditorPhase('ready'))

  // The preview. Both <video>s carry the same handlers, and only the one on
  // screen may move the clock: the hidden one is pre-seeking the next scene.
  const onTogglePlay = useStableCallback(togglePlay)
  const onSeek = useStableCallback((sec: number) => applyScrubTime(sec, true))
  const onScrubStart = useStableCallback(() => {
    isScrubbingSeekbarRef.current = true
    pauseForScrub()
  })
  const onScrubEnd = useStableCallback(() => {
    isScrubbingSeekbarRef.current = false
    resumeAfterScrub()
  })
  const onStepBack = useStableCallback(() => nudgePlayhead(-FRAME_SEC))
  const onStepForward = useStableCallback(() => nudgePlayhead(FRAME_SEC))
  const onVideoTimeUpdate = useStableCallback(
    (e: React.SyntheticEvent<HTMLVideoElement>) => isActiveVideoEvent(e) && onTimeUpdate()
  )
  const onVideoMetadata = useStableCallback(
    (e: React.SyntheticEvent<HTMLVideoElement>) => isActiveVideoEvent(e) && onVideoLoadedMetadata()
  )
  const onVideoSeeked = useStableCallback(
    (e: React.SyntheticEvent<HTMLVideoElement>) => isActiveVideoEvent(e) && syncTimeFromVideo()
  )
  const onVideoEnd = useStableCallback(
    (e: React.SyntheticEvent<HTMLVideoElement>) => isActiveVideoEvent(e) && onVideoEnded()
  )
  const onVideoPlay = useStableCallback(
    (e: React.SyntheticEvent<HTMLVideoElement>) => isActiveVideoEvent(e) && setIsPlaying(true)
  )
  const onVideoPause = useStableCallback(
    (e: React.SyntheticEvent<HTMLVideoElement>) => isActiveVideoEvent(e) && onVideoPaused()
  )
  const videoEvents: PreviewVideoEvents = useMemo(
    () => ({
      onClick: onTogglePlay,
      onTimeUpdate: onVideoTimeUpdate,
      onLoadedMetadata: onVideoMetadata,
      onSeeked: onVideoSeeked,
      onEnded: onVideoEnd,
      onPlay: onVideoPlay,
      onPause: onVideoPause
    }),
    [
      onTogglePlay,
      onVideoTimeUpdate,
      onVideoMetadata,
      onVideoSeeked,
      onVideoEnd,
      onVideoPlay,
      onVideoPause
    ]
  )

  // The inspector.
  const onBeginEdit = useStableCallback(beginEdit)
  const onCommitEdit = useStableCallback(commitEdit)
  const onSelectCut = useStableCallback((cut: WorkingCut) => void selectCut(cut))
  const onScriptChange = useStableCallback(updateLineScript)
  const onAddAngle = useStableCallback(addMontageCut)
  const onUpdateCaptionLine = useStableCallback(updateCaptionLine)
  const onDeleteCaptionLine = useStableCallback((id: string) => {
    deleteCaptionLine(id)
    setCaptionCursor((i) => Math.max(0, i - 1))
  })
  const onJumpToCaption = useStableCallback(jumpToCaption)
  const onExportSrt = useStableCallback(exportSrt)
  const onSplit = useStableCallback(splitAtPlayhead)
  const onDuplicate = useStableCallback(duplicateSelectedCut)
  const onDeleteSelected = useStableCallback(deleteSelectedCut)

  // The timeline.
  const onSwitchView = useStableCallback(switchViewMode)
  const onAddScene = useStableCallback(addSceneAtPlayhead)
  const onToggleSnap = useStableCallback(() => setSnapToBeatEnabled((v) => !v))
  const onFit = useStableCallback(fitToScreen)
  const onRulerDown = useStableCallback(onRulerPointerDown)
  const onLaneDown = useStableCallback(onLaneBackgroundPointerDown)
  const onSourceLaneDown = useStableCallback(onSourceLanePointerDown)
  const onUpdateCut = useStableCallback(updateCut)
  const onTrimCut = useStableCallback(trimCut)
  const onBlockEditStart = useStableCallback(beginCutBlockEdit)
  const onBlockEditEnd = useStableCallback(commitCutBlockEdit)
  const onReorder = useStableCallback(handleSequenceDragEnd)
  // Read when a trim starts, not passed down: as props these rendered every
  // block whenever the music moved.
  const getSnapContext = useStableCallback((): TrimSnapContext => ({
    beatsSec: effectiveMusic?.beats ?? null,
    snapEnabled: snapToBeatEnabled,
    musicOffsetSec: effectiveMusic?.offsetSec ?? 0,
    musicTrimInSec: effectiveMusic?.trimInSec ?? 0
  }))
  const onPickVoiceoverLine = useStableCallback((firstCutId: string) => {
    const first = cuts.find((c) => c.id === firstCutId)
    if (first) void selectCut(first)
    setInspectorTab('script')
  })
  const onCommitMusic = useStableCallback((patch: MusicPatch) => void commitMusic(patch))
  const onPickMusic = useStableCallback(() => void handlePickMusic())
  const onRemoveMusic = useStableCallback(() => void handleRemoveMusic())
  const onDragCaptionEdge = useStableCallback(dragCaption)
  const onPickCaptionChip = useStableCallback((idx: number) => {
    setInspectorTab('caption')
    jumpToCaption(idx)
  })

  return (
    <TimelineViewportContext.Provider value={viewportStore}>
      <div
        className="fixed inset-0 z-100 flex flex-col bg-ground text-ink"
        onMouseDownCapture={keepFocusOffControls}
      >
        <EditorHeader
          projectName={projectName}
          isDub={isDub}
          draftSavedAt={draftSavedAt}
          editCount={editCount}
          canAiReedit={canAiReedit}
          saving={saving}
          cutCount={cuts.length}
          ready={editorPhase === 'ready'}
          canUndo={canUndo}
          canRedo={canRedo}
          onBack={onBack}
          onUndo={onUndo}
          onRedo={onRedo}
          onOpenShortcuts={openShortcuts}
          onOpenAi={openAiPanel}
          onSave={onSave}
        />

        {shortcutsOpen && <ShortcutsSheet isDub={isDub} onClose={closeShortcuts} />}

        {captionStyleOpen && captionStyle && (
          <CaptionStyleDialog
            style={captionStyle}
            onChange={changeCaptionStyle}
            onClose={closeCaptionStyle}
          />
        )}

        {aiPanelOpen && (
          <AiReeditDialog
            lines={aiLines}
            checked={aiChecked}
            onToggle={onToggleAiLine}
            instruction={aiInstruction}
            onInstructionChange={setAiInstruction}
            busy={aiBusy}
            errorMsg={aiError}
            onSubmit={onSubmitAiReedit}
            onClose={closeAiPanel}
          />
        )}

        {error && (
          <ErrorBar
            error={error}
            saving={saving}
            canRetry={errorRetry === 'save'}
            onRetry={onSave}
            onCopy={onCopyError}
            onDismiss={dismissError}
          />
        )}

        {editorPhase !== 'ready' ? (
          <PreparingScreen
            prepareHint={prepareHint}
            canSkip={filmstripGateArmed}
            onSkip={skipPreparing}
          />
        ) : !timeline ? null : (
          <>
            {/* middle: stage (centre) + inspector (right) */}
            {/* Below `lg` the inspector goes under the stage instead of beside
                it: 360px of panel next to a 9:16 preview leaves the video a
                sliver. The whole middle scrolls as one column there. */}
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
              {/* A floor for the stage: stacked, the inspector's 210px minimum
                  took the rest and left the preview a ~94px sliver. */}
              <div className="flex min-h-[46dvh] min-w-0 flex-1 flex-col items-center justify-center gap-2 px-5 py-3 lg:min-h-0">
                <PreviewPane
                  videoARef={videoARef}
                  videoBRef={videoBRef}
                  captionOverlayRef={captionOverlayRef}
                  holdFrameRef={holdFrameRef}
                  musicAudioRef={musicAudioRef}
                  seekbarRef={seekbarRef}
                  timeLabelRef={timeLabelRef}
                  isPlaying={isPlaying}
                  durationSec={getActiveDurationSec()}
                  hasPreview={!!previewSrc}
                  videoEvents={videoEvents}
                  onTogglePlay={onTogglePlay}
                  onSeek={onSeek}
                  onScrubStart={onScrubStart}
                  onScrubEnd={onScrubEnd}
                  onStepBack={onStepBack}
                  onStepForward={onStepForward}
                />
              </div>

              {/* inspector — R3 right rail */}
              <aside className="flex min-h-[210px] w-full shrink-0 flex-col overflow-hidden border-t border-divider lg:max-h-none lg:min-h-0 lg:w-[360px] lg:border-l lg:border-t-0">
                <SelectedSceneHeader
                  selectedCut={headerCut}
                  playOrder={selectedCut ? playOrderMap.get(selectedCut.id) : undefined}
                  cutCount={cuts.length}
                />

                {showTabs && (
                  <Tabs
                    className="shrink-0 px-4"
                    items={[
                      { key: 'script', label: isHighlight ? 'โน้ตประกอบ' : 'บทพากย์' },
                      captionLines
                        ? { key: 'caption', label: 'คำบรรยายบนภาพ' }
                        : {
                            key: 'caption',
                            label: 'คำบรรยายบนภาพ',
                            disabled: true,
                            disabledReason: 'โปรเจกต์นี้ไม่ได้เปิดคำบรรยาย'
                          }
                    ]}
                    activeKey={activeInspectorTab}
                    onChange={(k) => setInspectorTab(k as 'script' | 'caption')}
                  />
                )}

                <div className="scroll-ghost min-h-0 flex-1 overflow-y-auto px-4 py-3">
                  {activeInspectorTab === 'script' && isDub ? (
                    <ScriptTab
                      selectedCut={selectedCut}
                      selectedId={selectedId}
                      isHighlight={isHighlight}
                      cuts={cuts}
                      strips={strips}
                      onScriptChange={onScriptChange}
                      onBeginEdit={onBeginEdit}
                      onCommitEdit={onCommitEdit}
                      onSelectCut={onSelectCut}
                      onAddAngle={onAddAngle}
                    />
                  ) : (
                    <CaptionTabBody
                      captionLines={captionLines}
                      captionCursorIdx={captionCursorIdx}
                      cursorLine={cursorLine}
                      captionStyle={captionStyle}
                      srtNote={srtNote}
                      onUpdateLine={onUpdateCaptionLine}
                      onBeginEdit={onBeginEdit}
                      onCommitEdit={onCommitEdit}
                      onDeleteLine={onDeleteCaptionLine}
                      onJump={onJumpToCaption}
                      onOpenStyle={openCaptionStyle}
                    />
                  )}
                </div>

                {activeInspectorTab === 'caption' && captionLines && captionLines.length > 0 && (
                  <CaptionFooter
                    lineCount={captionLines.length}
                    isDub={isDub}
                    srtBusy={srtBusy}
                    onExport={onExportSrt}
                  />
                )}

                <SceneActions
                  hasSelection={!!selectedCut}
                  onSplit={onSplit}
                  onDuplicate={onDuplicate}
                  onDelete={onDeleteSelected}
                />
              </aside>
            </div>

            {/* timeline — toolbar · ruler+tracks (one scroll container) · hint */}
            <div className="shrink-0 border-t border-divider">
              <TimelineToolbar
                viewMode={viewMode}
                thStats={thStats}
                hasSelection={!!selectedCut}
                snapToBeatEnabled={snapToBeatEnabled}
                pxPerSec={pxPerSec}
                hasMusic={!!music}
                beatCount={music?.beats?.length ?? 0}
                onSwitchView={onSwitchView}
                onSplit={onSplit}
                onAddScene={onAddScene}
                onDelete={onDeleteSelected}
                onToggleSnap={onToggleSnap}
                onZoom={setPxPerSec}
                onFit={onFit}
              />

              <div
                ref={viewportRef}
                onScroll={onViewportScroll}
                className="scroll-ghost relative max-h-[248px] overflow-auto select-none"
              >
                <div className="relative" style={{ width: HEADER_COL_PX + contentW }}>
                  {/* ruler */}
                  <div className="flex" style={{ height: RULER_PX }}>
                    <div
                      // Same stacking rule as trackLabelCls — this is the
                      // ruler's corner and the ruler ticks must scroll under it.
                      className="sticky left-0 z-40 h-full shrink-0 bg-ground"
                      style={{ width: HEADER_COL_PX }}
                    />
                    <TimelineRuler
                      durationSec={axisDur}
                      pxPerSec={pxPerSec}
                      widthPx={contentW}
                      onPointerDown={onRulerDown}
                    />
                  </div>

                  {viewMode === 'edited' ? (
                    <>
                      <ImageLane
                        cuts={cuts}
                        selectedId={selectedId}
                        playOrderMap={playOrderMap}
                        strips={strips}
                        filmstripPending={filmstrip.status === 'running'}
                        sourceDurationById={sourceDurationById}
                        pxPerSec={pxPerSec}
                        contentW={contentW}
                        editedInById={editedInById}
                        getSnapContext={getSnapContext}
                        onLaneBackgroundPointerDown={onLaneDown}
                        onSelectCut={onSelectCut}
                        onUpdateCut={onUpdateCut}
                        onTrimCut={onTrimCut}
                        onBlockEditStart={onBlockEditStart}
                        onBlockEditEnd={onBlockEditEnd}
                        onReorder={onReorder}
                      />
                      {isDub && (
                        <VoiceoverLane
                          voBlocks={voBlocks}
                          playingLineId={playingLineId}
                          selectedLineId={selectedCut ? cutLineId(selectedCut) : null}
                          pxPerSec={pxPerSec}
                          contentW={contentW}
                          onLaneBackgroundPointerDown={onLaneDown}
                          onPickLine={onPickVoiceoverLine}
                        />
                      )}
                      {canHaveMusic && (
                        <MusicLane
                          music={music}
                          musicPeaks={musicPeaks}
                          musicDurationSec={musicDurationSec}
                          musicBusy={musicBusy}
                          editedDur={editedDur}
                          outputCutBoundaries={outputCutBoundaries}
                          snapToBeatEnabled={snapToBeatEnabled}
                          pxPerSec={pxPerSec}
                          contentW={contentW}
                          onLaneBackgroundPointerDown={onLaneDown}
                          onCommitMusic={onCommitMusic}
                          onMusicDraft={setMusicDraft}
                          onPickMusic={onPickMusic}
                          onRemoveMusic={onRemoveMusic}
                        />
                      )}
                      {captionLines && captionLines.length > 0 && (
                        <CaptionLane
                          captionLines={captionLines}
                          capSpans={capSpans}
                          captionCursorIdx={captionCursorIdx}
                          pxPerSec={pxPerSec}
                          contentW={contentW}
                          onLaneBackgroundPointerDown={onLaneDown}
                          onDragEdge={onDragCaptionEdge}
                          onPickChip={onPickCaptionChip}
                        />
                      )}
                    </>
                  ) : (
                    /* source view (จ) — one lane per file under the shared axis */
                    <SourceLanes
                      sources={timeline.sources}
                      previewSource={previewSource}
                      strips={strips}
                      filmstripPending={filmstrip.status === 'running'}
                      cutsBySource={cutsBySource}
                      laneDurationById={laneDurationById}
                      playOrderMap={playOrderMap}
                      selectedId={selectedId}
                      pxPerSec={pxPerSec}
                      contentW={contentW}
                      onSourceLanePointerDown={onSourceLaneDown}
                      onSelectCut={onSelectCut}
                      onUpdateCut={onUpdateCut}
                      onTrimCut={onTrimCut}
                      onBlockEditStart={onBlockEditStart}
                      onBlockEditEnd={onBlockEditEnd}
                    />
                  )}

                  {/* Beat ticks sit BEHIND the lanes (z-0): they are a guide for
                    the eye, and painting them over a block's own artwork or
                    label makes both harder to read (HANDOFF §3). */}
                  {viewMode === 'edited' &&
                    snapToBeatEnabled &&
                    effectiveMusic?.beats &&
                    effectiveMusic.beats.length > 0 && (
                      <BeatTicks
                        beats={effectiveMusic.beats}
                        trimInSec={effectiveMusic.trimInSec}
                        offsetSec={effectiveMusic.offsetSec}
                        editedDur={editedDur}
                        pxPerSec={pxPerSec}
                      />
                    )}

                  <Playhead
                    playheadRef={playheadRef}
                    playheadLineRef={playheadLineRef}
                    onGrabPointerDown={onRulerDown}
                  />
                </div>
              </div>

              <p className="truncate px-4 py-1.5 text-[13px] text-muted">
                {viewMode === 'edited'
                  ? `ลากไม้บรรทัดเพื่อเลื่อนหัวเล่น · ลากขอบบล็อกเพื่อยืด–หดฉาก · ลากตัวบล็อกเพื่อสลับลำดับ · ลากขอบท่อนคำบรรยายเพื่อยืด–หดเวลา${
                      isDub && music ? ' · ลากปลายบล็อกเพลงเพื่อตัดต้น–ท้ายเพลง' : ''
                    } · Alt+ล้อ เพื่อซูม · Space เล่น/หยุด`
                  : 'ตัวเลขในบล็อกคือลำดับที่จะเล่นจริง · ช่วงที่ไม่มีบล็อกคือส่วนที่ไม่ถูกใช้ · ลากขอบเพื่อเปลี่ยนช่วงที่ตัดมาใช้'}
              </p>
            </div>
          </>
        )}
      </div>
    </TimelineViewportContext.Provider>
  )
})
