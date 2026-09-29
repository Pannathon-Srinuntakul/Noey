import { app, ipcMain } from 'electron'
import { join } from 'path'
import { readFile, writeFile } from 'fs/promises'
import { FileGrants } from './ipcGuards'

/**
 * The files the user handed the app on purpose — see `FileGrants`.
 *
 * Filled by the preload, and only from `webUtils.getPathForFile` on a real
 * `File` the user picked or dropped (a script-made `File` has no path). The
 * renderer has no direct way to add a path: the grant channel is not exposed.
 *
 * Persisted because an import survives an app restart: `pendingMusic.path` is
 * re-read from project.json and copied in after the restart, and the grant
 * has to still be there. Only main writes this file.
 */
export const fileGrants = new FileGrants(process.platform === 'win32')

function grantsFile(): string {
  return join(app.getPath('userData'), 'file-grants.json')
}

let persistQueue: Promise<void> = Promise.resolve()

function persist(): void {
  const body = JSON.stringify(fileGrants.list())
  persistQueue = persistQueue
    .catch(() => undefined)
    .then(() => writeFile(grantsFile(), body, 'utf-8'))
    .catch(() => undefined)
}

export async function loadFileGrants(): Promise<void> {
  try {
    const list = JSON.parse(await readFile(grantsFile(), 'utf-8')) as unknown
    if (Array.isArray(list)) for (const p of list) if (typeof p === 'string') fileGrants.add(p)
  } catch {
    // first run, or an unreadable file — start empty
  }
}

export function registerFileGrantsIpc(): void {
  // Synchronous so the grant is in place before the caller's next IPC call
  // (an upload or import of the same path) can reach main.
  ipcMain.on('files:grant', (evt, path: unknown) => {
    const added = typeof path === 'string' && fileGrants.add(path)
    if (added) persist()
    evt.returnValue = added
  })
}
