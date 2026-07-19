import { app, protocol } from 'electron'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { join } from 'path'
import { Readable } from 'stream'
import { libraryPathForUrl, mediaPathForUrl } from './mediaPath'
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

const MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac'
}

/** Chromium's <video> tag sniffs MP4 well enough without a Content-Type, but
 * <audio> with non-container formats (mp3/wav/...) needs an explicit one or
 * it silently refuses to play — no error, just stays paused forever. */
function mimeTypeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
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
    const abs =
      mediaPathForUrl(request.url, projectsRoot()) ??
      libraryPathForUrl(request.url, join(app.getPath('userData'), 'effects-library'))
    if (!abs) return new Response('not found', { status: 404 })

    let size: number
    try {
      size = (await stat(abs)).size
    } catch {
      return new Response('not found', { status: 404 })
    }

    const contentType = mimeTypeFor(abs)
    const range = parseRange(request.headers.get('range'), size)
    if (!range) {
      const body = Readable.toWeb(createReadStream(abs)) as ReadableStream
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Length': String(size),
          'Accept-Ranges': 'bytes',
          'Content-Type': contentType
        }
      })
    }

    const { start, end } = range
    const body = Readable.toWeb(createReadStream(abs, { start, end })) as ReadableStream
    return new Response(body, {
      status: 206,
      headers: {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes',
        'Content-Type': contentType
      }
    })
  })
}
