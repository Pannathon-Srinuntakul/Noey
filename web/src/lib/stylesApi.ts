/** Client for the effect-styles backend endpoints (/effect-styles).
 * A "style" is a reusable, per-user AI editing style: the user describes a look
 * and/or uploads a reference clip once in the Studio, a distillation job turns
 * it into stored prose, and the effects editor reuses it on every run instead
 * of re-uploading a reference video. Mirrors effectsLocalApi's request/session
 * conventions. */

import type { ApiSession } from './videosLocalApi'
import { apiFetch } from './httpClient'
import { ApiError, connectErrorMessage, refresh, errorFromResponse } from './api'

export interface StyleSummary {
  uid: string
  name: string
  status: 'pending' | 'ready' | 'error'
  has_reference: boolean
  updated_at: string
  /** 'effects' = zoom/camera-motion style (สไตล์การซูม — the value predates
   * the R8 rename and stays 'effects' so no data migration is needed);
   * 'cut' = cut/editing-rhythm style (สไตล์การตัด). */
  kind: 'effects' | 'cut'
  /** Target platform for cut styles ('tiktok' | 'reels' | ...); null for effects. */
  target_platform: string | null
}

export interface StyleDetail extends StyleSummary {
  description: string | null
  system_prompt: string | null
  error_msg: string | null
}

/** When the overlay half of the effects system was removed (R8). A zoom style
 * distilled before this moment was taught against components that no longer
 * exist — its prose steers the AI toward overlays the renderer cannot draw. */
const EFFECTS_STYLE_CUTOVER = Date.parse('2026-08-12T00:00:00+07:00')

/** True for a kind='effects' style whose prose predates the R8 cutover — the
 * UI marks these "ต้องเรียนรู้ใหม่" and keeps them out of style pickers
 * instead of letting a stale overlay-era prompt run (R8 §9). */
export function isLegacyEffectsStyle(style: {
  kind: 'effects' | 'cut'
  status: 'pending' | 'ready' | 'error'
  updated_at: string
}): boolean {
  if (style.kind !== 'effects' || style.status !== 'ready') return false
  const t = Date.parse(style.updated_at)
  return Number.isFinite(t) && t < EFFECTS_STYLE_CUTOVER
}

async function request<T>(
  session: ApiSession,
  path: string,
  init: {
    method?: string
    formFields?: Record<string, string>
    formFiles?: { field: string; path: string; filename?: string }[]
    body?: string
    headers?: Record<string, string>
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
      'stylesApi',
      `fetch failed ${session.baseUrl}${path}: ${String(err)}`
    )
    throw new ApiError(0, connectErrorMessage(err))
  }

  if (res.status === 401 && !retried) {
    const pair = await refresh(session.baseUrl, session.refreshToken)
    session.accessToken = pair.access_token
    session.refreshToken = pair.refresh_token
    session.onTokens?.(pair.access_token, pair.refresh_token)
    return request<T>(session, path, init, true)
  }

  if (!res.ok) throw errorFromResponse(res)
  if (res.status === 204) return undefined as T
  return res.json() as T
}

/** List the user's saved styles (newest first), optionally filtered by kind. */
export function listStyles(session: ApiSession, kind?: 'effects' | 'cut'): Promise<StyleSummary[]> {
  const query = kind ? `?kind=${encodeURIComponent(kind)}` : ''
  return request(session, `/effect-styles${query}`, { method: 'GET' })
}

/** Fetch one style incl. its distilled system_prompt (for display/editing). */
export function getStyle(session: ApiSession, uid: string): Promise<StyleDetail> {
  return request(session, `/effect-styles/${uid}`, { method: 'GET' })
}

/** Create a style from a name + description and/or a reference clip; returns
 * the new style uid + the distillation job_id to poll. For kind='cut' the
 * backend requires a video reference (≤5 min) and accepts a target platform. */
export function createStyle(
  session: ApiSession,
  opts: {
    name: string
    description: string
    referencePath?: string
    kind?: 'effects' | 'cut'
    targetPlatform?: string
  }
): Promise<{ style_uid: string; job_id: string }> {
  const formFiles = opts.referencePath
    ? [
        {
          field: 'reference',
          path: opts.referencePath,
          filename: opts.referencePath.split(/[\\/]/).pop()
        }
      ]
    : []
  return request(session, '/effect-styles', {
    method: 'POST',
    formFields: {
      name: opts.name,
      description: opts.description,
      kind: opts.kind ?? 'effects',
      target_platform: opts.targetPlatform ?? ''
    },
    formFiles
  })
}

/** Rename / hand-edit a style's description or distilled prompt. */
export function updateStyle(
  session: ApiSession,
  uid: string,
  patch: { name?: string; description?: string; system_prompt?: string }
): Promise<StyleDetail> {
  return request(session, `/effect-styles/${uid}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch)
  })
}

/** Re-run distillation for an existing style; returns a fresh job_id to poll. */
export function regenerateStyle(
  session: ApiSession,
  uid: string
): Promise<{ style_uid: string; job_id: string }> {
  return request(session, `/effect-styles/${uid}/regenerate`, { method: 'POST' })
}

export function deleteStyle(session: ApiSession, uid: string): Promise<void> {
  return request(session, `/effect-styles/${uid}`, { method: 'DELETE' })
}
