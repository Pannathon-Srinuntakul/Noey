/** IO seam for the ported TimelineEditor (frontend VideoTimelineEditor.tsx).
 *
 * The web editor talks to GET/PUT /videos/{uid}/edit-timeline and streams
 * source clips from the API. On desktop everything is local: the edit model
 * is derived from the project's edit script (pre-VO) or planned timeline
 * (post-VO), sources play via media://, and saving re-renders locally.
 * useProjectPipeline's openEditor() calls `configureEditorApi` before mounting
 * the editor.
 */

import { ApiError } from './api'
import type { CaptionLine } from './captionLines'
import { dubSegmentsFromEditCuts, type EditCutIn } from './dubSegments'
import type { DubEditScript, DubTimeline } from './videosLocalApi'
import type { LocalClip } from '../../../preload'

export type { CaptionLine } from './captionLines'

export interface EditTimelineSource {
  id: string
  durationSec: number
}

export interface EditCut {
  id: string
  source: string
  in: number
  out: number
  label: string
  voiceoverLineId?: number | null
  voiceoverScript?: string | null
}

export interface EditTimeline {
  mode: string
  editTarget: 'timeline' | 'edit_script'
  sources: EditTimelineSource[]
  cuts: EditCut[]
}

export type SaveCutPayload = Omit<EditCut, 'id'>

export interface EditorContext {
  localUid: string
  clips: LocalClip[]
  editTarget: 'timeline' | 'edit_script'
  editScript?: DubEditScript | null
  timeline?: DubTimeline | null
  /** Initial burned-caption lines (talking_head only) — undefined when the
   * project has no caption_style/words, empty array when captions are
   * enabled but not yet grouped/edited. */
  captionLines?: CaptionLine[]
  /** Persist + re-render; useProjectPipeline owns the flow. */
  onSave: (cuts: SaveCutPayload[], captionLines?: CaptionLine[]) => Promise<void>
  /** dub_first only: AI-assisted re-edit of the live (unsaved) cuts. Returns
   * the revised cut list — preview only, does NOT save/render; the caller
   * still hits Save to commit. Undefined outside dub_first pre-render editing. */
  onAiReedit?: (
    cuts: SaveCutPayload[],
    selectedLineIds: number[],
    instruction: string
  ) => Promise<EditCut[]>
}

let ctx: EditorContext | null = null

export function configureEditorApi(next: EditorContext): void {
  ctx = next
}

function requireCtx(): EditorContext {
  if (!ctx) throw new Error('editorApi not configured')
  return ctx
}

/** Initial caption lines for the currently-configured project, if any. */
export function initialCaptionLines(): CaptionLine[] | undefined {
  return ctx?.captionLines
}

/** Mirror of routers/videos.py get_edit_timeline (videos.py:605) for local data. */
export function editTimelineFromContext(c: EditorContext): EditTimeline {
  const sources: EditTimelineSource[] = c.clips.map((clip) => ({
    id: clip.id,
    durationSec: clip.durationSec
  }))

  let cuts: EditCut[]
  if (c.editTarget === 'timeline') {
    const raw = c.timeline?.timeline ?? []
    cuts = raw.map((t, i) => ({
      id: `cut${i}`,
      source: String(t.source),
      in: Number(t.in),
      out: Number(t.out),
      label: String(t.label ?? '')
    }))
  } else {
    cuts = editCutsFromDubSegments(c.editScript?.segments ?? [])
  }

  return { mode: 'dub_first', editTarget: c.editTarget, sources, cuts }
}

/** Edit Script segments (server/AI shape, sorted by `order`) → editor `EditCut[]`.
 * Inverse of dubSegmentsFromEditCuts — shared by the initial editor load and by
 * AI re-edit results, which return the same segment shape. */
export function editCutsFromDubSegments(segments: Record<string, unknown>[]): EditCut[] {
  const segs = [...segments].sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0))
  return segs.map((s, i) => ({
    id: `cut${i}`,
    source: String(s.sourceClip ?? 'clip0'),
    in: Number(s.sourceIn ?? 0),
    out: Number(s.sourceOut ?? 0),
    label: String(s.voiceoverLineId ?? i + 1),
    voiceoverLineId: s.voiceoverLineId != null ? Number(s.voiceoverLineId) : null,
    voiceoverScript: (s.voiceoverScript as string | undefined) ?? null
  }))
}

/** Manual cuts → edit_script JSON (shared shape with the server). */
export function editScriptFromCuts(cuts: SaveCutPayload[]): DubEditScript {
  const segments = dubSegmentsFromEditCuts(cuts as EditCutIn[])
  const total = segments.reduce((acc, s) => acc + s.durationSec, 0)
  return {
    mode: 'dub_first',
    totalEstimatedSec: Math.round(total * 10) / 10,
    segments: segments as unknown as Record<string, unknown>[]
  }
}

export const editorApi = {
  getEditTimeline: async (_uid: string): Promise<EditTimeline> =>
    editTimelineFromContext(requireCtx()),

  resolveSourcePreviewSrc: async (
    _uid: string,
    sourceId: string
  ): Promise<{ src: string; cleanup: () => void }> => {
    const c = requireCtx()
    const clip = c.clips.find((cl) => cl.id === sourceId)
    if (!clip) throw new Error(`ไม่พบคลิปต้นฉบับ ${sourceId}`)
    return { src: window.noey.media.urlFor(c.localUid, clip.file), cleanup: () => undefined }
  },

  saveEditTimeline: async (
    _uid: string,
    cuts: SaveCutPayload[],
    captionLines?: CaptionLine[]
  ): Promise<{ project_uid: string; job_id: string }> => {
    const c = requireCtx()
    await c.onSave(cuts, captionLines)
    return { project_uid: c.localUid, job_id: '' }
  },

  requestAiReedit: async (
    _uid: string,
    cuts: SaveCutPayload[],
    selectedLineIds: number[],
    instruction: string
  ): Promise<EditCut[]> => {
    const c = requireCtx()
    if (!c.onAiReedit) throw new Error('AI re-edit ใช้ได้เฉพาะโหมด dub_first ก่อน render')
    return c.onAiReedit(cuts, selectedLineIds, instruction)
  }
}

export function formatUserError(e: unknown): string {
  if (e instanceof ApiError) return e.detail
  const msg = (e as Error)?.message
  return typeof msg === 'string' && msg ? msg : String(e)
}
