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
import { registerRemoteIpc, restoreRemoteMode, stopRemote } from './remoteAccess'
import { registerNotifyIpc } from './notify'
import { loadPrefs, registerPrefsIpc } from './prefs'
import { registerStorageIpc } from './storage'
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

// One instance only. Two copies of the app share `userData` — the same project
// registry, the same prefs file, the same LAN port — so a second launch means
// two writers to one project.json (last write wins, silently) and a LAN server
// that fails to bind. Launching again focuses the window that already exists.
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // `app.quit()` above is asynchronous — whenReady still fires in the losing
  // instance, and creating a window there would defeat the lock.
  if (!gotTheLock) return
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.noey.videoedit')

  // Before anything reads `projectsRoot()` — that resolves the projects
  // location synchronously from the prefs cache, so the cache has to be warm
  // or the first requests would resolve against the default folder.
  await loadPrefs()

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
  registerRemoteIpc()
  registerNotifyIpc()
  registerPrefsIpc()
  registerStorageIpc()
  registerUnsavedIpc()

  createWindow()

  // Phone-remote mode is a switch the user left on, not a session — bring it
  // back so a saved link on the phone still answers after a restart. After
  // the window exists, so the status event has somewhere to land.
  void restoreRemoteMode()

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
  // 'quit', not 'manual': the mode must survive the restart it is quitting for.
  void stopRemote('quit')
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
