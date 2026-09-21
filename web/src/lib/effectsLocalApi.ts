/** Client for the camera-motion backend endpoints (/videos/{uid}/plan-effects,
 * GET/PUT /videos/{uid}/effects). Mirrors videosLocalApi's request/session
 * conventions. The cut video never leaves the machine at full res — only a
 * downscaled proxy (effects/cut_proxy.mp4) is uploaded for the AI to watch. */

import type { ApiSession } from './videosLocalApi'
import { apiFetch } from './httpClient'
import { ApiError, connectErrorMessage, refresh } from './api'
import { responseErrorDetail } from './apiError'
import type { EffectsDoc } from './effects'

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
      'effectsLocalApi',
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

  if (!res.ok) throw new ApiError(res.status, responseErrorDetail(res))
  if (res.status === 204) return undefined as T
  return res.json() as T
}

/** Upload the cut-video proxy + optional instruction + timed script, enqueue
 * the AI placement pass. `scriptText` (built by effectsScript.ts from the
 * project's edit script / caption lines) lets the AI match effects to the
 * exact spoken words, not just what's visually on screen.
 *
 * `referencePath` — an OPTIONAL local video/image the AI takes camera-motion
 * inspiration from only (never copies its literal content), for this run only.
 *
 * `usePrevious` — false (default) is a genuinely fresh placement pass, ignoring
 * any effects.json already on the server. true sends the existing effects.json
 * as `<previous_attempt>` so the model produces a deliberately different take
 * (the "แก้ไข AI" edit button, as opposed to the fresh "ให้ AI จัดทั้งคลิป" one). */
export async function planEffects(
  session: ApiSession,
  remoteUid: string,
  localUid: string,
  promptText: string,
  scriptText = '',
  referencePath?: string,
  styleUid?: string,
  cutPointsSec?: number[],
  usePrevious = false
): Promise<{ job_id: string }> {
  const formFiles: { field: string; path: string; filename?: string }[] = [
    {
      field: 'proxy',
      path: await window.noey.projects.resolvePath(localUid, 'effects/cut_proxy.mp4'),
      filename: 'cut_proxy.mp4'
    }
  ]
  if (referencePath) {
    formFiles.push({
      field: 'reference',
      path: referencePath,
      filename: referencePath.split(/[\\/]/).pop()
    })
  }
  return request(session, `/videos/${remoteUid}/plan-effects`, {
    method: 'POST',
    formFields: {
      prompt: promptText,
      script: scriptText,
      style_uid: styleUid ?? '',
      cuts: cutPointsSec?.length ? JSON.stringify(cutPointsSec) : '',
      use_previous: usePrevious ? 'true' : 'false'
    },
    formFiles
  })
}

export function getEffectsDoc(session: ApiSession, remoteUid: string): Promise<EffectsDoc> {
  return request(session, `/videos/${remoteUid}/effects`)
}

export function putEffectsDoc(
  session: ApiSession,
  remoteUid: string,
  doc: EffectsDoc
): Promise<{ uid: string; instances: number }> {
  return request(session, `/videos/${remoteUid}/effects`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(doc)
  })
}
