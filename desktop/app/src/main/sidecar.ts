import { spawn } from 'child_process'
import { createInterface } from 'readline'
import { join, resolve } from 'path'
import { app, ipcMain } from 'electron'
import { writeFile, mkdtemp, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'

/** One JSON-lines event emitted by the Python sidecar on stdout. */
export interface SidecarEvent {
  event: string
  [key: string]: unknown
}

export interface RenderJobSpec {
  source: string
  output: string
  cuts: { start: number; end: number }[]
}

/**
 * Locate the sidecar. Dev: `python -m sidecar` with cwd <repo>/desktop/sidecar.
 * Packaged: the PyInstaller-frozen exe under resources/sidecar, with the
 * backend packages shipped as data under resources/backend and ffmpeg under
 * resources/ffmpeg (see desktop/app/scripts/prepare-resources.mjs).
 */
function sidecarSpawnSpec(): {
  command: string
  baseArgs: string[]
  cwd: string
  env: NodeJS.ProcessEnv
} {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Thai error messages from the sidecar must survive the stdout pipe on Windows.
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8'
  }

  if (process.env.NOEY_SIDECAR_DIR) {
    return {
      command: process.env.NOEY_PYTHON ?? 'python',
      baseArgs: ['-m', 'sidecar'],
      cwd: process.env.NOEY_SIDECAR_DIR,
      env
    }
  }

  if (app.isPackaged) {
    const res = process.resourcesPath
    env.NOEY_BACKEND_DIR = join(res, 'backend')
    const ffmpeg = join(res, 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
    if (existsSync(ffmpeg)) env.FFMPEG_PATH = ffmpeg
    const exe = join(res, 'sidecar', process.platform === 'win32' ? 'sidecar.exe' : 'sidecar')
    return { command: exe, baseArgs: [], cwd: join(res, 'sidecar'), env }
  }

  return {
    command: process.env.NOEY_PYTHON ?? 'python',
    baseArgs: ['-m', 'sidecar'],
    cwd: resolve(__dirname, '../../../sidecar'),
    env
  }
}

/**
 * Spawn the sidecar with `args`, stream parsed JSON-line events to `onEvent`,
 * and resolve with the final event. Rejects when the process exits non-zero
 * (the sidecar's last line is then an `error` event) or stdout carries no
 * parseable event at all.
 */
export function runSidecar(
  args: string[],
  onEvent?: (evt: SidecarEvent) => void,
  projectDir?: string
): Promise<SidecarEvent> {
  const spec = sidecarSpawnSpec()
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(spec.command, [...spec.baseArgs, ...args], {
      cwd: spec.cwd,
      env: spec.env,
      windowsHide: true
    })
    if (projectDir) activeProcs.set(projectDir, proc)

    let lastEvent: SidecarEvent | null = null
    const stderrTail: string[] = []

    createInterface({ input: proc.stdout }).on('line', (line) => {
      if (!line.trim()) return
      try {
        const evt = JSON.parse(line) as SidecarEvent
        lastEvent = evt
        onEvent?.(evt)
      } catch {
        // Non-protocol noise on stdout — keep for diagnostics.
        stderrTail.push(line)
      }
    })
    createInterface({ input: proc.stderr }).on('line', (line) => {
      stderrTail.push(line)
      if (stderrTail.length > 50) stderrTail.shift()
    })

    proc.on('error', (err) => {
      if (projectDir) activeProcs.delete(projectDir)
      reject(new Error(`sidecar spawn failed: ${err.message}`))
    })
    proc.on('close', (code) => {
      if (projectDir) activeProcs.delete(projectDir)
      if (code === 0 && lastEvent) {
        resolvePromise(lastEvent)
      } else {
        const message =
          lastEvent?.event === 'error'
            ? String(lastEvent.message)
            : `sidecar exited with code ${code}: ${stderrTail.slice(-5).join(' | ')}`
        reject(new Error(message))
      }
    })
  })
}

const activeProcs = new Map<string, ReturnType<typeof spawn>>()

/** Kill the sidecar ffmpeg job for a project (best-effort). */
export function cancelSidecarJob(projectDir: string): void {
  activeProcs.get(projectDir)?.kill()
  activeProcs.delete(projectDir)
}

// Serializes sidecar jobs per project directory. Commands like extract-audio
// wipe and rewrite every WAV in the project's audio dir on each call — if two
// invocations for the same project ever overlap (retry/relaunch while one is
// still running), the second's cleanup can delete files the first is still
// about to hand off to a caller, producing a stale-file-list ENOENT.
const projectLocks = new Map<string, Promise<unknown>>()

async function withProjectLock<T>(key: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!key) return fn()
  const prior = projectLocks.get(key) ?? Promise.resolve()
  const run = prior.catch(() => undefined).then(fn)
  projectLocks.set(key, run.catch(() => undefined))
  return run
}

/** Run a `--job`-style command: write the job JSON to a temp file, stream progress. */
async function runJobCommand(
  command: string,
  job: unknown,
  onProgress?: (evt: SidecarEvent) => void
): Promise<SidecarEvent> {
  const projectDir = (job as { projectDir?: string } | null)?.projectDir
  return withProjectLock(projectDir, async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'noey-job-'))
    const jobFile = join(workdir, 'job.json')
    try {
      await writeFile(jobFile, JSON.stringify(job), 'utf-8')
      return await runSidecar([command, '--job', jobFile], onProgress, projectDir)
    } finally {
      await rm(workdir, { recursive: true, force: true })
    }
  })
}

/** Register sidecar IPC handlers (call once from app.whenReady). */
export function registerSidecarIpc(): void {
  ipcMain.handle('sidecar:ping', () => runSidecar(['ping']))
  ipcMain.handle('sidecar:probe', (_evt, file: string) => runSidecar(['probe', file]))

  const jobChannels: [string, string][] = [
    ['sidecar:render', 'render'],
    ['sidecar:ingest', 'ingest'],
    ['sidecar:extractFrames', 'extract-frames'],
    ['sidecar:extractProxy', 'extract-proxy'],
    ['sidecar:renderSilent', 'render-silent'],
    ['sidecar:renderFinal', 'render-final'],
    ['sidecar:extractAudio', 'extract-audio'],
    ['sidecar:renderTimeline', 'render-timeline'],
    ['sidecar:renderAiPreview', 'render-ai-preview']
  ]
  for (const [channel, command] of jobChannels) {
    ipcMain.handle(channel, (evt, job: unknown) =>
      runJobCommand(command, job, (progress) => {
        if (!evt.sender.isDestroyed()) evt.sender.send(`${channel}-progress`, progress)
      })
    )
  }
  ipcMain.handle('sidecar:cancel', (_evt, projectDir: string) => {
    cancelSidecarJob(projectDir)
  })
}
