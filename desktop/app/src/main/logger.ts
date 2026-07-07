import { app, ipcMain, shell } from 'electron'
import { join } from 'path'
import { appendFile, mkdir } from 'fs/promises'

/** Diagnostics log — errors are shown to the user only as a generic message;
 *  the technical detail (real fetch error, URL, stack) goes here instead so
 *  support can inspect it without the app leaking internals in its UI. */
function logDir(): string {
  return join(app.getPath('userData'), 'logs')
}

function logFile(): string {
  return join(logDir(), 'app.log')
}

async function appendLog(scope: string, message: string): Promise<void> {
  await mkdir(logDir(), { recursive: true })
  const line = `[${new Date().toISOString()}] [${scope}] ${message}\n`
  await appendFile(logFile(), line, 'utf-8')
}

export function registerLogIpc(): void {
  ipcMain.handle('log:write', (_e, scope: string, message: string) => appendLog(scope, message))
  ipcMain.handle('log:openFolder', async () => {
    await mkdir(logDir(), { recursive: true })
    await shell.openPath(logDir())
  })
}
