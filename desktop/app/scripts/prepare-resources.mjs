/**
 * Prepare native resources for electron-builder packaging:
 *
 *   1. PyInstaller-freeze the sidecar → ../sidecar/dist/sidecar/
 *   2. Copy the backend packages subset the sidecar imports at runtime
 *      (packages/__init__.py, packages/core, packages/video — NEVER llm/db)
 *      → resources-staging/backend/packages/
 *   3. Download + cache ffmpeg/ffprobe for the current platform
 *      → vendor/ffmpeg/<platform>-<arch>/
 *
 * Run from desktop/app:  node scripts/prepare-resources.mjs [--skip-pyinstaller]
 * electron-builder.yml picks these up as extraResources.
 */

import { execSync } from 'child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(__dirname, '..')
const sidecarDir = resolve(appDir, '../sidecar')
const backendDir = resolve(appDir, '../../backend')
const stagingDir = join(appDir, 'resources-staging')
const platformKey = `${process.platform}-${process.arch}`
const ffmpegVendorDir = join(appDir, 'vendor', 'ffmpeg', platformKey)

const skipPyinstaller = process.argv.includes('--skip-pyinstaller')

function log(msg) {
  console.log(`[prepare-resources] ${msg}`)
}

// ── 1. freeze sidecar ────────────────────────────────────────────────────────
if (skipPyinstaller && existsSync(join(sidecarDir, 'dist', 'sidecar'))) {
  log('skipping PyInstaller (--skip-pyinstaller)')
} else {
  log('running PyInstaller…')
  execSync('python -m PyInstaller sidecar.spec --noconfirm', {
    cwd: sidecarDir,
    stdio: 'inherit'
  })
}

// ── 2. backend packages subset ───────────────────────────────────────────────
log('staging backend packages (core + video only)…')
rmSync(stagingDir, { recursive: true, force: true })
const pkgDest = join(stagingDir, 'backend', 'packages')
mkdirSync(pkgDest, { recursive: true })

cpSync(join(backendDir, 'packages', '__init__.py'), join(pkgDest, '__init__.py'))
for (const sub of ['core', 'video']) {
  cpSync(join(backendDir, 'packages', sub), join(pkgDest, sub), {
    recursive: true,
    filter: (src) => !src.includes('__pycache__')
  })
}
// Sanity: the LLM stack must not ship with the desktop app.
if (existsSync(join(pkgDest, 'llm'))) {
  throw new Error('packages/llm must not be staged into the desktop app')
}

// ── 3. ffmpeg per platform ───────────────────────────────────────────────────
const exeSuffix = process.platform === 'win32' ? '.exe' : ''
const ffmpegBin = join(ffmpegVendorDir, `ffmpeg${exeSuffix}`)
const ffprobeBin = join(ffmpegVendorDir, `ffprobe${exeSuffix}`)

function findFile(root, name) {
  for (const entry of readdirSync(root)) {
    const p = join(root, entry)
    if (statSync(p).isDirectory()) {
      const found = findFile(p, name)
      if (found) return found
    } else if (entry.toLowerCase() === name.toLowerCase()) {
      return p
    }
  }
  return null
}

if (existsSync(ffmpegBin) && existsSync(ffprobeBin)) {
  log(`ffmpeg cached at ${ffmpegVendorDir}`)
} else {
  mkdirSync(ffmpegVendorDir, { recursive: true })
  if (process.platform === 'win32') {
    log('downloading ffmpeg (gyan.dev essentials)…')
    const zip = join(ffmpegVendorDir, 'ffmpeg.zip')
    const extractDir = join(ffmpegVendorDir, 'extract')
    execSync(
      `powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile '${zip}'"`,
      { stdio: 'inherit' }
    )
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -Path '${zip}' -DestinationPath '${extractDir}' -Force"`,
      { stdio: 'inherit' }
    )
    for (const name of ['ffmpeg.exe', 'ffprobe.exe']) {
      const found = findFile(extractDir, name)
      if (!found) throw new Error(`${name} not found in ffmpeg archive`)
      cpSync(found, join(ffmpegVendorDir, name))
    }
    rmSync(zip, { force: true })
    rmSync(extractDir, { recursive: true, force: true })
  } else if (process.platform === 'darwin') {
    log('downloading ffmpeg (evermeet.cx)…')
    for (const name of ['ffmpeg', 'ffprobe']) {
      const zip = join(ffmpegVendorDir, `${name}.zip`)
      execSync(`curl -L -o '${zip}' 'https://evermeet.cx/ffmpeg/getrelease/${name}/zip'`, {
        stdio: 'inherit'
      })
      execSync(`unzip -o '${zip}' -d '${ffmpegVendorDir}'`, { stdio: 'inherit' })
      execSync(`chmod +x '${join(ffmpegVendorDir, name)}'`)
      rmSync(zip, { force: true })
    }
  } else {
    throw new Error(`unsupported packaging platform: ${process.platform}`)
  }
  log(`ffmpeg ready at ${ffmpegVendorDir}`)
}

// Stage the current platform's ffmpeg where electron-builder expects it.
cpSync(ffmpegVendorDir, join(stagingDir, 'ffmpeg'), { recursive: true })

log('done — resources staged for electron-builder')
