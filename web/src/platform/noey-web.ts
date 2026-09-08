/**
 * `window.noey` for the browser.
 *
 * Imported first from `main.tsx`, before React mounts, because the copied UI
 * reaches for `window.noey` during module evaluation in places.
 *
 * `NoeyApi` is exported as `typeof noey` rather than hand-written: anything the
 * UI calls that this file does not provide then fails to compile, instead of
 * throwing on a screen someone opens three weeks later.
 */

import { sidecar } from '../engine'
// Importing this registers every implemented job with the engine.
import '../engine/jobs'
import { apiFetch } from './api'
import { app, auth, log, notify, prefs, taste } from './misc'
import * as projectStore from './projects'
import { readFile, storageIsPersisted, storageUsage } from './fs'
import { getPicked, registerPicked } from './picked'
import type { LocalProject, StorageReport } from './types'

/** `/media/<uid>/<rel>` — the service worker's route. Shape mirrors the
 * desktop's `media://project/<uid>/<rel>`, including the per-segment encode. */
function mediaUrlFor(uid: string, relPath: string): string {
  const rel = relPath.split(/[\\/]/).filter(Boolean).map(encodeURIComponent).join('/')
  return `/media/${encodeURIComponent(uid)}/${rel}`
}

const noey = {
  /**
   * Deliberately typed `string`, not the literal `'web'`: the shared UI
   * compares this against `'darwin'` / `'win32'` to decide whether to reserve
   * room for OS window chrome. Narrowing it would make those comparisons a
   * compile error in components that are otherwise identical on both builds —
   * as `string` they simply evaluate false, which is the right answer here.
   */
  platform: 'web' as string,

  sidecar,

  projects: {
    list: (): Promise<LocalProject[]> => projectStore.list(),
    get: (uid: string): Promise<LocalProject | null> => projectStore.get(uid),
    create: (init: Partial<LocalProject> & { name: string }): Promise<LocalProject> =>
      projectStore.create(init),
    update: (uid: string, patch: Partial<LocalProject>): Promise<LocalProject> =>
      projectStore.update(uid, patch),
    delete: (uid: string): Promise<void> => projectStore.remove(uid),
    onChanged: (cb: () => void): (() => void) => projectStore.onChanged(cb),
    dir: async (uid: string): Promise<string> => projectStore.dir(uid),
    resolvePath: async (uid: string, relPath: string): Promise<string> =>
      projectStore.resolvePath(uid, relPath),
    writeFile: (uid: string, relPath: string, data: Uint8Array): Promise<string> =>
      projectStore.writeFile(uid, relPath, data),
    deleteFile: (uid: string, relPath: string): Promise<void> =>
      projectStore.removeFile(uid, relPath),
    importMusic: (uid: string, srcPath: string): Promise<string> =>
      projectStore.importMusic(uid, srcPath),
    stashRender: (uid: string): Promise<string[]> => projectStore.stashRender(uid),
    restoreRender: (uid: string): Promise<void> => projectStore.restoreRender(uid),

    /**
     * Hand one file to the browser's download flow.
     *
     * The desktop opens a native save dialog and returns the chosen path; here
     * the browser decides where downloads go, so the returned string is a label
     * for the confirmation message rather than a real location.
     */
    exportFile: async (
      uid: string,
      relPath: string,
      suggestedName: string
    ): Promise<string | null> => {
      const url = mediaUrlFor(uid, relPath)
      const res = await fetch(url)
      if (!res.ok) throw new Error(`ไม่พบไฟล์ ${relPath}`)
      const blob = await res.blob()
      const href = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = href
      a.download = suggestedName
      document.body.appendChild(a)
      a.click()
      a.remove()
      // Revoke on the next tick — Safari cancels an in-flight download if the
      // object URL disappears synchronously.
      setTimeout(() => URL.revokeObjectURL(href), 60_000)
      return 'โฟลเดอร์ดาวน์โหลด'
    },

    exportArtifacts: async (
      uid: string,
      fileIds: string[],
      projectName: string
    ): Promise<{ dir: string; files: number } | null> => {
      const { zipSync } = await import('fflate')
      const chosen = (await projectStore.artifacts(uid)).filter((a) => fileIds.includes(a.id))
      if (chosen.length === 0) return null

      if (chosen.length === 1) {
        const only = chosen[0]
        await noey.projects.exportFile(uid, only.id, only.name)
        return { dir: 'โฟลเดอร์ดาวน์โหลด', files: 1 }
      }

      const entries: Record<string, Uint8Array> = {}
      for (const a of chosen) {
        const res = await fetch(mediaUrlFor(uid, a.id))
        if (!res.ok) continue
        entries[a.name] = new Uint8Array(await res.arrayBuffer())
      }
      const safeName = projectName.replace(/[\\/:*?"<>|]/g, '_') || 'project'
      const zipped = zipSync(entries)
      const blob = new Blob([zipped as unknown as BlobPart], { type: 'application/zip' })
      const href = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = href
      a.download = `${safeName}.zip`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(href), 60_000)
      return { dir: 'โฟลเดอร์ดาวน์โหลด', files: Object.keys(entries).length }
    },

    /** No filesystem to reveal in a browser. Same signature as the desktop's
     * so the call sites stay shared. */

    openFolder: async (_uid: string, _relPath?: string): Promise<void> => undefined
  },

  media: {
    urlFor: mediaUrlFor
    // `inboxUrlFor` is gone. It built `/media/inbox/<name>`, which the service
    // worker resolves against `projects/inbox/<name>` — a directory that has
    // never existed — so it 404'd by construction. Its only caller was the
    // path-only branch of ClipThumbnail, reachable solely from a wizard route
    // parameter nothing passes.
  },

  /**
   * The export screen lists what a project has to offer. On desktop this lives
   * in the LAN module, which is where the namespace name comes from.
   *
   * `artifacts` is the ONLY member. The other eleven were throw-stubs for a
   * phone-transfer flow this build hides, and nothing ever called one — a
   * namespace full of stubs is a feature list, and this build does not have
   * those features.
   */
  lan: {
    artifacts: (projectUid: string) => projectStore.artifacts(projectUid)
  },

  storage: {
    report: async (): Promise<StorageReport> => {
      const { usage } = await storageUsage()
      const projects = await projectStore.list()
      return {
        root: 'ที่เก็บของเบราว์เซอร์',
        isDefault: true,
        totalBytes: usage,
        projectCount: projects.length,
        persisted: await storageIsPersisted()
      }
    },

    /** Delete every project. Web only — the desktop opens a folder instead. */
    clearAll: (): Promise<number> => projectStore.removeAll()
  },

  auth,
  prefs,
  log,
  notify,
  app,
  taste,

  api: { fetch: apiFetch },

  /** Register a `File` the user just picked and get back an id the UI carries
   * exactly where the desktop carries an OS path. */
  pick: {
    register: registerPicked,
    /**
     * The bytes behind a pending source, whichever scheme it uses.
     *
     * The import stage needs them to hand an undecodable clip to the server's
     * converter, and it holds a path — `picked://` for a file the user just
     * chose, `noeyfs://` for one already staged into the store.
     */
    read: async (path: string): Promise<Blob> => {
      const picked = getPicked(path)
      if (picked) return picked
      const stored = await readFile(path)
      if (!stored) throw new Error(`ไม่พบไฟล์ ${path}`)
      return stored
    }
  }
}

export type NoeyApi = typeof noey

declare global {
  interface Window {
    noey: NoeyApi
  }
}

window.noey = noey

export default noey
