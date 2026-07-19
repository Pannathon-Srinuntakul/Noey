/** Client for the backend local-render endpoints (/videos/local + friends).
 *
 * All functions take an ApiSession; on 401 they refresh once and retry, and
 * report the renewed tokens via onTokens so the caller can persist them.
 */

import { ApiError, refresh } from './api'
import { apiFetch } from './httpClient'

export interface ApiSession {
  baseUrl: string
  accessToken: string
  refreshToken: string
  onTokens?: (access: string, refreshTok: string) => void
}

export interface ClipMetaIn {
  id: string
  durationSec: number
  width: number
  height: number
  fps: number
}

export interface CaptionStyleIn {
  font: 'kanit' | 'prompt' | 'sarabun' | 'anuphan'
  mode: 'static' | 'word_pop' | 'typewriter'
  color: string
  border_color: string
  size: number
}

export interface CreateLocalProjectIn {
  mode?: 'dub_first' | 'talking_head' | 'highlight'
  brief?: string | null
  user_script?: string | null
  target_duration_sec?: number | null
  clips: ClipMetaIn[]
  caption_style?: CaptionStyleIn | null
}

export interface FrameManifestEntry {
  name: string
  clip_id: string
  time: number
  scene_idx: number
  scene_start: number
  scene_end: number
  edge?: string
  /** project-relative path — used to build the media:// fetch URL, not sent to the server */
  file: string
}

export interface ProxyManifestEntry {
  clip_id: string
  /** filename inside the sidecar's proxy/ dir, e.g. "clip0.mp4" */
  file: string
  durationSec: number
  order: number
}

export interface JobStatus {
  id: string
  type: string
  status: 'queued' | 'running' | 'ok' | 'error'
  progress: number
  result: Record<string, unknown> | null
  error: string | null
}

export interface DubEditScript {
  mode?: string
  totalEstimatedSec?: number
  segments: Record<string, unknown>[]
}

export interface DubTimeline {
  mode: string
  timeline: { type: string; source: string; in: number; out: number; label: string }[]
  [key: string]: unknown
}

async function request<T>(
  session: ApiSession,
  path: string,
  init: {
    method?: string
    headers?: Record<string, string>
    body?: string
    formFields?: Record<string, string>
    formFiles?: { field: string; path: string; filename?: string }[]
  } = {},
  retried = false
): Promise<T> {
  const headers = { ...(init.headers ?? {}) }
  headers.Authorization = `Bearer ${session.accessToken}`
  let res
  try {
    res = await apiFetch(`${session.baseUrl.replace(/\/+$/, '')}${path}`, {
      method: init.method,
      headers,
      body: init.body,
      formFields: init.formFields,
      formFiles: init.formFiles
    })
  } catch (err) {
    void window.noey.log.write(
      'videosLocalApi',
      `fetch failed ${session.baseUrl}${path}: ${String(err)}`
    )
    throw new ApiError(0, 'เชื่อมต่อ server ไม่ได้ ลองใหม่อีกครั้ง')
  }

  if (res.status === 401 && !retried) {
    const pair = await refresh(session.baseUrl, session.refreshToken)
    session.accessToken = pair.access_token
    session.refreshToken = pair.refresh_token
    session.onTokens?.(pair.access_token, pair.refresh_token)
    return request<T>(session, path, init, true)
  }

  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const body = res.json() as { detail?: string }
      if (typeof body?.detail === 'string') detail = body.detail
    } catch {
      /* non-JSON body */
    }
    throw new ApiError(res.status, detail)
  }
  if (res.status === 204) return undefined as T
  return res.json() as T
}

export function createLocalProject(
  session: ApiSession,
  body: CreateLocalProjectIn
): Promise<{ uid: string }> {
  return request(session, '/videos/local', {
    method: 'POST',
    body: JSON.stringify({ mode: 'dub_first', ...body })
  })
}

