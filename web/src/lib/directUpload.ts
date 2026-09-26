/**
 * Uploading a project file straight into the bucket.
 *
 * WEB ONLY.
 *
 * `pushProjectFiles` used to PUT every file to the API, which forwarded it to
 * the bucket — every byte crossed the API host's network link twice, and that
 * link (~110 MB/s shared by everyone, measured 2026-09-23) was the ceiling on
 * how many people could sync a clip at once. The standard shape: the API signs
 * a URL (`POST /videos/{uid}/uploads`), the browser PUTs the bytes to the
 * bucket itself, and the API is told when it landed (`…/uploads/complete`) so
 * it can check the real size against the plan.
 *
 * The old route stays as the fallback: a deploy with no bucket answers 409
 * `direct_upload_unavailable`, and a browser whose PUT to the bucket fails
 * outright (a CORS gap, a corporate proxy that blocks the host) falls back for
 * the rest of the session rather than failing every file the same way.
 */

import { ApiError } from './api'
import { authedFetch, serverMessage } from './authedFetch'
import type { ApiSession } from './videosLocalApi'

export interface DirectUploadTicket {
  url: string
  method: string
  headers: Record<string, string>
  expires_in: number
}

/** Why a direct upload was not used, for the log line. */
export type DirectUploadSkip = 'unavailable' | 'blocked'

let blockedThisSession = false

/** Test seam: forget that the bucket was unreachable. */
export function resetDirectUploadState(): void {
  blockedThisSession = false
}

/**
 * Ask the API to sign a PUT for `path`. Null when this deploy has no bucket —
 * the caller then uses the API route. Any other refusal (a full plan, a bad
 * path, a project that is not the user's) is the same error the API route
 * would give and is thrown as such.
 */
export async function requestDirectUpload(
  session: ApiSession,
  remoteUid: string,
  path: string,
  file: File,
  signal?: AbortSignal
): Promise<DirectUploadTicket | null> {
  if (blockedThisSession) return null
  const res = await authedFetch(session, `/videos/${remoteUid}/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, bytes: file.size, content_type: file.type || '' }),
    signal
  })
  if (res.status === 409) return null
  if (!res.ok) throw new ApiError(res.status, await serverMessage(res, `อัปโหลด ${path} ไม่สำเร็จ`))
  return (await res.json()) as DirectUploadTicket
}

/**
 * PUT the bytes to the bucket with the signed ticket. Resolves to false when
 * the bucket itself could not be reached (a network-level failure, which is
 * what a missing CORS rule looks like from here) — the caller falls back to
 * the API route and no later file in this session tries the bucket again. A
 * bucket that ANSWERED with an error is thrown: that is a signed-URL problem
 * (expired, wrong header), and retrying through the API hides it.
 */
export async function putToBucket(
  ticket: DirectUploadTicket,
  file: File,
  signal?: AbortSignal
): Promise<boolean> {
  let res: Response
  try {
    res = await fetch(ticket.url, {
      method: ticket.method || 'PUT',
      headers: ticket.headers,
      body: file,
      signal,
      // The bucket is another origin; nothing of ours (cookies, the bearer
      // token) belongs on the request.
      credentials: 'omit',
      mode: 'cors'
    })
  } catch (err) {
    if (signal?.aborted) throw err
    blockedThisSession = true
    return false
  }
  if (!res.ok)
    throw new ApiError(res.status, `อัปโหลดไปยังที่เก็บไฟล์ไม่สำเร็จ (HTTP ${res.status})`)
  return true
}

/** Tell the API the object landed; it answers with the size it measured. */
export async function completeDirectUpload(
  session: ApiSession,
  remoteUid: string,
  path: string,
  signal?: AbortSignal
): Promise<{ path: string; bytes: number }> {
  const res = await authedFetch(session, `/videos/${remoteUid}/uploads/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
    signal
  })
  if (!res.ok)
    throw new ApiError(res.status, await serverMessage(res, `ยืนยันอัปโหลด ${path} ไม่สำเร็จ`))
  return (await res.json()) as { path: string; bytes: number }
}

/**
 * Upload one file, straight to the bucket when the server offers it.
 * Returns how it went: `direct`, or the reason the API route was used.
 */
export async function uploadDirect(
  session: ApiSession,
  remoteUid: string,
  path: string,
  file: File,
  signal?: AbortSignal
): Promise<'direct' | DirectUploadSkip> {
  const ticket = await requestDirectUpload(session, remoteUid, path, file, signal)
  if (!ticket) return blockedThisSession ? 'blocked' : 'unavailable'
  if (!(await putToBucket(ticket, file, signal))) return 'blocked'
  await completeDirectUpload(session, remoteUid, path, signal)
  return 'direct'
}
