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

// Privileged scheme registration must happen before app is ready.
registerMediaScheme()

function createWindow(): void {
  // Size relative to the actual screen (capped) instead of a fixed 900x670 —
  // a fixed size could exceed a smaller display or look tiny on a large one,
  // and 900px width sat right at Tailwind's `lg:` breakpoint (1024px), so the
  // split-panel desktop layout never actually activated by default.
  const { width: workW, height: workH } = screen.getPrimaryDisplay().workAreaSize
  const width = Math.min(Math.round(workW * 0.85), 1440)
  const height = Math.min(Math.round(workH * 0.85), 900)

  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 1024,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#140b06',
    ...(process.platform === 'linux' ? { icon } : {}),
    // Native Windows titlebar is always OS white/grey and ignores app theming —
    // swap to a themed overlay (renderer draws its own drag strip to match).
    // Left on default frame elsewhere (macOS traffic lights already sit on a
    // transparent inset that follows the page background; unverified — no Mac
    // to test against per DESKTOP_VIDEO_APP_REQUIREMENTS.md).
    ...(process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: { color: '#140b06', symbolColor: '#f2c14e', height: 36 }
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

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
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.noey.videoedit')

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

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
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