/** Upload frame JPEGs (fetched from media:// URLs) + manifest → {job_id}. */
export async function analyzeFrames(
  session: ApiSession,
  remoteUid: string,
  localUid: string,
  entries: FrameManifestEntry[]
): Promise<{ job_id: string }> {
  const manifest = entries.map((e) => ({
    name: e.name,
    clip_id: e.clip_id,
    time: e.time,
    scene_idx: e.scene_idx,
    scene_start: e.scene_start,
    scene_end: e.scene_end,
    ...(e.edge ? { edge: e.edge } : {})
  }))
  return request(session, `/videos/${remoteUid}/analyze-frames`, {
    method: 'POST',
    formFields: { manifest: JSON.stringify(manifest) },
    formFiles: await Promise.all(
      entries.map(async (entry) => ({
        field: 'files',
        path: await window.noey.projects.resolvePath(localUid, entry.file),
        filename: entry.name
      }))
    )
  })
}

/** Upload per-clip proxy MP4s (fetched from media:// URLs) + manifest → {job_id}. */
export async function analyzeVideo(
  session: ApiSession,
  remoteUid: string,
  localUid: string,
  proxies: ProxyManifestEntry[]
): Promise<{ job_id: string }> {
  const manifest = proxies.map((e) => ({
    clip_id: e.clip_id,
    file: e.file,
    durationSec: e.durationSec,
    order: e.order
  }))
  return request(session, `/videos/${remoteUid}/analyze-video`, {
    method: 'POST',
    formFields: { manifest: JSON.stringify(manifest) },
    formFiles: await Promise.all(
      proxies.map(async (entry) => ({
        field: 'files',
        path: await window.noey.projects.resolvePath(localUid, `proxy/${entry.file}`),
        filename: entry.file
      }))
    )
  })
}

export function getJob(session: ApiSession, jobId: string): Promise<JobStatus> {
  return request(session, `/jobs/${jobId}`)
}

