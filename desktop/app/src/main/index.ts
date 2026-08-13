import { app, screen, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerSidecarIpc } from './sidecar'
import { registerAuthIpc } from './authStore'
import { registerProjectsIpc } from './projects'
import { registerMediaProtocol, registerMediaScheme } from './media'
import { registerLogIpc } from './logger'
import { registerApiProxyIpc } from './apiProxy'
import { registerLanIpc, stopLanReceive } from './lanReceive'
import { registerNotifyIpc } from './notify'
import { loadPrefs, registerPrefsIpc } from './prefs'
import { autoDeleteOldSources, registerStorageIpc } from './storage'
import { attachUnsavedGuard, registerUnsavedIpc } from './unsavedGuard'

// Privileged scheme registration must happen before app is ready.
registerMediaScheme()

function createWindow(): void {
  // Size relative to the actual screen (capped) instead of a fixed 900x670 —
  // a fixed size could exceed a smaller display or look tiny on a large one,
  // and 900px width sat right at Tailwind's `lg:` breakpoint (1024px), so the
  // split-panel desktop layout never actually activated by default.
  // The design is drawn at 1280×800 and the editors budget fixed columns out
  // of that (timeline header 92px, inspector 340/360px, 272px stage) — below
  // it panels start clipping their own content, so it is the hard floor.
  const MIN_W = 1300
  const MIN_H = 800
  const { width: workW, height: workH } = screen.getPrimaryDisplay().workAreaSize
  const width = Math.max(MIN_W, Math.min(Math.round(workW * 0.85), 1440))
  const height = Math.max(MIN_H, Math.min(Math.round(workH * 0.85), 900))

  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: MIN_W,
    minHeight: MIN_H,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#171614',
    // Every platform, not just Linux: on Windows the packaged .exe carries the
    // icon but a dev run (and the taskbar/alt-tab entry) falls back to the
    // stock Electron logo without this. macOS ignores it in favour of the
    // bundle's .icns, which is harmless.
    icon,
    // Native Windows titlebar is always OS white/grey and ignores app theming —
    // swap to a themed overlay (renderer draws its own drag strip to match).
    // macOS uses `hiddenInset` so the traffic lights float over the renderer's
    // own 38px bar; OverlayTitleBarSpacer.tsx reserves their footprint there.
    // Colors mirror the design tokens (--color-surface / --color-muted) — they
    // can't reference the CSS vars from the main process, so changing a token
    // means changing these too.
    ...(process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: { color: '#211f1d', symbolColor: '#a3a09c', height: 38 }
        }
      : process.platform === 'darwin'
        ? { titleBarStyle: 'hiddenInset' as const }
        : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // Closing the app is the one exit the renderer cannot intercept itself.
  attachUnsavedGuard(mainWindow)

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.noey.videoedit')

  // Before anything reads `projectsRoot()` — that resolves the projects
  // location synchronously from the prefs cache, so the cache has to be warm
  // or the first requests would resolve against the default folder.
  const prefs = await loadPrefs()

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerMediaProtocol()
  registerLogIpc()
  registerApiProxyIpc()
  registerSidecarIpc()
  registerAuthIpc()
  registerProjectsIpc()
  registerLanIpc()
  registerNotifyIpc()
  registerPrefsIpc()
  registerStorageIpc()
  registerUnsavedIpc()

  // Fire-and-forget: a retention sweep must never delay the first window, and
  // nothing in the UI is waiting on its result.
  void autoDeleteOldSources(prefs.autoDeleteSourcesDays).catch(() => undefined)

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Stop the LAN receive server (if running) before quitting so the port is
// released and no half-written .part files keep growing.
app.on('before-quit', () => {
  void stopLanReceive(null)
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
