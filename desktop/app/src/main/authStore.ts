import { app, ipcMain, safeStorage } from 'electron'
import { join } from 'path'
import { readFile, writeFile, rm } from 'fs/promises'

/**
 * Persisted desktop session — independent from any browser session.
 * Encrypted with the OS keychain (DPAPI on Windows, Keychain on macOS) via
 * Electron safeStorage; falls back to plaintext only when the OS store is
 * unavailable (e.g. some Linux setups), which we flag in the payload.
 */
export interface StoredAuth {
  baseUrl: string
  email: string
  accessToken: string
  refreshToken: string
}

function authFile(): string {
  return join(app.getPath('userData'), 'auth.bin')
}

async function saveAuth(auth: StoredAuth): Promise<void> {
  const raw = JSON.stringify(auth)
  const data = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(raw)
    : Buffer.from(raw, 'utf-8')
  await writeFile(authFile(), data)
}

async function loadAuth(): Promise<StoredAuth | null> {
  try {
    const data = await readFile(authFile())
    const raw = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(data)
      : data.toString('utf-8')
    return JSON.parse(raw) as StoredAuth
  } catch {
    return null
  }
}

async function clearAuth(): Promise<void> {
  await rm(authFile(), { force: true })
}

/** Register auth-store IPC handlers (call once from app.whenReady). */
export function registerAuthIpc(): void {
  ipcMain.handle('auth:save', (_evt, auth: StoredAuth) => saveAuth(auth))
  ipcMain.handle('auth:load', () => loadAuth())
  ipcMain.handle('auth:clear', () => clearAuth())
}