/** Poll a job until it finishes; onTick receives every snapshot. */
export async function pollJob(
  session: ApiSession,
  jobId: string,
  onTick: (status: JobStatus) => void,
  { intervalMs = 2000, signal }: { intervalMs?: number; signal?: AbortSignal } = {}
): Promise<JobStatus> {
  for (;;) {
    if (signal?.aborted) throw new ApiError(0, 'ยกเลิกแล้ว')
    const status = await getJob(session, jobId)
    onTick(status)
    if (status.status === 'ok') return status
    if (status.status === 'error') throw new ApiError(500, status.error ?? 'job ล้มเหลว')
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

export function getEditScript(session: ApiSession, remoteUid: string): Promise<DubEditScript> {
  return request(session, `/videos/${remoteUid}/edit-script`)
}

export function planDub(
  session: ApiSession,
  remoteUid: string,
  voDurationSec: number,
  clipDurations: number[]
): Promise<DubTimeline> {
  return request(session, `/videos/${remoteUid}/plan-dub`, {
    method: 'POST',
    body: JSON.stringify({ voDurationSec, clipDurations })
  })
}

/** Stop an in-progress server-side job (Whisper / Gemini / analyze). */
export function cancelRemoteProject(
  session: ApiSession,
  remoteUid: string
): Promise<{ uid: string; status: string }> {
  return request(session, `/videos/${remoteUid}/cancel`, { method: 'POST' })
}

export function patchLocalStatus(
  session: ApiSession,
  remoteUid: string,
  status: 'processing' | 'waiting_vo' | 'done' | 'error',
  errorMsg?: string
): Promise<{ uid: string; status: string }> {
  return request(session, `/videos/${remoteUid}/local-status`, {
    method: 'PATCH',
    body: JSON.stringify({ status, error_msg: errorMsg ?? null })
  })
}

/** talking_head: upload the locally-extracted speech WAVs (+ optional downscaled
 *  proxy clips, WITH audio, for Gemini's per-clip video review) → {job_id}. */
export async function uploadAudio(
  session: ApiSession,
  remoteUid: string,
  localUid: string,
  wavFiles: { file: string; name: string }[],
  proxyVideoFiles?: { file: string; name: string }[]
): Promise<{ job_id: string }> {
  const formFiles: { field: string; path: string; filename: string }[] = []
  for (const wav of wavFiles) {
    formFiles.push({
      field: 'files',
      path: await window.noey.projects.resolvePath(localUid, wav.file),
      filename: wav.name
    })
  }
  for (const video of proxyVideoFiles ?? []) {
    try {
      formFiles.push({
        field: 'video_files',
        path: await window.noey.projects.resolvePath(localUid, video.file),
        filename: video.name
      })
    } catch (err) {
      void window.noey.log.write(
        'videosLocalApi',
        `proxy video resolve failed ${video.file}: ${String(err)}`
      )
    }
  }
  return request(session, `/videos/${remoteUid}/transcribe-audio`, {
    method: 'POST',
    formFiles
  })
}

export interface MusicBeats {
  tempo: number
  beats: number[]
  durationSec: number
}

/** dub_first: upload a music track (or a video to extract audio from) so the
 *  AI cut-decision steps can align scene changes to the beat. `localPath` is
 *  the absolute path the user picked — the server only keeps this copy for
 *  librosa analysis; render-time playback uses the local file directly. */
export function uploadMusic(
  session: ApiSession,
  remoteUid: string,
  localPath: string
): Promise<MusicBeats> {
  return request(session, `/videos/${remoteUid}/music`, {
    method: 'POST',
    formFiles: [{ field: 'file', path: localPath, filename: localPath.split(/[/\\]/).pop() }]
  })
}

export async function deleteMusic(session: ApiSession, remoteUid: string): Promise<void> {
  await request<void>(session, `/videos/${remoteUid}/music`, { method: 'DELETE' })
}

export function getLocalTimeline(session: ApiSession, remoteUid: string): Promise<DubTimeline> {
  return request(session, `/videos/${remoteUid}/local-timeline`)
}

export function putLocalTimeline(
  session: ApiSession,
  remoteUid: string,
  timeline: DubTimeline
): Promise<{ uid: string; cuts: number }> {
  return request(session, `/videos/${remoteUid}/local-timeline`, {
    method: 'PUT',
    body: JSON.stringify(timeline)
  })
}

/** Delete the server-side project record (best-effort; 404 = already gone). */
export async function deleteRemote(session: ApiSession, remoteUid: string): Promise<void> {
  try {
    await request<void>(session, `/videos/${remoteUid}`, { method: 'DELETE' })
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return
    throw e
  }
}

export function putLocalEditScript(
  session: ApiSession,
  remoteUid: string,
  editScript: DubEditScript
): Promise<{ uid: string; segments: number }> {
  return request(session, `/videos/${remoteUid}/local-edit-script`, {
    method: 'PUT',
    body: JSON.stringify(editScript)
  })
}

/** dub_first: AI-assisted re-edit. `previewPath` is the freshly-rendered live-editor
 *  silent preview (absolute path, from sidecar.renderAiPreview) — uploaded fresh
 *  every call so the AI always reviews exactly what's on screen right now.
 *  `selectedLineIds` empty = whole-script scope (see DUB_REEDIT_SYSTEM_VIDEO). */
export function reeditDubScenes(
  session: ApiSession,
  remoteUid: string,
  previewPath: string,
  { selectedLineIds, instruction }: { selectedLineIds: number[]; instruction: string }
): Promise<{ job_id: string }> {
  return request(session, `/videos/${remoteUid}/reedit-dub-scenes`, {
    method: 'POST',
    formFields: { manifest: JSON.stringify({ selectedLineIds, instruction }) },
    formFiles: [{ field: 'preview', path: previewPath, filename: 'edited_preview.mp4' }]
  })
}
