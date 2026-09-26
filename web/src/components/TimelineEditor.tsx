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
  cutsInLine,
  findEditedSegment,
  findSourceCutAtTime,
  fmtTimeTenths,
  isSkipped,
  lineScriptFor,
  mapSourceTimeToOutput,
  normalizeDubCuts,
  nudgeCutEdge,
  pasteCuts,
  removedSpanStats,
  rollCutBoundary,
  slipCut,
  snapCaptionEdge,
  cutBoundariesSec,
  sourceNeighborBounds,
  splitCutAt,
  voiceoverLineBlocks,
  withCutsRemoved,
  withDuplicate,
  withNewAngle,
  withNewScene,
  withRangeRemoved,
  withReorder,
  withReorderMany,
  withSceneMoved,
  withSkipToggled,
  type CaptionChipSpan,
  type TrimEdge
} from '../lib/timelineMath'
import { snapTolSec, type SnapHit, type SnapTarget } from '../lib/timelineSnap'
import { createModifierTracker, type ModifierTracker } from '../lib/modifierState'
import { decodeAudioPeaks } from '../lib/waveform'
import { TimelineViewportContext } from '../lib/timelineViewport'
import { useFilmstripStrips } from '../lib/useFilmstripStrips'
import { Tabs } from './ui/Tabs'
import type { MenuItemDef } from './ui/Menu'
import { useFxJobs } from '../lib/fxJobs'
import {
  highestNewCutNumber,
  sameCaptionStyle,
  sameCuts,
  sameMusic,
  type EditorSnapshot
} from '../lib/editorHistory'
import { useStableCallback } from '../lib/useStableCallback'
import { useToast } from '../lib/toast'
import { canUseAiReedit } from '../lib/platformFeatures'
import {
  FRAME_SEC,
  HEADER_COL_PX,
  NUDGE_FRAMES_BIG,
  RULER_PX,
  SCRUB_SNAP_THRESHOLD_PX
} from './timeline/constants'
import { nextBoundary } from './timeline/previewMath'
import { changedCutId, changedCutIds } from './timeline/sceneDiff'
import { TimelineRuler } from './timeline/TimelineRuler'
import type { SnapContext, WorkingCut } from './timeline/types'
import { aiReeditPayload, cutPayload } from './timeline/cutPayload'
import { buildOutputTargets, buildSourceTargets } from './timeline/snapTargets'
import {
  EMPTY_SELECTION,
  clearSelection,
  idsInOrder,
  keyBurstIsNewStep,
  pruneSelection,
  selectAll,
  selectClick,
  selectForward,
  selectMarquee,
  selectOnly,
  type SelectMods,
  type SelectionState
} from './timeline/selection'
import {
  addMarker,
  loadMarkers,
  moveMarker,
  nextMarkerSec,
  removeMarker,
  renameMarker,
  saveMarkers,
  type Marker
} from './timeline/markers'
import { useDraftAutosave } from './timeline/hooks/useDraftAutosave'
import { useEditorHistory } from './timeline/hooks/useEditorHistory'
import { useEditorShortcuts } from './timeline/hooks/useEditorShortcuts'
import { usePreviewPlayer } from './timeline/hooks/usePreviewPlayer'
import { useTimelineViewport } from './timeline/hooks/useTimelineViewport'
import { AiReeditDialog, type AiReeditLine } from './timeline/dialogs/AiReeditDialog'
import { CaptionStyleDialog } from './timeline/dialogs/CaptionStyleDialog'
import { ShortcutsSheet } from './timeline/dialogs/ShortcutsSheet'
import { BeatTicks } from './timeline/BeatTicks'
import { EditorHeader } from './timeline/EditorHeader'
import { ErrorBar } from './timeline/ErrorBar'
import { GuideLines, type GuideLinesHandle } from './timeline/GuideLines'
import { LiveRegion, type LiveRegionHandle } from './timeline/LiveRegion'
import { MarkerLayer } from './timeline/MarkerLayer'
import { Playhead } from './timeline/Playhead'
import { PreparingScreen } from './timeline/PreparingScreen'
import { PreviewPane, type PreviewVideoEvents } from './timeline/PreviewPane'
import { SceneContextMenu } from './timeline/SceneContextMenu'
import { TimelineToolbar } from './timeline/TimelineToolbar'
import { CaptionFooter, CaptionTabBody } from './timeline/inspector/CaptionTab'
import { SceneActions } from './timeline/inspector/SceneActions'
import { ScriptTab } from './timeline/inspector/ScriptTab'
import { SelectedSceneHeader } from './timeline/inspector/SelectedSceneHeader'
import { CaptionLane } from './timeline/lanes/CaptionLane'
import { ImageLane } from './timeline/lanes/ImageLane'
import { MusicLane } from './timeline/lanes/MusicLane'
import { SceneStrip } from './timeline/lanes/SceneStrip'
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
  /** Open ปรับช็อต for a scene (Enter). The shot-swap screen lives outside the
   * editor, so the key is only offered when the caller can act on it. */
  onOpenShotSwap?: (cutId: string) => void
}

/** Caption style steps closer together than this are one edit — see
 * changeCaptionStyle. */
const CAPTION_STYLE_BURST_MS = 400
/** Key presses closer together than this are one edit: Alt+← held down
 * fires dozens of nudges, and every editor records one undo step per burst. */
const KEY_BURST_MS = 400

/** Stable empty list — a fresh `[]` per render would restart the extraction. */
const EMPTY_FILMSTRIP_CLIPS: { id: string; file: string }[] = []
/** The snap and skim switches, remembered per browser. */
const SNAP_PREF_KEY = 'noey.timeline.snapEnabled'
const SKIM_PREF_KEY = 'noey.timeline.skim'

/** A remembered on/off switch, or `fallback` when nothing is stored (private
 * mode, cleared data, a first visit). */
function readPref(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key)
    return raw === null ? fallback : raw === '1'
  } catch {
    return fallback
  }
}

function writePref(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? '1' : '0')
  } catch {
    // Storage refused — the switch still works for this session.
  }
}

