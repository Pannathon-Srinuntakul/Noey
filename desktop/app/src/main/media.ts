import { net, protocol } from 'electron'
import { pathToFileURL } from 'url'
import { mediaPathForUrl } from './mediaPath'
import { projectsRoot } from './projects'

/**
 * `media://` — serves local project files to the renderer for <video> preview
 * and filmstrip canvas capture, without disabling webSecurity.
 *
 * URL shape: media://project/<uid>/<relative/path/inside/project>
 * Restricted to files under userData/projects (path-traversal safe).
 * net.fetch over file:// handles Range requests, so <video> seeking works.
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
        bypassCSP: false
      }
    }
  ])
}

/** Call inside app.whenReady(). */
export function registerMediaProtocol(): void {
  protocol.handle('media', (request) => {
    const abs = mediaPathForUrl(request.url, projectsRoot())
    if (!abs) return new Response('not found', { status: 404 })
    return net.fetch(pathToFileURL(abs).toString(), {
      headers: request.headers // forward Range for video seeking
    })
  })
}
