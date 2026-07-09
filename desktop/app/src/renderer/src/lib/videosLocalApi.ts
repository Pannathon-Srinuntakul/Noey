/** Client for the backend local-render endpoints (/videos/local + friends).
 *
 * All functions take an ApiSession; on 401 they refresh once and retry, and
 * report the renewed tokens via onTokens so the caller can persist them.
 */

import { ApiError, refresh } from './api'

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

export interface CreateLocalProjectIn {
  mode?: 'dub_first' | 'talking_head'
  brief?: string | null
  user_script?: string | null
  target_duration_sec?: number | null
  clips: ClipMetaIn[]
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
  init: RequestInit = {},
  retried = false
): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${session.accessToken}`)
  let res: Response
  try {
    res = await fetch(`${session.baseUrl.replace(/\/+$/, '')}${path}`, { ...init, headers })
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
      const body = await res.json()
      if (typeof body?.detail === 'string') detail = body.detail
    } catch {
      /* non-JSON body */
    }
    throw new ApiError(res.status, detail)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export function createLocalProject(
  session: ApiSession,
  body: CreateLocalProjectIn
): Promise<{ uid: string }> {
  return request(session, '/videos/local', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
  const form = new FormData()
  for (const entry of entries) {
    const mediaUrl = window.noey.media.urlFor(localUid, entry.file)
    let blob: Blob
    try {
      blob = await (await fetch(mediaUrl)).blob()
    } catch (err) {
      void window.noey.log.write('videosLocalApi', `frame read failed ${mediaUrl}: ${String(err)}`)
      throw new ApiError(0, `อ่านไฟล์ frame ไม่ได้: ${entry.name}`)
    }
    form.append('files', blob, entry.name)
  }
  const manifest = entries.map((e) => ({
    name: e.name,
    clip_id: e.clip_id,
    time: e.time,
    scene_idx: e.scene_idx,
    scene_start: e.scene_start,
    scene_end: e.scene_end,
    ...(e.edge ? { edge: e.edge } : {})
  }))
  form.append('manifest', JSON.stringify(manifest))
  return request(session, `/videos/${remoteUid}/analyze-frames`, { method: 'POST', body: form })
}

/** Upload per-clip proxy MP4s (fetched from media:// URLs) + manifest → {job_id}. */
export async function analyzeVideo(
  session: ApiSession,
  remoteUid: string,
  localUid: string,
  proxies: ProxyManifestEntry[]
): Promise<{ job_id: string }> {
  const form = new FormData()
  for (const entry of proxies) {
    const mediaUrl = window.noey.media.urlFor(localUid, `proxy/${entry.file}`)
    let blob: Blob
    try {
      blob = await (await fetch(mediaUrl)).blob()
    } catch (err) {
      void window.noey.log.write('videosLocalApi', `proxy read failed ${mediaUrl}: ${String(err)}`)
      throw new ApiError(0, `อ่านไฟล์วิดีโอไม่ได้: ${entry.file}`)
    }
    form.append('files', blob, entry.file)
  }
  const manifest = proxies.map((e) => ({
    clip_id: e.clip_id,
    file: e.file,
    durationSec: e.durationSec,
    order: e.order
  }))
  form.append('manifest', JSON.stringify(manifest))
  return request(session, `/videos/${remoteUid}/analyze-video`, { method: 'POST', body: form })
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voDurationSec, clipDurations })
  })
}

export function patchLocalStatus(
  session: ApiSession,
  remoteUid: string,
  status: 'processing' | 'waiting_vo' | 'done' | 'error',
  errorMsg?: string
): Promise<{ uid: string; status: string }> {
  return request(session, `/videos/${remoteUid}/local-status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
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
  const form = new FormData()
  for (const wav of wavFiles) {
    const mediaUrl = window.noey.media.urlFor(localUid, wav.file)
    let blob: Blob
    try {
      blob = await (await fetch(mediaUrl)).blob()
    } catch (err) {
      void window.noey.log.write('videosLocalApi', `wav read failed ${mediaUrl}: ${String(err)}`)
      throw new ApiError(0, `อ่านไฟล์เสียงไม่ได้: ${wav.name}`)
    }
    form.append('files', blob, wav.name)
  }
  // Optional: an upload/encode failure here shouldn't block transcription — just
  // falls back to code-only cuts for that clip (whisper_client.run_transcription).
  for (const video of proxyVideoFiles ?? []) {
    const mediaUrl = window.noey.media.urlFor(localUid, video.file)
    try {
      const blob = await (await fetch(mediaUrl)).blob()
      form.append('video_files', blob, video.name)
    } catch (err) {
      void window.noey.log.write(
        'videosLocalApi',
        `proxy video read failed ${mediaUrl}: ${String(err)}`
      )
    }
  }
  return request(session, `/videos/${remoteUid}/transcribe-audio`, { method: 'POST', body: form })
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
    headers: { 'Content-Type': 'application/json' },
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(editScript)
  })
}
