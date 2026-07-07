import { protocol } from 'electron'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { Readable } from 'stream'
import { mediaPathForUrl } from './mediaPath'
import { projectsRoot } from './projects'

/**
 * `media://` — serves local project files to the renderer for <video> preview
 * and filmstrip canvas capture, without disabling webSecurity.
 *
 * URL shape: media://project/<uid>/<relative/path/inside/project>
 * Restricted to files under userData/projects (path-traversal safe).
 *
 * Range requests are handled manually (206 Partial Content + Content-Range):
 * `net.fetch()` on a `file://` URL does NOT honor Range headers — it always
 * returns the full file with a plain 200 — which silently breaks <video>
 * seeking (confirmed via a standalone Electron test harness, 2026-07-07).
 * Chromium's media pipeline needs a real 206 response to seek; without it,
 * currentTime assignments are ignored and playback just continues from
 * wherever it already was.
 */

/** Must run BEFORE app.whenReady(). */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'media',
      privileges: {
        standard: true,
        secure: true,
        stream: true,
        supportFetchAPI: true,
        corsEnabled: true,
        bypassCSP: false
      }
    }
  ])
}

function parseRange(
  rangeHeader: string | null,
  size: number
): { start: number; end: number } | null {
  if (!rangeHeader) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
  if (!match) return null
  const [, startStr, endStr] = match
  let start = startStr ? parseInt(startStr, 10) : NaN
  let end = endStr ? parseInt(endStr, 10) : size - 1
  if (Number.isNaN(start)) {
    // Suffix range, e.g. "bytes=-500" — last 500 bytes.
    const suffixLen = endStr ? parseInt(endStr, 10) : 0
    start = Math.max(size - suffixLen, 0)
    end = size - 1
  }
  end = Math.min(end, size - 1)
  if (start > end || start < 0) return null
  return { start, end }
}

/** Call inside app.whenReady(). */
export function registerMediaProtocol(): void {
  protocol.handle('media', async (request) => {
    const abs = mediaPathForUrl(request.url, projectsRoot())
    if (!abs) return new Response('not found', { status: 404 })

    let size: number
    try {
      size = (await stat(abs)).size
    } catch {
      return new Response('not found', { status: 404 })
    }

    const range = parseRange(request.headers.get('range'), size)
    if (!range) {
      const body = Readable.toWeb(createReadStream(abs)) as ReadableStream
      return new Response(body, {
        status: 200,
        headers: { 'Content-Length': String(size), 'Accept-Ranges': 'bytes' }
      })
    }

    const { start, end } = range
    const body = Readable.toWeb(createReadStream(abs, { start, end })) as ReadableStream
    return new Response(body, {
      status: 206,
      headers: {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes'
      }
    })
  })
}
