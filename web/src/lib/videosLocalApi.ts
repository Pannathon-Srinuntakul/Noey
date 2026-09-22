/** Client for the backend local-render endpoints (/videos/local + friends).
 *
 * All functions take an ApiSession; on 401 they refresh once and retry, and
 * report the renewed tokens via onTokens so the caller can persist them.
 */

import { ApiError, connectErrorMessage, errorFromResponse, refresh } from './api'
import { apiFetch } from './httpClient'
import {
  isWaitingSlot,
  jobStopRefusal,
  refusalMessage,
  type EstimateRequest,
  type UsageEstimate
} from './usageLimits'

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
  mode?: 'dub_first' | 'talking_head' | 'highlight' | 'speech_highlights' | 'speech_scenes'
  brief?: string | null
  user_script?: string | null
  target_duration_sec?: number | null
  clips: ClipMetaIn[]
  caption_style?: CaptionStyleIn | null
  /** AI quality tiers (see backend packages/video/quality.py). */
  engine?: string | null
  precision?: string | null
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
  timeline: {
    type: string
    source: string
    in: number
    out: number
    label: string
    /** dub cuts saved by the timeline editor keep their voiceover line. */
    voiceoverLineId?: number | null
    voiceoverScript?: string | null
  }[]
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
    throw new ApiError(0, connectErrorMessage(err))
  }

  if (res.status === 401 && !retried) {
    let pair
    try {
      pair = await refresh(session.baseUrl, session.refreshToken)
    } catch {
      // The refresh token itself is dead (revoked, or expired after 14 days).
      // Nothing used to end the session here: every later call failed with an
      // English server detail and the only way out was a manual reload.
      const { emitAuthLost } = await import('./sessionBus')
      emitAuthLost()
      throw new ApiError(401, 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่')
    }
    session.accessToken = pair.access_token
    session.refreshToken = pair.refresh_token
    session.onTokens?.(pair.access_token, pair.refresh_token)
    return request<T>(session, path, init, true)
  }

  if (!res.ok) throw errorFromResponse(res)
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

// `analyzeFrames()` (POST /videos/{uid}/analyze-frames) was removed 2026-08-14
// along with the sidecar's `extract-frames`: the dub planner watches per-clip
// proxy videos now (analyzeDubVideo below), which sees motion and timing that
// still JPEGs never could. Nothing had called it since. The server route stays
// for desktop builds already installed on other machines.

/** Upload per-clip proxy MP4s (fetched from media:// URLs) + manifest → {job_id}.
 *  `styleUid` = saved cut-style (EffectStyle kind="cut") to steer the AI cut. */
export async function analyzeVideo(
  session: ApiSession,
  remoteUid: string,
  localUid: string,
  proxies: ProxyManifestEntry[],
  styleUid?: string,
  /** Replaces the brief stored server-side for this run onwards. The desktop
   * sends the original brief plus any recut comments; the row is the only way
   * the brief reaches the model, and it is otherwise written once at creation.
   * Empty is "keep what is stored" — it never blanks an existing brief. */
  brief?: string,
  /** AI quality tiers. Omitted fields mean "keep what the server stored" — a
   * re-analyze that forgets them must not silently downgrade a Pro project. */
  tiers?: { engine?: string; precision?: string },
  /** The user agreed to pay from the top-up balance if the plan's limits
   * cannot cover this run (docs/token-billing-design.md §9.3). */
  allowWallet = false
): Promise<{ job_id: string }> {
  const manifest = proxies.map((e) => ({
    clip_id: e.clip_id,
    file: e.file,
    durationSec: e.durationSec,
    order: e.order
  }))
  return request(session, `/videos/${remoteUid}/analyze-video`, {
    method: 'POST',
    formFields: {
      manifest: JSON.stringify(manifest),
      ...(styleUid ? { style_uid: styleUid } : {}),
      ...(brief?.trim() ? { brief: brief.trim() } : {}),
      ...(tiers?.engine ? { engine: tiers.engine } : {}),
      ...(tiers?.precision ? { precision: tiers.precision } : {}),
      ...walletField(allowWallet)
    },
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

/** The server's own record of a project — its status and the job running it,
 * if any. Only these two fields of `GET /videos/{uid}` are read here. */
export function getRemoteStatus(
  session: ApiSession,
  remoteUid: string
): Promise<{ status: string; job_id: string | null }> {
  return request(session, `/videos/${remoteUid}`)
}

/** Poll a job until it finishes; onTick receives every snapshot. */
export async function pollJob(
  session: ApiSession,
  jobId: string,
  onTick: (status: JobStatus) => void,
  {
    intervalMs = 2000,
    signal,
    queuedStallMs = 180_000
  }: { intervalMs?: number; signal?: AbortSignal; queuedStallMs?: number } = {}
): Promise<JobStatus> {
  // A job that is enqueued but never claimed used to poll forever: the card sat
  // on the same step with the same message for as long as the app was open,
  // with nothing anywhere saying why (live 2026-08-13 — the arq worker had
  // wedged, four jobs queued, none running). Waiting is normal; waiting
  // FOREVER is a failure, and it belongs on the card like any other.
  let lastMovementAt = Date.now()
  let lastProgress = -1
  for (;;) {
    if (signal?.aborted) throw new ApiError(0, 'ยกเลิกแล้ว')
    const status = await getJob(session, jobId)
    onTick(status)
    if (status.status === 'ok') return status
    if (status.status === 'error') {
      // A run the budget guard or the service pause stopped is not a crash:
      // it carries a code the UI turns into its own state (retry, reset time).
      const stopped = jobStopRefusal(status.result)
      if (stopped) throw new ApiError(402, refusalMessage(stopped), stopped)
      throw new ApiError(500, status.error ?? 'job ล้มเหลว')
    }
    // Any movement — a progress bump or leaving the queue — resets the clock;
    // a long stage is not a stall. Neither is waiting for one of the plan's
    // own job slots (`waiting_slot`): the worker is alive and re-checking.
    const waitingSlot = isWaitingSlot(status.result)
    if (status.progress !== lastProgress || status.status !== 'queued' || waitingSlot) {
      lastProgress = status.progress
      lastMovementAt = Date.now()
    }
    if (status.status === 'queued' && !waitingSlot && Date.now() - lastMovementAt > queuedStallMs) {
      throw new ApiError(503, 'ระบบกำลังมีงานค้างและยังไม่มีคิวว่าง กรุณาลองใหม่อีกครั้งในภายหลัง')
    }
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
  clipDurations: number[],
  allowWallet = false
): Promise<DubTimeline> {
  return request(session, `/videos/${remoteUid}/plan-dub`, {
    method: 'POST',
    body: JSON.stringify({
      voDurationSec,
      clipDurations,
      ...(allowWallet ? { allow_wallet: true } : {})
    })
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

/** talking_head: upload the locally-extracted speech WAVs → {job_id}.
 *  Audio only — Scribe decides every cut from word timings, so no video leaves
 *  the machine in this mode. */
export async function uploadAudio(
  session: ApiSession,
  remoteUid: string,
  localUid: string,
  wavFiles: { file: string; name: string }[],
  opts: { styleUid?: string; allowWallet?: boolean } = {}
): Promise<{ job_id: string }> {
  const formFiles: { field: string; path: string; filename: string }[] = []
  for (const wav of wavFiles) {
    formFiles.push({
      field: 'files',
      path: await window.noey.projects.resolvePath(localUid, wav.file),
      filename: wav.name
    })
  }
  return request(session, `/videos/${remoteUid}/transcribe-audio`, {
    method: 'POST',
    formFiles,
    // speech_scenes carries its saved cut style; the other speech modes send
    // nothing and the server ignores the field.
    formFields: {
      ...(opts.styleUid ? { style_uid: opts.styleUid } : {}),
      ...walletField(opts.allowWallet)
    }
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
  { selectedLineIds, instruction }: { selectedLineIds: number[]; instruction: string },
  styleUid?: string,
  allowWallet = false
): Promise<{ job_id: string }> {
  return request(session, `/videos/${remoteUid}/reedit-dub-scenes`, {
    method: 'POST',
    formFields: {
      manifest: JSON.stringify({ selectedLineIds, instruction }),
      ...(styleUid ? { style_uid: styleUid } : {}),
      ...walletField(allowWallet)
    },
    formFiles: [{ field: 'preview', path: previewPath, filename: 'edited_preview.mp4' }]
  })
}

/** Form field for `allow_wallet` — sent only when true, so a server that
 * predates the top-up wallet never sees an unknown field. */
function walletField(allowWallet: boolean | undefined): Record<string, string> {
  return allowWallet ? { allow_wallet: 'true' } : {}
}

/**
 * `POST /usage/estimate` — what a run with these clips would use, as a
 * percentage of each of the plan's limits, and whether it fits what is left
 * (`plan`), fits only with the top-up balance (`wallet`) or not at all
 * (`none`). The start routes recompute it from server-held durations; this is
 * the preview the wizard shows before anything uploads.
 */
export function estimateUsage(session: ApiSession, body: EstimateRequest): Promise<UsageEstimate> {
  return request(session, '/usage/estimate', { method: 'POST', body: JSON.stringify(body) })
}