/** A scene's edited span on the output clock, from the memoized layout. */
function editedSpanOf(
  cut: WorkingCut,
  editedInById: Map<string, number>
): { inSec: number; outSec: number } | null {
  const start = editedInById.get(cut.id)
  if (start === undefined) return null
  return { inSec: start, outSec: start + Math.max(cut.out - cut.in, 0) }
}

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
  // The context menu keeps keyboard focus: ↑/↓ walk its items and Enter picks.
  if (
    target.closest(
      'input, textarea, select, [contenteditable="true"], [role="dialog"], [data-context-menu]'
    )
  )
    return
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
  onSaved,
  onOpenShotSwap
}: Props) {
  // AI re-edit runs at app level so leaving the editor doesn't kill it.
  const fxJobs = useFxJobs()
  // Every edit owes an answer on screen: a scene added off screen, an undo or
  // an AI re-edit all used to succeed in total silence.
  const { showToast } = useToast()
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
  // The selection: several scenes at once (selection.ts). `selectedId` is
  // its primary — what every single-scene reader (the inspector, ปรับช็อต,
  // Enter) keeps reading — and setSelectedId is the one-scene wrapper.
  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION)
  const selectedId = selection.primary
  const setSelectedId = (next: string | null | ((prev: string | null) => string | null)): void => {
    setSelection((prev) => {
      const id = typeof next === 'function' ? next(prev.primary) : next
      // Same single selection as before: hand back the same object so the
      // memoized lanes skip the render.
      if (id === prev.primary && prev.ids.length === (id ? 1 : 0)) return prev
      return id ? selectOnly(id) : clearSelection()
    })
  }
  const selectedIds = useMemo(() => new Set(selection.ids), [selection.ids])
  // A trim handle the user clicked or Tab-focused — what Alt+←/→ and E act on.
  const [focusedEdge, setFocusedEdge] = useState<{ cutId: string; edge: TrimEdge } | null>(null)
  // The scenes ⌘C took, in play order, with their meta stripped by pasteCuts.
  const clipboardRef = useRef<WorkingCut[]>([])
  // Right-click on a scene: the same actions as the inspector, at the pointer.
  const [contextMenu, setContextMenu] = useState<{
    cut: WorkingCut
    at: { x: number; y: number }
  } | null>(null)
  // The I/O range on the OUTPUT clock (edited view only): what Shift+Space
  // plays, what loop repeats, what Shift+Delete removes.
  const [range, setRange] = useState<{ inSec: number; outSec: number } | null>(null)
  const rangeRef = useRef<{ inSec: number; outSec: number } | null>(null)
  // Markers (P4 markers.ts) — a per-project note on the ruler, kept in
  // localStorage. NOT in the undo history on purpose: a marker is a bookmark,
  // not an edit, and เลิกทำ removing one after a trim would read as a bug.
  const [markers, setMarkers] = useState<Marker[]>([])
  const markersRef = useRef<Marker[]>([])
  // The phone layout: a storyboard strip instead of the lanes.
  const [layout, setLayout] = useState<'lanes' | 'strip'>('lanes')
  const layoutChosenRef = useRef(false)
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
  // ดูดขอบ — the magnet. On by default and remembered; every drag reads the
  // ref (drags outlive renders) and Alt held suppresses it for the drag.
  const [snapEnabled, setSnapEnabled] = useState(() => readPref(SNAP_PREF_KEY, true))
  const snapEnabledRef = useRef(snapEnabled)
  const modifierTrackerRef = useRef<ModifierTracker | null>(null)
  useEffect(() => {
    const tracker = createModifierTracker()
    modifierTrackerRef.current = tracker
    return () => {
      tracker.dispose()
      modifierTrackerRef.current = null
    }
  }, [])
  // The snap guide and skim line, painted imperatively (GuideLines).
  const guideRef = useRef<GuideLinesHandle | null>(null)
  // The aria-live channel every on-screen answer is also spoken through.
  const liveRegionRef = useRef<LiveRegionHandle | null>(null)
  // แกนพรีวิว — hover skim. Off on a touch screen (there is no hover).
  const [skimEnabled, setSkimEnabled] = useState(() => readPref(SKIM_PREF_KEY, true))
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
  useEffect(() => {
    snapEnabledRef.current = snapEnabled
    writePref(SNAP_PREF_KEY, snapEnabled)
  }, [snapEnabled])
  useEffect(() => {
    writePref(SKIM_PREF_KEY, skimEnabled)
  }, [skimEnabled])
  useEffect(() => {
    rangeRef.current = range
  }, [range])
  useEffect(() => {
    markersRef.current = markers
  }, [markers])
  // Markers live per project in localStorage: loaded when the editor opens on
  // a project, written on every change (see the state's comment).
  useEffect(() => {
    const loaded = loadMarkers(window.localStorage, uid)
    markersRef.current = loaded
    setMarkers(loaded)
  }, [uid])
  const markersLoadedRef = useRef(false)
  useEffect(() => {
    // The first run is the load itself, not a change.
    if (!markersLoadedRef.current) {
      markersLoadedRef.current = true
      return
    }
    saveMarkers(window.localStorage, uid, markers)
  }, [markers, uid])

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
  /** Scene boundaries on the output clock — what ↑/↓ jump between. */
  const outputCutBoundaries = useMemo(() => cutBoundariesSec(cuts), [cutRangesKey])
  // Mirrors of the memos above for the snap context: a drag frame runs from
  // a window listener bound at pointerdown, so it reads these, not a render.
  const voBlocksRef = useRef(voBlocks)
  const capSpansRef = useRef(capSpans)
  voBlocksRef.current = voBlocks
  capSpansRef.current = capSpans
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
  // For the snap context (see voBlocksRef). A live music drag reports a
  // draft; while one is on, the block's own edges are not targets — it would
  // snap back to where it started.
  const effectiveMusicRef = useRef(effectiveMusic)
  const musicDraggingRef = useRef(false)
  const musicDurationSecRef = useRef(musicDurationSec)
  effectiveMusicRef.current = effectiveMusic
  musicDraggingRef.current = musicDraft !== null
  musicDurationSecRef.current = musicDurationSec
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
    setSelection((prev) => pruneSelection(prev, new Set(next.cuts.map((c) => c.id))))
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
    undoLabel,
    redoLabel,
    editCount,
    resume
  } = useEditorHistory(uid, snapshotNow, applySnapshot)

  /**
   * One history step, with every scene it landed on selected, revealed and
   * flashed, and the step named in the toast ('เลิกทำ: แยกฉาก'). A step
   * replaces the whole cut list at once, so nothing in the call says what
   * moved — changedCutIds reads it off the two lists.
   *
   * Without this, เลิกทำ changed the cut under a still screen and an unchanged
   * selection, which reads exactly like a button that did nothing.
   */
  function historyStep(run: () => { label: string | null } | null, verb: 'เลิกทำ' | 'ทำซ้ำ'): void {
    const before = cutsRef.current
    const step = run()
    if (!step) return
    const after = cutsRef.current
    const landed = changedCutIds(before, after)
    if (landed.length > 0) {
      setSelection({ ids: landed, anchor: landed[0], primary: landed[0] })
      revealAndFlashCuts(landed)
    }
    announceEdit(
      null,
      step.label ? `${verb}: ${step.label}` : `${verb}แล้ว`,
      before.length === after.length ? undefined : sceneCountDetail()
    )
  }

  function undoWithFeedback(): void {
    if (!canUndo) return
    historyStep(undo, 'เลิกทำ')
  }

  function redoWithFeedback(): void {
    if (!canRedo) return
    historyStep(redo, 'ทำซ้ำ')
  }

  /** A drag on a scene block begins: one history step for the whole drag,
   * named for the undo button, and the playhead stops moving the selection. */
  const blockEditRef = useRef<{ label: string; cuts: WorkingCut[] } | null>(null)
  function beginCutBlockEdit(label = 'ยืด–หดฉาก') {
    isCutBlockEditingRef.current = true
    blockEditRef.current = { label, cuts: cutsRef.current }
    beginEdit(label)
  }

  /** The drag ended. The history records the step only if something
   * changed (commitEdit compares); the toast follows the same rule, so an
   * Escape mid-drag — the lane restores the start values first — says
   * nothing. */
  function commitCutBlockEdit() {
    isCutBlockEditingRef.current = false
    commitEdit()
    const started = blockEditRef.current
    blockEditRef.current = null
    if (started && !sameCuts(started.cuts, cutsRef.current)) {
      announceEdit(
        null,
        `${started.label}แล้ว`,
        `ยาวรวม ${fmtTimeTenths(computeEditedDuration(cutsRef.current))}`
      )
    }
  }

  // The touch-scrub model (a swipe on the phone timeline IS a scrub) is the
  // player's to run, but the viewport reports it — and the viewport is built
  // before the player. A stable wrapper calls the newest render's player.
  const onTouchScrub = useStableCallback((t: number) => playerTouchScrub(t))

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
    revealAndFlashCut,
    revealAndFlashCuts,
    onViewportScroll,
    timeAtClientX,
    fitToScreen,
    fitToggle,
    zoomAround,
    zoomToRange,
    dragScroll,
    coarse,
    touchScrub,
    leadPx,
    edgeHintRef,
    queueScrollShift
  } = useTimelineViewport({
    editorPhase,
    viewMode,
    cuts,
    videoDuration,
    currentTimeRef,
    getActiveDurationSec,
    getAxisDurationSec,
    onPaint,
    onTouchScrub
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
    jumpTo,
    goToCutStart,
    shuttleFaster,
    shuttleStop,
    shuttleBack,
    playbackRateRef,
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
    onVideoPaused,
    skimTo,
    setSkimEnabled: setPlayerSkimEnabled,
    playRange,
    playScene,
    playAround,
    isLooping,
    setLoop,
    beginTwoUp,
    paintTwoUp,
    endTwoUp,
    twoUp,
    twoUpIncoming,
    onTouchScrub: playerTouchScrub
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
    getScrubSnap,
    dragScroll,
    syncMusicAudio: syncMusicAudioLatest,
    setError,
    setErrorRetry
  })
  // The player owns the skimmer's guard; the switch lives here (toolbar).
  useEffect(() => {
    setPlayerSkimEnabled(skimEnabled && !coarse)
  }, [skimEnabled, coarse])
  // The I/O range is on the OUTPUT clock: it means nothing in the source view.
  useEffect(() => {
    if (viewMode !== 'edited') setRange(null)
  }, [viewMode])
  // The phone timeline opens on the storyboard strip (a lane a finger can
  // read); the toolbar toggle overrides it for the session.
  useEffect(() => {
    if (!layoutChosenRef.current) setLayout(touchScrub ? 'strip' : 'lanes')
  }, [touchScrub])
  // Clips are short: the whole cut on screen is the right first view.
  const fittedOnceRef = useRef(false)
  useEffect(() => {
    if (editorPhase !== 'ready' || fittedOnceRef.current) return
    fittedOnceRef.current = true
    fitToScreen()
  }, [editorPhase])

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
    pushHistoryNow('ปรับเพลง')
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
    // The J/K/L shuttle changes how fast the video plays; the music has to run
    // at the same speed or it drifts a second off within a few seconds.
    if (a.playbackRate !== playbackRateRef.current) a.playbackRate = playbackRateRef.current
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
      if (!sameMusic(next ?? null, before))
        pushHistory(snapshotNow({ music: before }), 'เปลี่ยนเพลง')
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
    pushHistoryNow('เอาเพลงออก')
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
    deleteCuts(selection.ids.length > 0 ? selection.ids : selectedId ? [selectedId] : [])
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

  /** Alt+← held down is one edit, not forty: the last key edit's kind and
   * time, so the next press knows whether to open a new step (selection.ts
   * keyBurstIsNewStep). Any other edit ends the burst. */
  const keyBurstRef = useRef<{ kind: string; at: number }>({ kind: '', at: 0 })

  /**
   * One cut edit, one undo step — pushed here, by the handler that made the
   * edit, under `label` (what เลิกทำ will call it). `edit` gets the current
   * list and returns the new one, or null (or the same list) when there is
   * nothing to do, which records nothing.
   */
  function editCuts(
    edit: (prev: WorkingCut[]) => WorkingCut[] | null,
    label: string
  ): WorkingCut[] | null {
    const prev = cutsRef.current
    const next = edit(prev)
    if (!next || next === prev) return null
    keyBurstRef.current = { kind: '', at: 0 }
    pushHistory(snapshotNow({ cuts: prev }), label)
    writeCuts(next)
    return next
  }

  /** editCuts for a key held down: presses within KEY_BURST_MS of the last
   * press of the same `kind` join its undo step instead of opening one. */
  function burstEditCuts(
    kind: string,
    edit: (prev: WorkingCut[]) => WorkingCut[] | null,
    label: string
  ): { next: WorkingCut[]; newStep: boolean } | null {
    const prev = cutsRef.current
    const next = edit(prev)
    if (!next || next === prev) return null
    const now = performance.now()
    const burst = keyBurstRef.current
    const newStep = burst.kind !== kind || keyBurstIsNewStep(burst.at, now, KEY_BURST_MS)
    if (newStep) pushHistory(snapshotNow({ cuts: prev }), label)
    keyBurstRef.current = { kind, at: now }
    writeCuts(next)
    return { next, newStep }
  }

  /**
   * The answer an edit owes the eye — and the ear: bring the scene it landed
   * on into view, flash its border, say in one line what happened, and speak
   * the same line through the aria-live region. `action` puts a button on
   * the toast (เลิกทำ on a delete or a move).
   *
   * เพิ่มฉาก, เพิ่มมุม, แยกฉาก, ทำซ้ำ, the AI re-edit and undo/redo all used to
   * succeed with the screen perfectly still — a scene added or changed outside
   * the scrolled view left nothing at all to see, so the only way to tell an
   * edit from a no-op was to go hunting for a block.
   */
  function announceEdit(
    cutId: string | null,
    text: string,
    detail?: string,
    action?: { label: string; run: () => void }
  ): void {
    if (cutId) revealAndFlashCut(cutId)
    showToast({ text, detail, actionLabel: action?.label, onAction: action?.run })
    liveRegionRef.current?.announce(detail ? `${text} ${detail}` : text)
  }

  /** The เลิกทำ button a destructive toast carries. Through the stable
   * wrapper, not this render's closure: the toast is pressed later, and
   * `canUndo` as it was BEFORE the edit was pushed would say no. */
  function undoAction(): { label: string; run: () => void } {
    return { label: 'เลิกทำ', run: () => onUndo() }
  }

  /** The scene count as it is NOW — the detail line a cut edit shows. */
  function sceneCountDetail(): string {
    return `ตอนนี้มี ${cutsRef.current.length} ฉาก`
  }

  /** A scene's play-order number as it is NOW, for a message. */
  function sceneNumber(id: string): number | null {
    const idx = cutsRef.current.findIndex((c) => c.id === id)
    return idx >= 0 ? idx + 1 : null
  }

  /** A live edit from a drag frame — no history of its own: the drag is
   * bracketed by beginCutBlockEdit/commitCutBlockEdit and recorded once. */
  function updateCut(id: string, patch: Partial<WorkingCut>) {
    writeCuts(cutsRef.current.map((c) => (c.id === id ? { ...c, ...patch } : c)))
  }

  /**
   * A trim drag on the edited lane: apply the new edge, keep the preview on
   * the frame at that edge, and — for the LEFT edge — keep the edge under the
   * pointer. The readout the block draws beside the handle is its own.
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
    // (selectCut). A hair inside the out-point so the frame shown is one that
    // stays.
    const now = cutsRef.current.find((c) => c.id === cut.id) ?? { ...cut, ...patch }
    showCutFrame(
      now,
      edge === 'left' ? (patch.in ?? cut.in) : Math.max((patch.out ?? cut.out) - 0.04, 0)
    )
  }

  /** How far a scene's edges may go: its file's length in the edited view;
   * its lane neighbours in the source view (a scene may not grow over the
   * scene next to it on the same file — bug hunt #12). `without` leaves a
   * roll partner out of the neighbour search, since it moves too. */
  function edgeBoundsFor(cut: WorkingCut, without?: string): { minIn: number; maxOut: number } {
    const dur = getSourceDurationSec(cut.source)
    if (viewModeRef.current === 'edited') return { minIn: 0, maxOut: dur }
    const lane = cutsRef.current.filter((c) => c.source === cut.source && c.id !== without)
    return sourceNeighborBounds(cut, lane, dur)
  }

  /** The two scenes a roll on `cutId`'s `edge` moves together, in play order,
   * or null at the ends of the sequence (the lane trims there instead). */
  function rollPair(cutId: string, edge: TrimEdge): { left: WorkingCut; right: WorkingCut } | null {
    const list = cutsRef.current
    const idx = list.findIndex((c) => c.id === cutId)
    if (idx < 0) return null
    const leftIdx = edge === 'right' ? idx : idx - 1
    if (leftIdx < 0 || leftIdx >= list.length - 1) return null
    return { left: list[leftIdx], right: list[leftIdx + 1] }
  }

  /**
   * ⌘/Ctrl+drag on a trim handle — a roll: the boundary between two scenes
   * moves and the total length does not ("give this beat to the other
   * shot"). Deltas are drag-relative, so every frame is computed from the
   * list captured on the first one; a delta of 0 (Escape) puts it back. The
   * preview shows both sides of the cut while it moves (two-up).
   */
  const rollRef = useRef<{
    startCuts: WorkingCut[]
    leftId: string
    rightId: string
    bounds: { leftMinIn: number; leftMaxOut: number; rightMinIn: number; rightMaxOut: number }
  } | null>(null)
  function rollBoundary(cutId: string, edge: TrimEdge, deltaSec: number): void {
    if (!rollRef.current) {
      const pair = rollPair(cutId, edge)
      if (!pair) return
      const lb = edgeBoundsFor(pair.left, pair.right.id)
      const rb = edgeBoundsFor(pair.right, pair.left.id)
      rollRef.current = {
        startCuts: cutsRef.current,
        leftId: pair.left.id,
        rightId: pair.right.id,
        bounds: {
          leftMinIn: lb.minIn,
          leftMaxOut: lb.maxOut,
          rightMinIn: rb.minIn,
          rightMaxOut: rb.maxOut
        }
      }
      beginCutBlockEdit('เลื่อนรอยตัด')
      // Outgoing (left) | incoming (right) in the preview while it moves.
      beginTwoUp(pair.right, pair.left)
    }
    const roll = rollRef.current
    const rolled = rollCutBoundary(roll.startCuts, roll.leftId, deltaSec, roll.bounds)
    const next = rolled ?? roll.startCuts
    if (next !== cutsRef.current) writeCuts(next)
    const left = next.find((c) => c.id === roll.leftId)
    const right = next.find((c) => c.id === roll.rightId)
    if (left && right) paintTwoUp(Math.max(left.out - 0.04, left.in), right.in)
  }

  /** Alt+drag on a scene's body — a slip: the window moves inside the source,
   * the block stays put on the output clock. The two-up shows the new first
   * and last frame. */
  const slipLiveRef = useRef(false)
  function slipScene(cut: WorkingCut, patch: { in: number; out: number }): void {
    if (!slipLiveRef.current) {
      slipLiveRef.current = true
      beginCutBlockEdit('เลื่อนหน้าต่าง')
      beginTwoUp(cut)
    }
    updateCut(cut.id, patch)
    paintTwoUp(patch.in, Math.max(patch.out - 0.04, patch.in))
  }

  /** The drag on a scene block ended (the lanes call it after a trim, a roll
   * or a slip alike): close the two-up and record the step. */
  function endCutBlockEdit(): void {
    if (rollRef.current || slipLiveRef.current) {
      rollRef.current = null
      slipLiveRef.current = false
      endTwoUp()
    }
    commitCutBlockEdit()
  }

  /** ลบ — the selected scenes, in ONE undo step, with a way straight back. */
  function deleteCuts(ids: readonly string[]) {
    if (ids.length === 0) return
    const before = cutsRef.current
    const ordered = idsInOrder(
      ids,
      before.map((c) => c.id)
    )
    if (ordered.length === 0) return
    const firstNumber = sceneNumber(ordered[0])
    const label = ordered.length > 1 ? `ลบ ${ordered.length} ฉาก` : 'ลบฉาก'
    const next = editCuts((prev) => withCutsRemoved(prev, new Set(ordered)), label)
    if (!next) return
    setSelection((prev) => pruneSelection(prev, new Set(next.map((c) => c.id))))
    // The scene that slid into the gap is what to look at.
    announceEdit(
      changedCutId(before, next),
      ordered.length > 1 ? `ลบ ${ordered.length} ฉากแล้ว` : `ลบฉาก ${firstNumber ?? ''} แล้ว`,
      sceneCountDetail(),
      undoAction()
    )
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
    const added = editCuts(
      (prev) =>
        withNewScene(prev, {
          id: cutId,
          source: sourceId,
          start,
          end,
          isDub,
          atPlayhead: opts?.insertAtPlayhead ?? false,
          afterCutId: opts?.afterCutId
        }),
      'เพิ่มฉาก'
    )
    // The scene you just added is the one you edit next — as in any editor
    // (owner, 2026-09-22). Selection only: the playhead stays where it is.
    if (added) {
      setSelectedId(cutId)
      announceEdit(cutId, 'เพิ่มฉากแล้ว', sceneCountDetail())
    }
  }

  function addMontageCut() {
    if (!selectedCut || !isDub || !timeline) return
    const lineId = cutLineId(selectedCut)
    const srcDur = timeline.sources.find((s) => s.id === selectedCut.source)?.durationSec ?? 60
    const start = clamp(selectedCut.out, 0, Math.max(srcDur - MIN_CUT_SEC, 0))
    const end = clamp(start + DEFAULT_NEW_CUT_SEC, start + MIN_CUT_SEC, srcDur)
    newCutCounter.current += 1
    const cutId = `new${newCutCounter.current}`
    const added = editCuts(
      (prev) => withNewAngle(prev, { id: cutId, source: selectedCut.source, lineId, start, end }),
      'เพิ่มมุม'
    )
    // Selected, like a new scene — see addCut.
    if (added) {
      setSelectedId(cutId)
      announceEdit(
        cutId,
        'เพิ่มมุมให้ประโยคนี้แล้ว',
        `ประโยคนี้มี ${cutsInLine(added, lineId).length} มุม`
      )
    }
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

  /** The scene under the playhead and where the playhead is inside it, in
   * SOURCE time — the edited view's segment, or the file on screen's cut. */
  function sceneUnderPlayhead(): { cut: WorkingCut; atSrc: number } | null {
    const t = currentTimeRef.current
    const list = cutsRef.current
    if (viewModeRef.current === 'edited') {
      const seg = findEditedSegment(list, t)
      return seg ? { cut: seg.cut, atSrc: seg.cut.in + (t - seg.editedIn) } : null
    }
    const c = findSourceCutAtTime(list, previewSource, t)
    return c ? { cut: c, atSrc: t } : null
  }

  /** แยกที่หัวเล่น (S / ⌘B) — split the scene under the playhead into two. */
  function splitAtPlayhead(cutHint?: WorkingCut) {
    // Why it CANNOT split is worth saying too: the button refused in silence,
    // which reads the same as a button that is broken.
    const refuse = (): void =>
      showToast({
        text: 'แยกตรงนี้ไม่ได้',
        detail: 'หัวเล่นต้องอยู่กลางฉาก และทั้งสองส่วนต้องยาวพอ'
      })
    const under = sceneUnderPlayhead()
    if (!under || (cutHint && under.cut.id !== cutHint.id)) return refuse()
    const cutId = under.cut.id
    newCutCounter.current += 1
    const newId = `new${newCutCounter.current}`
    if (!editCuts((prev) => splitCutAt(prev, cutId, under.atSrc, newId), 'แยกฉาก')) return refuse()
    // The half AFTER the playhead: the split was made to work on what comes
    // next, and it is the piece that did not exist a moment ago. Both halves
    // flash — the split is the line between them.
    setSelectedId(newId)
    revealAndFlashCuts([cutId, newId])
    announceEdit(null, 'แยกฉากแล้ว', sceneCountDetail())
  }

  /** ทำซ้ำ (⌘D) — duplicate the selected scene right after itself. */
  function duplicateSelectedCut(cutId: string | null = selectedId) {
    if (!cutId) return
    newCutCounter.current += 1
    const newId = `new${newCutCounter.current}`
    if (!editCuts((prev) => withDuplicate(prev, cutId, newId, isDub), 'ทำซ้ำฉาก')) return
    setSelectedId(newId)
    announceEdit(newId, 'ทำซ้ำฉากแล้ว', sceneCountDetail())
  }

  /**
   * Where the playhead is for `cut`, in that cut's source time, with the
   * clamps a trim to it must respect — or null when the playhead is not on
   * a clock that means anything for this scene (another file in the source
   * view; outside the scene in the edited view).
   */
  function playheadInCut(cut: WorkingCut): { atSrc: number; minIn: number; maxOut: number } | null {
    const t = currentTimeRef.current
    if (viewModeRef.current === 'edited') {
      const start = editedInById.get(cut.id)
      if (start === undefined) return null
      const end = start + Math.max(cut.out - cut.in, 0)
      if (t < start - 0.001 || t > end + 0.001) return null
      return { atSrc: cut.in + (t - start), minIn: 0, maxOut: getSourceDurationSec(cut.source) }
    }
    // The source view's clock belongs to the file on screen: a time from
    // another file means nothing for this scene. And the scene may not grow
    // over its lane neighbours — the drag-trim stops at them too (bug hunt
    // #12: ] stretched a 2–4 s scene to 30 s from another clip's lane).
    if (cut.source !== previewSource) return null
    return { atSrc: t, ...edgeBoundsFor(cut) }
  }

  /** One edge of `cut` set to the playhead — [ / ] on the selection, Q / W on
   * the scene under the playhead. One step, named; says what it did. */
  function trimCutToPlayhead(cut: WorkingCut, edge: TrimEdge, label: string, text: string) {
    const at = playheadInCut(cut)
    if (!at) return
    const { atSrc, minIn, maxOut } = at
    let next: WorkingCut[] | null = null
    if (edge === 'left') {
      if (atSrc > cut.out - MIN_CUT_SEC) return
      const nextIn = Math.max(atSrc, minIn)
      next = editCuts(
        (prev) => prev.map((c) => (c.id === cut.id ? { ...c, in: nextIn } : c)),
        label
      )
    } else {
      if (atSrc < cut.in + MIN_CUT_SEC) return
      const nextOut = Math.min(atSrc, maxOut)
      next = editCuts(
        (prev) => prev.map((c) => (c.id === cut.id ? { ...c, out: nextOut } : c)),
        label
      )
    }
    if (next) announceEdit(cut.id, text, `ยาวรวม ${fmtTimeTenths(computeEditedDuration(next))}`)
  }

  /** ตั้งจุดเข้า/จุดออก ([ / ]) — trim the selected cut to the playhead. */
  function setPointAtPlayhead(edge: TrimEdge) {
    if (!selectedCut) return
    const n = sceneNumber(selectedCut.id) ?? ''
    trimCutToPlayhead(
      selectedCut,
      edge,
      edge === 'left' ? 'ตั้งจุดเข้า' : 'ตั้งจุดออก',
      edge === 'left' ? `ตั้งจุดเข้าฉาก ${n} แล้ว` : `ตั้งจุดออกฉาก ${n} แล้ว`
    )
  }

  /** Q / W — ripple-trim the head / tail of the scene UNDER the playhead to
   * the playhead (CapCut's Q/W). The scene need not be selected. */
  function trimToPlayhead(edge: TrimEdge) {
    const under = sceneUnderPlayhead()
    if (!under) return
    const n = sceneNumber(under.cut.id) ?? ''
    trimCutToPlayhead(
      under.cut,
      edge,
      edge === 'left' ? 'ตัดหัวฉาก' : 'ตัดท้ายฉาก',
      edge === 'left' ? `ตัดหัวฉาก ${n} แล้ว` : `ตัดท้ายฉาก ${n} แล้ว`
    )
  }

  /** The edge Alt+←/→ and E act on: the handle the user clicked or Tab-focused,
   * else the selected scene's right edge. */
  function edgeInFocus(): { cut: WorkingCut; edge: TrimEdge } | null {
    const focused = focusedEdge && cutsRef.current.find((c) => c.id === focusedEdge.cutId)
    if (focused && focusedEdge) return { cut: focused, edge: focusedEdge.edge }
    const sel = selectedId ? cutsRef.current.find((c) => c.id === selectedId) : null
    return sel ? { cut: sel, edge: 'right' } : null
  }

  /** Alt+←/→ (+Shift: 10 frames) — nudge the focused edge by frames. A burst
   * of presses is one undo step; the preview shows the edge. */
  function nudgeFocusedEdge(dir: -1 | 1, big: boolean) {
    const target = edgeInFocus()
    if (!target) return
    const { cut, edge } = target
    const frames = big ? NUDGE_FRAMES_BIG : 1
    const delta = dir * frames * FRAME_SEC
    const res = burstEditCuts(
      `nudge:${cut.id}:${edge}`,
      (prev) => nudgeCutEdge(prev, cut.id, edge, delta, edgeBoundsFor(cut)),
      'ขยับขอบฉาก'
    )
    if (!res) return
    const now = res.next.find((c) => c.id === cut.id)
    if (!now) return
    showCutFrame(now, edge === 'left' ? now.in : Math.max(now.out - 0.04, now.in))
    const n = sceneNumber(cut.id) ?? ''
    const text = `ขยับ${edge === 'left' ? 'ขอบซ้าย' : 'ขอบขวา'}ฉาก ${n} ${dir > 0 ? '+' : '−'}${frames} เฟรม`
    if (res.newStep) showToast({ text, detail: `ยาว ${(now.out - now.in).toFixed(2)} วิ` })
    liveRegionRef.current?.announce(text)
  }

  /** , / . (+Shift: 10 frames) — slip the selected scene's window by frames.
   * Same burst rule as the nudge; the preview shows the new first frame. */
  function slipSelectedByFrames(dir: -1 | 1, big: boolean) {
    const sel = selectedId ? cutsRef.current.find((c) => c.id === selectedId) : null
    if (!sel) return
    const frames = big ? NUDGE_FRAMES_BIG : 1
    const delta = dir * frames * FRAME_SEC
    const res = burstEditCuts(
      `slip:${sel.id}`,
      (prev) => {
        const cur = prev.find((c) => c.id === sel.id)
        if (!cur) return null
        const win = slipCut(cur, delta, edgeBoundsFor(cur))
        if (win.in === cur.in && win.out === cur.out) return null
        return prev.map((c) => (c.id === sel.id ? { ...c, ...win } : c))
      },
      'เลื่อนหน้าต่าง'
    )
    if (!res) return
    const now = res.next.find((c) => c.id === sel.id)
    if (!now) return
    showCutFrame(now, now.in)
    const text = `เลื่อนหน้าต่างฉาก ${sceneNumber(sel.id) ?? ''} ${dir > 0 ? '+' : '−'}${frames} เฟรม`
    if (res.newStep) showToast({ text, detail: `เริ่มที่ ${fmtTimeTenths(now.in)} ในคลิป` })
    liveRegionRef.current?.announce(text)
  }

  /** E — extend edit: roll the focused edge (else the selected scene's right
   * edge) to the playhead, so the boundary lands there and the total length
   * stays. */
  function extendEditToPlayhead() {
    const target = edgeInFocus()
    if (!target) return
    const pair = rollPair(target.cut.id, target.edge)
    if (!pair) {
      // No neighbour past this edge: the edge alone goes to the playhead.
      trimCutToPlayhead(target.cut, target.edge, 'เลื่อนรอยตัด', 'เลื่อนขอบไปหัวเล่นแล้ว')
      return
    }
    const t = currentTimeRef.current
    let edgeNow: number | null = null
    if (viewModeRef.current === 'edited') {
      edgeNow = editedInById.get(pair.right.id) ?? null
    } else if (pair.left.source === previewSource) {
      edgeNow = pair.left.out
    }
    if (edgeNow === null) return
    const lb = edgeBoundsFor(pair.left, pair.right.id)
    const rb = edgeBoundsFor(pair.right, pair.left.id)
    const bounds = {
      leftMinIn: lb.minIn,
      leftMaxOut: lb.maxOut,
      rightMinIn: rb.minIn,
      rightMaxOut: rb.maxOut
    }
    const next = editCuts(
      (prev) => rollCutBoundary(prev, pair.left.id, t - edgeNow, bounds),
      'เลื่อนรอยตัด'
    )
    if (!next) return
    revealAndFlashCuts([pair.left.id, pair.right.id])
    announceEdit(
      null,
      `เลื่อนรอยตัดระหว่างฉาก ${sceneNumber(pair.left.id) ?? ''} กับ ${sceneNumber(pair.right.id) ?? ''} ไปหัวเล่นแล้ว`
    )
  }

  /** Alt+↑/↓ — move the selected scene one slot earlier / later. */
  function moveSelectedScene(dir: -1 | 1) {
    if (!selectedId) return
    const id = selectedId
    const next = editCuts((prev) => withSceneMoved(prev, id, dir, isDub), 'ย้ายฉาก')
    if (!next) return
    revealAndFlashCut(id)
    announceEdit(null, `ย้ายฉากไปตำแหน่ง ${sceneNumber(id) ?? ''} แล้ว`, undefined, undoAction())
  }

  /** D — skip / unskip a scene: it stays in the list, greyed, and plays and
   * renders as if it were not there. The review editor's "hide this for
   * now" — the ffmpeg save drops it (cutPayload dropSkipped). */
  function toggleSkipScene(cutId: string | null = selectedId) {
    if (!cutId) return
    const was = cutsRef.current.find((c) => c.id === cutId)
    if (!was) return
    const skipping = !isSkipped(was)
    const next = editCuts(
      (prev) => withSkipToggled(prev, cutId),
      skipping ? 'ข้ามฉาก' : 'เอาฉากกลับ'
    )
    if (!next) return
    const n = sceneNumber(cutId) ?? ''
    announceEdit(
      cutId,
      skipping ? `ข้ามฉาก ${n} แล้ว · กด D อีกครั้งเพื่อเอากลับ` : `เอาฉาก ${n} กลับแล้ว`,
      `ยาวรวม ${fmtTimeTenths(computeEditedDuration(next))}`
    )
  }

  /** ⌘C — the selected scenes, in play order, onto the editor's clipboard. */
  function copySelection(): boolean {
    const ordered = idsInOrder(
      selection.ids,
      cutsRef.current.map((c) => c.id)
    )
    const picked = ordered
      .map((id) => cutsRef.current.find((c) => c.id === id))
      .filter((c): c is WorkingCut => !!c)
    if (picked.length === 0) return false
    clipboardRef.current = picked
    const text = picked.length > 1 ? `คัดลอก ${picked.length} ฉากแล้ว` : 'คัดลอกฉากแล้ว'
    showToast({ text, detail: 'กด ⌘/Ctrl+V เพื่อวางหลังหัวเล่น' })
    liveRegionRef.current?.announce(text)
    return true
  }

  /** ⌘X — copy, then delete, in one undo step. */
  function cutSelectionToClipboard() {
    if (!copySelection()) return
    deleteCuts(selection.ids)
  }

  /** ⌘V — paste after the scene under the playhead (else after the primary),
   * as new scenes; they are selected and flashed. */
  function pasteClipboard() {
    const clip = clipboardRef.current
    if (clip.length === 0) {
      showToast({ text: 'ยังไม่มีฉากที่คัดลอกไว้', detail: 'เลือกฉากแล้วกด ⌘/Ctrl+C ก่อน' })
      return
    }
    const afterId =
      (viewModeRef.current === 'edited'
        ? findEditedSegment(cutsRef.current, currentTimeRef.current)?.cut.id
        : null) ??
      selectedId ??
      null
    const pastedIds: string[] = []
    const nextId = (): string => {
      newCutCounter.current += 1
      const id = `new${newCutCounter.current}`
      pastedIds.push(id)
      return id
    }
    const next = editCuts((prev) => pasteCuts(prev, afterId, clip, nextId, isDub), 'วางฉาก')
    if (!next || pastedIds.length === 0) return
    setSelection({ ids: pastedIds, anchor: pastedIds[0], primary: pastedIds[0] })
    revealAndFlashCuts(pastedIds)
    announceEdit(
      null,
      pastedIds.length > 1 ? `วาง ${pastedIds.length} ฉากแล้ว` : 'วางฉากแล้ว',
      sceneCountDetail()
    )
  }

  /** Shift+Delete — remove the I/O range from the cut (output clock). */
  function deleteRange() {
    const r = rangeRef.current
    if (!r) {
      showToast({ text: 'ยังไม่ได้ตั้งช่วง I–O', detail: 'กด I แล้ว O เพื่อกำหนดช่วงก่อน' })
      return
    }
    const before = cutsRef.current
    const nextId = (): string => {
      newCutCounter.current += 1
      return `new${newCutCounter.current}`
    }
    const next = editCuts((prev) => withRangeRemoved(prev, r, nextId), 'ลบช่วง')
    if (!next) {
      showToast({ text: 'ลบช่วงนี้ไม่ได้', detail: 'ช่วงหรือฉากที่เหลือสั้นเกินไป' })
      return
    }
    setRange(null)
    setSelection((prev) => pruneSelection(prev, new Set(next.map((c) => c.id))))
    const landed = changedCutIds(before, next)
    if (landed.length) revealAndFlashCuts(landed)
    announceEdit(
      null,
      `ลบช่วง ${fmtTimeTenths(r.inSec)}–${fmtTimeTenths(r.outSec)} แล้ว`,
      `ยาวรวม ${fmtTimeTenths(computeEditedDuration(next))}`,
      undoAction()
    )
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

  /** What a move landed as, for its toast: 'ก่อนฉาก 5' or 'ท้ายสุด'. */
  function movedToText(next: WorkingCut[], lastMovedId: string): string {
    const idx = next.findIndex((c) => c.id === lastMovedId)
    const after = next[idx + 1]
    return after ? `ไปก่อนฉาก ${idx + 2}` : 'ไปท้ายสุด'
  }

  function handleSequenceDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const activeId = String(active.id)
    const n = sceneNumber(activeId)
    // Not a plain arrayMove: that could pull one angle away from its
    // voiceover line, or drop a scene between another line's angles — see
    // withReorder.
    const next = editCuts((prev) => withReorder(prev, activeId, String(over.id), isDub), 'ย้ายฉาก')
    if (!next) return
    revealAndFlashCut(activeId)
    announceEdit(null, `ย้ายฉาก ${n ?? ''} ${movedToText(next, activeId)}`, undefined, undoAction())
  }

  /** A multi-selection dragged as one block. */
  function reorderMany(ids: string[], overId: string) {
    const ordered = idsInOrder(
      ids,
      cutsRef.current.map((c) => c.id)
    )
    if (ordered.length === 0) return
    const next = editCuts((prev) => withReorderMany(prev, ordered, overId, isDub), 'ย้ายฉาก')
    if (!next) {
      showToast({ text: 'เลือกฉากที่ติดกันเพื่อย้ายพร้อมกัน' })
      return
    }
    revealAndFlashCuts(ordered)
    announceEdit(
      null,
      `ย้าย ${ordered.length} ฉาก ${movedToText(next, ordered[ordered.length - 1])}`,
      undefined,
      undoAction()
    )
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
    pushHistoryNow('ลบคำบรรยาย')
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
      // A skipped scene never reaches ffmpeg; the draft keeps it (meta.skipped)
      // so the skip survives a reload — useDraftAutosave passes the default.
      const payload: EditCut[] = cutPayload(cuts, isDub, { dropSkipped: true })
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
      const before = cutsRef.current
      const next = fxResult.value as EditCut[]
      pushHistory(snapshotNow(), 'AI แก้การตัด')
      writeCuts(next)
      // What the AI actually did, in the only terms the user cares about —
      // and a way straight back out of it. The re-edit used to replace the
      // whole cut in silence, with the selection cleared for good measure.
      const landed = changedCutIds(before, next)
      setSelection(
        landed.length ? { ids: landed, anchor: landed[0], primary: landed[0] } : clearSelection()
      )
      if (landed.length) revealAndFlashCuts(landed)
      announceEdit(
        null,
        'AI แก้การตัดให้แล้ว',
        `จาก ${before.length} ฉาก เป็น ${next.length} ฉาก`,
        undoAction()
      )
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

  // ---- playback helpers ------------------------------------------------------

  /** Shift+Space: the I/O range when one is set, else the selected scene. */
  function playSelectionOrRange(): void {
    const r = rangeRef.current
    if (r && viewModeRef.current === 'edited') {
      playRange(r.inSec, r.outSec)
      return
    }
    if (selectedId) playScene(selectedId)
  }

  /** Shift+K: ±1 s around the cut boundary nearest the playhead. */
  function playAroundNearestCut(): void {
    const t = currentTimeRef.current
    const bounds =
      viewModeRef.current === 'edited'
        ? outputCutBoundaries
        : Array.from(
            new Set(cuts.filter((c) => c.source === previewSource).flatMap((c) => [c.in, c.out]))
          ).sort((a, b) => a - b)
    const before = nextBoundary(bounds, t, -1, 0)
    const after = nextBoundary(bounds, t, 1, 0)
    const candidates = [before, after].filter((b): b is number => b !== null)
    if (candidates.length === 0) {
      playAround(t)
      return
    }
    const nearest = candidates.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a))
    playAround(nearest)
  }

  function toggleLoop(): void {
    const next = !isLooping
    setLoop(next)
    showToast({
      text: next ? 'เล่นวน: เปิด' : 'เล่นวน: ปิด',
      detail: next ? (rangeRef.current ? 'วนช่วง I–O' : 'วนทั้งคลิป') : undefined
    })
  }

  // ---- view helpers ----------------------------------------------------------

  /** F — zoom so the selected scene fills the timeline. */
  function zoomToSelection(): void {
    if (!selectedCut) return
    if (viewMode === 'edited') {
      const span = editedSpanOf(selectedCut, editedInById)
      if (span) zoomToRange(span.inSec, span.outSec)
      return
    }
    zoomToRange(selectedCut.in, selectedCut.out)
  }

  function toggleSnap(): void {
    const next = !snapEnabledRef.current
    snapEnabledRef.current = next
    setSnapEnabled(next)
    if (!next) guideRef.current?.setSnap(null)
    showToast({ text: next ? 'ดูดขอบ: เปิด' : 'ดูดขอบ: ปิด' })
  }

  // ---- markers + range -------------------------------------------------------

  function addMarkerAtPlayhead(): void {
    const t = currentTimeRef.current
    const { markers: next } = addMarker(markersRef.current, t)
    markersRef.current = next
    setMarkers(next)
    showToast({
      text: `ปักหมุดที่ ${fmtTimeTenths(t)} แล้ว`,
      detail: 'ดับเบิลคลิกหมุดเพื่อตั้งชื่อ'
    })
    liveRegionRef.current?.announce(`ปักหมุดที่ ${fmtTimeTenths(t)}`)
  }

  function jumpToMarker(dir: -1 | 1): void {
    const sec = nextMarkerSec(markersRef.current, currentTimeRef.current, dir)
    if (sec === null) return
    jumpTo(sec)
  }

  /** I / O — the range on the OUTPUT clock. Setting one end past the other
   * moves the other end to the sequence's edge, so a range always exists. */
  function setRangeEdge(edge: 'in' | 'out'): void {
    if (viewModeRef.current !== 'edited') {
      showToast({ text: 'ช่วง I–O ใช้ได้ในมุมมองตัดแล้ว', detail: 'กด ⌘/Ctrl+2 เพื่อสลับ' })
      return
    }
    const t = clamp(currentTimeRef.current, 0, editedDur)
    const cur = rangeRef.current
    let next: { inSec: number; outSec: number }
    if (edge === 'in') {
      const outSec = cur && cur.outSec > t + MIN_CUT_SEC ? cur.outSec : editedDur
      next = { inSec: t, outSec: Math.max(outSec, t) }
    } else {
      const inSec = cur && cur.inSec < t - MIN_CUT_SEC ? cur.inSec : 0
      next = { inSec: Math.min(inSec, t), outSec: t }
    }
    rangeRef.current = next
    setRange(next)
    showToast({
      text:
        edge === 'in' ? `ตั้งจุด I ที่ ${fmtTimeTenths(t)}` : `ตั้งจุด O ที่ ${fmtTimeTenths(t)}`,
      detail: `ช่วง ${fmtTimeTenths(next.inSec)}–${fmtTimeTenths(next.outSec)} · Shift+Space เล่น · Shift+Del ลบ`
    })
  }

  function jumpToRangeEdge(edge: 'in' | 'out'): void {
    const r = rangeRef.current
    if (!r) return
    jumpTo(edge === 'in' ? r.inSec : r.outSec)
  }

  function clearRange(): void {
    if (!rangeRef.current) return
    rangeRef.current = null
    setRange(null)
    showToast({ text: 'ล้างช่วง I–O แล้ว' })
  }

  // ---- context menu ----------------------------------------------------------

  function openContextMenu(cut: WorkingCut, at: { x: number; y: number }): void {
    // A right-click on a scene outside the selection selects it first, as
    // every editor does; inside the selection it keeps the group.
    if (!selectedIds.has(cut.id)) setSelectedId(cut.id)
    setContextMenu({ cut, at })
  }

  function closeContextMenu(): void {
    setContextMenu(null)
  }

  const contextMenuItems = useMemo((): (MenuItemDef | { divider: true })[] => {
    if (!contextMenu) return []
    const many = selectedIds.has(contextMenu.cut.id) && selectedIds.size > 1
    const skipped = isSkipped(contextMenu.cut)
    return [
      { key: 'split', label: 'แยกที่หัวเล่น' },
      { key: 'duplicate', label: 'ทำซ้ำ' },
      ...(onOpenShotSwap ? [{ key: 'shot-swap', label: 'ปรับช็อต' }] : []),
      { key: 'play-scene', label: 'เล่นฉากนี้' },
      { key: 'skip', label: skipped ? 'เอากลับ' : 'ข้ามฉาก' },
      { divider: true },
      { key: 'select-forward', label: 'เลือกตั้งแต่นี้ถึงท้าย' },
      { divider: true },
      { key: 'delete', label: many ? `ลบ ${selectedIds.size} ฉาก` : 'ลบ', destructive: true }
    ]
  }, [contextMenu, selectedIds, onOpenShotSwap])

  function runContextMenuItem(key: string): void {
    const menu = contextMenu
    setContextMenu(null)
    if (!menu) return
    const cut = menu.cut
    switch (key) {
      case 'split':
        splitAtPlayhead()
        break
      case 'duplicate':
        duplicateSelectedCut(cut.id)
        break
      case 'shot-swap':
        onOpenShotSwap?.(cut.id)
        break
      case 'play-scene':
        playScene(cut.id)
        break
      case 'skip':
        toggleSkipScene(cut.id)
        break
      case 'select-forward':
        setSelection(
          selectForward(
            cutsRef.current.map((c) => c.id),
            cut.id
          )
        )
        break
      case 'delete':
        deleteCuts(selectedIds.has(cut.id) ? selection.ids : [cut.id])
        break
    }
  }

  // ---- navigation ----------------------------------------------------------

  /**
   * ↑ / ↓ and the transport's two step buttons: the cut boundary before or
   * after the playhead, with that scene selected. Shot navigation is what
   * every NLE binds there, and the frame step stays on ← / →.
   *
   * The boundaries are the ones cutBoundariesSec already lays out for the beat
   * snap — until now that list fed nothing else. In the source view the clock
   * belongs to the file on screen, so that file's own cut edges are the
   * boundaries instead.
   */
  function jumpToCut(dir: -1 | 1): void {
    const t = currentTimeRef.current
    if (viewMode === 'edited') {
      const target = nextBoundary(outputCutBoundaries, t, dir)
      if (target === null) return
      jumpTo(target)
      // The scene the playhead is now INSIDE. The last boundary is the end of
      // the edit and has no scene after it, so it keeps the last one.
      const seg = findEditedSegment(cuts, Math.min(target, Math.max(editedDur - 0.001, 0)))
      if (seg) setSelectedId(seg.cut.id)
      return
    }
    const lane = cuts.filter((c) => c.source === previewSource)
    const bounds = Array.from(new Set(lane.flatMap((c) => [c.in, c.out]))).sort((a, b) => a - b)
    const target = nextBoundary(bounds, t, dir)
    if (target === null) return
    jumpTo(target)
    // A hair inside, in the direction of travel: a boundary is shared by the
    // scene that ends there and the one that starts there.
    const at = findSourceCutAtTime(cuts, previewSource, target + dir * 0.001)
    if (at) setSelectedId(at.id)
  }

  // ---- keyboard ------------------------------------------------------------
  // The whole keyboard lives in useEditorShortcuts; this is the action bag it
  // dispatches into, rebuilt every render so each action sees this render.

  useEditorShortcuts({
    ready: editorPhase === 'ready',
    hasPreview: !!previewSrc,
    shortcutsOpen,
    setShortcutsOpen,
    isDub,
    canShotSwap: !!onOpenShotSwap,
    hasSelection: !!selectedId,
    onEscape: () => {
      // Esc gives back the smallest thing it can reach: the context menu,
      // then the selection, then the whole editor. Closing the editor from
      // the key people press to deselect is a surprise.
      if (contextMenu) {
        setContextMenu(null)
        return
      }
      if (selection.ids.length > 0 || selectedId) {
        setSelection(clearSelection())
        return
      }
      void requestClose()
    },
    togglePlay,
    playSelectionOrRange,
    playAroundNearestCut,
    toggleLoop,
    shuttleFaster,
    shuttleStop,
    shuttleBack,
    openShotSwap: () => {
      if (selectedId) onOpenShotSwap?.(selectedId)
    },
    zoomAround: (factor) => zoomAround(factor),
    fitToggle,
    zoomToSelection,
    switchView: switchViewMode,
    toggleSnap,
    undo: undoWithFeedback,
    redo: redoWithFeedback,
    save: () => {
      if (!saving && cuts.length > 0) void handleSave()
    },
    deleteRange,
    deleteSelection: deleteSelectedCut,
    split: () => splitAtPlayhead(),
    duplicate: () => duplicateSelectedCut(),
    copy: () => void copySelection(),
    cutToClipboard: cutSelectionToClipboard,
    paste: pasteClipboard,
    selectAll: () => setSelection(selectAll(cuts.map((c) => c.id))),
    deselectAll: () => setSelection(clearSelection()),
    addScene: addSceneAtPlayhead,
    addAngle: addMontageCut,
    setPointAtPlayhead,
    trimToPlayhead,
    nudgeEdge: nudgeFocusedEdge,
    slipNudge: slipSelectedByFrames,
    extendEdit: extendEditToPlayhead,
    moveScene: moveSelectedScene,
    toggleSkip: () => toggleSkipScene(),
    addMarker: addMarkerAtPlayhead,
    jumpMarker: jumpToMarker,
    setRangeIn: () => setRangeEdge('in'),
    setRangeOut: () => setRangeEdge('out'),
    jumpRange: jumpToRangeEdge,
    clearRange,
    nudgePlayhead,
    jumpToCut,
    jumpHome: () => jumpTo(0),
    jumpEnd: () => jumpTo(getActiveDurationSec())
  })

  // ---- derived render values ----------------------------------------------

  const axisDur = viewMode === 'edited' ? editedDur : getSourceAxisDurationSec()
  const contentW = getContentWidthPx()
  // A finger needs a taller ruler than a mouse pointer (28 px vs RULER_PX).
  const rulerPx = coarse ? Math.max(RULER_PX, 28) : RULER_PX
  const skippedIds = useMemo(() => new Set(cuts.filter(isSkipped).map((c) => c.id)), [cuts])
  // 'A', 'B', … — what the block tooltip and the inspector call each file.
  const sourceLabelById = useMemo(
    () =>
      new Map(
        (timeline?.sources ?? []).map((src, i) => [
          src.id,
          i < 26 ? String.fromCharCode(65 + i) : String(i + 1)
        ])
      ),
    [timeline]
  )
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
    // jumpTo, not applyScrubTime: a jump from a button has to bring the
    // playhead back on screen, or the ท่อนก่อนหน้า / ท่อนถัดไป buttons move a
    // playhead nobody can see.
    if (captionsOnOutputClock) {
      // Already an output time — only the source view needs a conversion, and
      // there is none to make (a line can span scenes there), so stay put.
      if (viewMode === 'edited') jumpTo(line.start + 0.01)
    } else if (viewMode === 'edited') {
      const mapped = mapSourceTimeToOutput(cuts, line.start + 0.01)
      if (mapped !== null) jumpTo(mapped)
    } else {
      jumpTo(line.start)
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
    beginEdit('ยืด–หดคำบรรยาย')
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
  const onUndo = useStableCallback(undoWithFeedback)
  const onRedo = useStableCallback(redoWithFeedback)
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
    if (now - captionStyleStepAtRef.current > CAPTION_STYLE_BURST_MS)
      pushHistoryNow('ปรับหน้าตาคำบรรยาย')
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
  const onSeek = useStableCallback((sec: number) => jumpTo(sec))
  const onScrubStart = useStableCallback(() => {
    isScrubbingSeekbarRef.current = true
    pauseForScrub()
  })
  const onScrubEnd = useStableCallback(() => {
    isScrubbingSeekbarRef.current = false
    resumeAfterScrub()
  })
  // The transport's two step buttons are CUT jumps, not frame steps — see
  // PreviewPane. The frame step is still on ← / →.
  const onStepBack = useStableCallback(() => jumpToCut(-1))
  const onStepForward = useStableCallback(() => jumpToCut(1))
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
  // The script box and the caption fields: one step per focus, named.
  const onBeginEdit = useStableCallback(() => beginEdit('แก้ข้อความ'))
  const onCommitEdit = useStableCallback(commitEdit)
  // A click on a scene: the selection reducer decides what the modifiers
  // mean (selection.ts); a plain click in the source view still loads the
  // other file (selectCut). Shift/⌘ clicks only change the selection.
  const onSelectCut = useStableCallback((cut: WorkingCut, mods?: SelectMods) => {
    const m = mods ?? { shift: false, toggle: false }
    if (!m.shift && !m.toggle) {
      void selectCut(cut)
      return
    }
    setSelection((prev) =>
      selectClick(
        prev,
        cut.id,
        m,
        cutsRef.current.map((c) => c.id)
      )
    )
  })
  const onMarquee = useStableCallback((hits: string[], additive: boolean) => {
    setSelection((prev) => selectMarquee(prev, hits, additive))
  })
  const onContextMenuCut = useStableCallback(openContextMenu)
  const onCloseContextMenu = useStableCallback(closeContextMenu)
  const onContextMenuSelect = useStableCallback(runContextMenuItem)
  const onFocusEdge = useStableCallback((cutId: string, edge: TrimEdge | null) => {
    setFocusedEdge(edge ? { cutId, edge } : null)
  })
  // "Show me this one" — a double-click on a block, an angle thumbnail. A
  // single click on a block still only selects (see selectCut).
  const onGoToCut = useStableCallback((cut: WorkingCut) => goToCutStart(cut))
  const onScriptChange = useStableCallback(updateLineScript)
  const onAddAngle = useStableCallback(addMontageCut)
  const onUpdateCaptionLine = useStableCallback(updateCaptionLine)
  const onDeleteCaptionLine = useStableCallback((id: string) => {
    deleteCaptionLine(id)
    setCaptionCursor((i) => Math.max(0, i - 1))
  })
  const onJumpToCaption = useStableCallback(jumpToCaption)
  const onExportSrt = useStableCallback(exportSrt)
  const onSplit = useStableCallback(() => splitAtPlayhead())
  const onDuplicate = useStableCallback(() => duplicateSelectedCut())
  const onDeleteSelected = useStableCallback(deleteSelectedCut)
  const onPlayScene = useStableCallback(() => {
    if (selectedId) playScene(selectedId)
  })
  const onToggleSkip = useStableCallback(() => toggleSkipScene())
  const onOpenShotSwapSelected = useStableCallback(() => {
    if (selectedId) onOpenShotSwap?.(selectedId)
  })

  // The timeline.
  const onSwitchView = useStableCallback(switchViewMode)
  const onAddScene = useStableCallback(addSceneAtPlayhead)
  const onToggleSnap = useStableCallback(toggleSnap)
  const onToggleSkim = useStableCallback(() => setSkimEnabled((v) => !v))
  const onFitToggle = useStableCallback(fitToggle)
  const onZoomSelection = useStableCallback(zoomToSelection)
  const onLayout = useStableCallback((next: 'lanes' | 'strip') => {
    layoutChosenRef.current = true
    setLayout(next)
  })
  const onRulerDown = useStableCallback(onRulerPointerDown)
  const onLaneDown = useStableCallback(onLaneBackgroundPointerDown)
  const onSourceLaneDown = useStableCallback(onSourceLanePointerDown)
  const onUpdateCut = useStableCallback(updateCut)
  const onTrimCut = useStableCallback(trimCut)
  const onRoll = useStableCallback(rollBoundary)
  const onSlip = useStableCallback(slipScene)
  const onBlockEditStart = useStableCallback(() => beginCutBlockEdit())
  const onBlockEditEnd = useStableCallback(endCutBlockEdit)
  const onReorder = useStableCallback(handleSequenceDragEnd)
  const onReorderMany = useStableCallback(reorderMany)
  const onStripReorder = useStableCallback((activeId: string, overId: string) => {
    if (activeId === overId) return
    if (selectedIds.has(activeId) && selectedIds.size > 1) reorderMany(selection.ids, overId)
    else handleSequenceDragEnd({ active: { id: activeId }, over: { id: overId } } as DragEndEvent)
  })
  const onToggleLoop = useStableCallback(toggleLoop)
  // The transport's timecode entry: paintTime leaves the label alone while
  // it is being typed into (the same guard the seekbar drag uses).
  const onTimeEditStart = useStableCallback(() => {
    isScrubbingSeekbarRef.current = true
  })
  const onTimeEditEnd = useStableCallback(() => {
    isScrubbingSeekbarRef.current = false
  })

  /**
   * The snap context every drag reads — built over the CURRENT refs, since a
   * drag runs from a window listener bound at pointerdown and outlives any
   * render. Alt held or the switch off means no targets and no guide. Read
   * when a drag starts, not passed down as values: as props these rendered
   * every block whenever the music moved.
   */
  const getSnapContext = useStableCallback((): SnapContext => ({
    isActive: () => snapEnabledRef.current && !(modifierTrackerRef.current?.isAltHeld() ?? false),
    tolSec: () => snapTolSec(pxPerSecRef.current),
    outputTargets: (opts) => outputSnapTargets(opts?.excludeCutId),
    sourceTargets: (sourceId, opts) =>
      buildSourceTargets({
        cuts: cutsRef.current,
        sourceId,
        laneDurationSec: laneDurationById.get(sourceId) ?? getSourceDurationSec(sourceId),
        playheadSec: currentTimeRef.current,
        previewSource,
        excludeCutId: opts?.excludeCutId
      }),
    report: (hit) => guideRef.current?.setSnap(hit ? hit.target.sec : null, hit?.target.kind)
  }))
  /** Every edge on the output clock right now (see snapTargets.ts). */
  function outputSnapTargets(excludeCutId?: string): SnapTarget[] {
    const em = effectiveMusicRef.current
    return buildOutputTargets({
      cuts: cutsRef.current,
      voBlocks: voBlocksRef.current,
      capSpans: capSpansRef.current,
      // A music block mid-drag is not its own target (it would snap back).
      music: em && !musicDraggingRef.current ? em : null,
      musicDurationSec: musicDurationSecRef.current,
      beats: em?.beats ?? null,
      markers: markersRef.current,
      range: rangeRef.current,
      playheadSec: currentTimeRef.current,
      editedDur: computeEditedDuration(cutsRef.current),
      excludeCutId
    })
  }
  /** The scrub's snap: the on-screen clock's targets, a softer pull than a
   * trim so frame-precise scrubbing still works when zoomed in. The playhead
   * itself is not a target of its own move. */
  function getScrubSnap(): {
    active: boolean
    targets: SnapTarget[]
    tolSec: number
    report: (hit: SnapHit | null) => void
  } {
    const active = snapEnabledRef.current && !(modifierTrackerRef.current?.isAltHeld() ?? false)
    let targets: SnapTarget[] = []
    if (active && viewModeRef.current === 'edited') {
      targets = outputSnapTargets()
    } else if (active && previewSource) {
      targets = buildSourceTargets({
        cuts: cutsRef.current,
        sourceId: previewSource,
        laneDurationSec: getSourceDurationSec(previewSource),
        playheadSec: currentTimeRef.current,
        previewSource
      })
    }
    return {
      active,
      targets: targets.filter((t) => t.kind !== 'playhead'),
      tolSec: snapTolSec(pxPerSecRef.current, SCRUB_SNAP_THRESHOLD_PX),
      report: (hit) => guideRef.current?.setSnap(hit ? hit.target.sec : null, hit?.target.kind)
    }
  }
  // Hover skim: the frame under the pointer in the preview, the playhead
  // untouched. One seek per animation frame; the line and its time chip are
  // painted by GuideLines.
  const skimFrameRef = useRef(0)
  const onTimelineHover = useStableCallback((clientX: number | null) => {
    if (clientX === null) {
      if (skimFrameRef.current) window.cancelAnimationFrame(skimFrameRef.current)
      skimFrameRef.current = 0
      skimTo(null)
      guideRef.current?.setSkim(null)
      return
    }
    if (!skimEnabled || coarse) return
    if (skimFrameRef.current) return
    skimFrameRef.current = window.requestAnimationFrame(() => {
      skimFrameRef.current = 0
      const sec = timeAtClientX(clientX)
      skimTo(sec)
      guideRef.current?.setSkim(sec, fmtTimeTenths(sec))
    })
  })
  const onLaneHover = useStableCallback((e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse') return
    onTimelineHover(e.clientX)
  })
  const onLaneLeave = useStableCallback((e: React.PointerEvent) => {
    // A finger lifting is not a mouse leaving: the skimmer is mouse-only.
    if (e.pointerType !== 'mouse') return
    onTimelineHover(null)
  })
  // Markers.
  const onPickMarker = useStableCallback((id: string) => {
    const m = markersRef.current.find((x) => x.id === id)
    if (m) jumpTo(m.sec)
  })
  const onMoveMarker = useStableCallback((id: string, sec: number) => {
    const next = moveMarker(markersRef.current, id, sec)
    markersRef.current = next
    setMarkers(next)
  })
  const onRenameMarker = useStableCallback((id: string, label: string) => {
    const next = renameMarker(markersRef.current, id, label)
    markersRef.current = next
    setMarkers(next)
  })
  const onRemoveMarker = useStableCallback((id: string) => {
    const next = removeMarker(markersRef.current, id)
    markersRef.current = next
    setMarkers(next)
    showToast({ text: 'เอาหมุดออกแล้ว' })
  })
  const onPickVoiceoverLine = useStableCallback((firstCutId: string, outStartSec: number) => {
    const first = cuts.find((c) => c.id === firstCutId)
    if (first) setSelectedId(first.id)
    // A click on a line means "play me this line" — it is a label, not a
    // handle to grab, so unlike a scene block it seeks.
    jumpTo(outStartSec)
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
          undoLabel={undoLabel}
          redoLabel={redoLabel}
          onBack={onBack}
          onUndo={onUndo}
          onRedo={onRedo}
          onOpenShortcuts={openShortcuts}
          onOpenAi={openAiPanel}
          onSave={onSave}
        />

        {/* Every on-screen answer is also spoken here (announceEdit). */}
        <LiveRegion ref={liveRegionRef} />

        {shortcutsOpen && (
          <ShortcutsSheet isDub={isDub} canShotSwap={!!onOpenShotSwap} onClose={closeShortcuts} />
        )}

        {contextMenu && (
          <SceneContextMenu
            at={contextMenu.at}
            items={contextMenuItems}
            onSelect={onContextMenuSelect}
            onClose={onCloseContextMenu}
          />
        )}

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
                  loop={isLooping}
                  onToggleLoop={onToggleLoop}
                  onPlayScene={onPlayScene}
                  canPlayScene={!!selectedCut}
                  twoUp={twoUp}
                  twoUpIncoming={twoUpIncoming}
                  onTimeEditStart={onTimeEditStart}
                  onTimeEditEnd={onTimeEditEnd}
                />
              </div>

              {/* inspector — R3 right rail */}
              <aside className="flex min-h-[210px] w-full shrink-0 flex-col overflow-hidden border-t border-divider lg:max-h-none lg:min-h-0 lg:w-[360px] lg:border-l lg:border-t-0">
                <SelectedSceneHeader
                  selectedCut={headerCut}
                  playOrder={selectedCut ? playOrderMap.get(selectedCut.id) : undefined}
                  cutCount={cuts.length}
                  sourceLabel={selectedCut ? sourceLabelById.get(selectedCut.source) : undefined}
                  skipped={selectedCut ? isSkipped(selectedCut) : false}
                  selectionCount={selection.ids.length}
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
                      onSelectCut={onGoToCut}
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
                  selectionCount={selection.ids.length}
                  skipped={selectedCut ? isSkipped(selectedCut) : false}
                  onSplit={onSplit}
                  onDuplicate={onDuplicate}
                  onDelete={onDeleteSelected}
                  onPlayScene={onPlayScene}
                  onToggleSkip={onToggleSkip}
                  onOpenShotSwap={onOpenShotSwap ? onOpenShotSwapSelected : undefined}
                />
              </aside>
            </div>

            {/* timeline — toolbar · ruler+tracks (one scroll container) · hint */}
            <div className="shrink-0 border-t border-divider">
              <TimelineToolbar
                viewMode={viewMode}
                thStats={thStats}
                hasSelection={!!selectedCut}
                selectionCount={selection.ids.length}
                snapEnabled={snapEnabled}
                beatCount={music?.beats?.length ?? 0}
                skimEnabled={skimEnabled && !coarse}
                pxPerSec={pxPerSec}
                canZoomSelection={!!selectedCut}
                layout={layout}
                showLayoutToggle={coarse}
                onSwitchView={onSwitchView}
                onSplit={onSplit}
                onAddScene={onAddScene}
                onDelete={onDeleteSelected}
                onToggleSnap={onToggleSnap}
                onToggleSkim={onToggleSkim}
                onZoom={setPxPerSec}
                onFitToggle={onFitToggle}
                onZoomSelection={onZoomSelection}
                onLayout={onLayout}
              />

              {layout === 'strip' && viewMode === 'edited' ? (
                /* The phone storyboard: one thumbnail per scene, in play
                   order — tap to select, long-press to reorder. */
                <SceneStrip
                  cuts={cuts}
                  strips={strips}
                  selectedIds={selectedIds}
                  primaryId={selectedId}
                  playOrderMap={playOrderMap}
                  skippedIds={skippedIds}
                  onSelect={onSelectCut}
                  onOpen={onGoToCut}
                  onReorder={onStripReorder}
                  onContextMenu={onContextMenuCut}
                />
              ) : (
                <div
                  ref={viewportRef}
                  onScroll={onViewportScroll}
                  onPointerMove={onLaneHover}
                  onPointerLeave={onLaneLeave}
                  // Hover skim; both handlers branch on pointerType (a finger
                  // lifting is not a mouse leaving — see responsive.test.ts).
                  // touch-action pan-x pan-y (not none): one finger still
                  // scrolls natively, while a two-finger pinch is kept from
                  // the browser so it reaches the viewport's pinch-zoom
                  // pointer listeners (useTimelineViewport).
                  className="scroll-ghost relative max-h-[248px] touch-pan-x touch-pan-y overflow-auto select-none"
                >
                  <div
                    className="relative"
                    // leadPx: the touch-scrub model pads the axis so t=0 can
                    // sit under the centred playhead (useTimelineViewport).
                    // The lead is applied by each child (the ruler's tick x,
                    // TrackRow's lane margin, the absolute layers' left) so
                    // the content div only reserves the width — padding here
                    // would offset the flow children a second time.
                    style={{ width: HEADER_COL_PX + contentW + leadPx }}
                  >
                    {/* ruler */}
                    <div className="flex" style={{ height: rulerPx }}>
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
                        heightPx={rulerPx}
                        leadPx={leadPx}
                        coarse={coarse}
                        range={viewMode === 'edited' ? range : null}
                        onPointerDown={onRulerDown}
                        onHover={onTimelineHover}
                      />
                      {viewMode === 'edited' && (
                        <MarkerLayer
                          markers={markers}
                          pxPerSec={pxPerSec}
                          leadPx={leadPx}
                          onPick={onPickMarker}
                          onMove={onMoveMarker}
                          onRename={onRenameMarker}
                          onRemove={onRemoveMarker}
                          dragScroller={dragScroll}
                          getSnapContext={getSnapContext}
                        />
                      )}
                    </div>

                    {viewMode === 'edited' ? (
                      <>
                        <ImageLane
                          cuts={cuts}
                          selectedId={selectedId}
                          selectedIds={selectedIds}
                          playOrderMap={playOrderMap}
                          strips={strips}
                          filmstripPending={filmstrip.status === 'running'}
                          sourceDurationById={sourceDurationById}
                          sourceLabelById={sourceLabelById}
                          pxPerSec={pxPerSec}
                          contentW={contentW}
                          leadPx={leadPx}
                          coarse={coarse}
                          focusedEdge={focusedEdge}
                          skippedIds={skippedIds}
                          editedInById={editedInById}
                          getSnapContext={getSnapContext}
                          dragScroller={dragScroll}
                          onLaneBackgroundPointerDown={onLaneDown}
                          onSelectCut={onSelectCut}
                          onOpenCut={onGoToCut}
                          onContextMenu={onContextMenuCut}
                          onUpdateCut={onUpdateCut}
                          onTrimCut={onTrimCut}
                          onRoll={onRoll}
                          onSlip={onSlip}
                          onFocusEdge={onFocusEdge}
                          onMarquee={onMarquee}
                          onBlockEditStart={onBlockEditStart}
                          onBlockEditEnd={onBlockEditEnd}
                          onReorder={onReorder}
                          onReorderMany={onReorderMany}
                        />
                        {isDub && (
                          <VoiceoverLane
                            voBlocks={voBlocks}
                            playingLineId={playingLineId}
                            selectedLineId={selectedCut ? cutLineId(selectedCut) : null}
                            pxPerSec={pxPerSec}
                            contentW={contentW}
                            leadPx={leadPx}
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
                            getSnapContext={getSnapContext}
                            dragScroller={dragScroll}
                            pxPerSec={pxPerSec}
                            contentW={contentW}
                            leadPx={leadPx}
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
                            leadPx={leadPx}
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
                        selectedIds={selectedIds}
                        coarse={coarse}
                        pxPerSec={pxPerSec}
                        contentW={contentW}
                        leadPx={leadPx}
                        getSnapContext={getSnapContext}
                        dragScroller={dragScroll}
                        onSourceLanePointerDown={onSourceLaneDown}
                        onSelectCut={onSelectCut}
                        onContextMenu={onContextMenuCut}
                        onUpdateCut={onUpdateCut}
                        onTrimCut={onTrimCut}
                        onSlip={onSlip}
                        onFocusEdge={onFocusEdge}
                        onBlockEditStart={onBlockEditStart}
                        onBlockEditEnd={onBlockEditEnd}
                      />
                    )}

                    {/* Beat ticks sit BEHIND the lanes (z-0): they are a guide for
                      the eye, and painting them over a block's own artwork or
                      label makes both harder to read (HANDOFF §3). Shown whenever
                      the track has beats and the magnet is on — they are what
                      it pulls to. */}
                    {viewMode === 'edited' &&
                      snapEnabled &&
                      effectiveMusic?.beats &&
                      effectiveMusic.beats.length > 0 && (
                        <BeatTicks
                          beats={effectiveMusic.beats}
                          trimInSec={effectiveMusic.trimInSec}
                          offsetSec={effectiveMusic.offsetSec}
                          editedDur={editedDur}
                          pxPerSec={pxPerSec}
                          leadPx={leadPx}
                        />
                      )}

                    <Playhead
                      playheadRef={playheadRef}
                      playheadLineRef={playheadLineRef}
                      edgeHintRef={edgeHintRef}
                      coarse={coarse}
                      onGrabPointerDown={onRulerDown}
                    />
                    {/* The snap guide and the skim line, painted per frame. */}
                    <GuideLines ref={guideRef} leadPx={leadPx} pxPerSecRef={pxPerSecRef} />
                  </div>
                </div>
              )}

              <p className="truncate px-4 py-1.5 text-[13px] text-muted">
                {viewMode === 'edited'
                  ? 'ลากขอบ = ยืด–หด · Alt+ลาก = เลื่อนหน้าต่าง · ⌘/Ctrl+ลากที่จับ = เลื่อนรอยตัด · Shift+ลาก = เลือกหลายฉาก · Alt ค้าง = ปิดดูดขอบ · ⌘/Ctrl+ล้อ = ซูม'
                  : 'ตัวเลขในบล็อกคือลำดับที่จะเล่นจริง · ช่วงที่ไม่มีบล็อกคือส่วนที่ไม่ถูกใช้ · ลากขอบเพื่อเปลี่ยนช่วงที่ตัดมาใช้ · Alt+ลาก = เลื่อนหน้าต่าง'}
              </p>
            </div>
          </>
        )}
      </div>
    </TimelineViewportContext.Provider>
  )
})
