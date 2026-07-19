import { app, ipcMain, shell } from 'electron'
import { join, normalize, relative, sep } from 'path'
import { copyFile, mkdir, readdir, readFile, writeFile, rm, stat } from 'fs/promises'
import { randomUUID } from 'crypto'
import { isSafeUid } from './uid'
import { appendLog } from './logger'

/**
 * Local project registry — one directory per project under
 * `userData/projects/<uid>/`, holding the media artifacts (normalized/,
 * frames/, clips/, final_silent.mp4, …) and a `project.json` state file that
 * the wizard resumes from.
 */
export interface LocalClip {
  id: string
  file: string
  durationSec: number
  width: number
  height: number
  fps: number
  hasAudio: boolean
  originalPath?: string
}

export interface LocalProject {
  uid: string // local uid == backend VideoProject uid once created remotely
  name: string
  mode?: 'dub_first' | 'talking_head' | 'highlight'
  step:
    | 'imported'
    | 'analyzing'
    | 'silent_rendering'
    | 'waiting_vo'
    | 'planning'
    | 'final_rendering'
    | 'extracting_audio'
    | 'transcribing'
    | 'rendering'
    | 'done'
    | 'error'
  createdAt: string
  updatedAt: string
  clips: LocalClip[]
  brief?: string
  userScript?: string
  scriptStyles?: string[]
  targetDurationSec?: number
  remote?: { uid: string; jobId?: string }
  voiceoverPath?: string
  /** dub_first background music (desktop-local file — mix params edited in
   * TimelineEditor's audio track, applied at render time by the sidecar). */
  music?: {
    path: string
    volume: number
    offsetSec: number
    trimInSec: number
    trimOutSec: number | null
    muted: boolean
  }
  /** Planned dub timeline (from POST /videos/{uid}/plan-dub) — kept for post-VO manual edits. */
  timeline?: Record<string, unknown>
  /** dub_first edit script from the analyze step — persisted so the timeline
   * editor stays available after a restart instead of relying solely on
   * in-memory state + a resume-fetch that can silently fail. */
  editScript?: Record<string, unknown>
  /** Real per-clip output durations from the silent render (measured post
   * frame-accurate re-encode), same order as editScript.segments — lets the
   * effects layer build scene-cut boundaries from real output timing instead
   * of the edit script's nominal sourceOut-sourceIn (which drifts a little
   * more with each segment as ffmpeg's frame-rounding accumulates). */
  clipDurationsSec?: number[]
  error?: string
}

export function projectsRoot(): string {
  return join(app.getPath('userData'), 'projects')
}

export function projectDir(uid: string): string {
  if (!isSafeUid(uid)) throw new Error(`invalid project id: ${JSON.stringify(uid)}`)
  const root = projectsRoot()
  const dir = join(root, uid)
  // Belt-and-suspenders: the resolved path must stay strictly inside root.
  if (dir !== join(root, uid) || !dir.startsWith(root + sep)) {
    throw new Error(`project path escapes root: ${uid}`)
  }
  return dir
}

function projectFile(uid: string): string {
  return join(projectDir(uid), 'project.json')
}

function resolveProjectPath(uid: string, relPath: string): string {
  const dir = projectDir(uid)
  const resolved = normalize(join(dir, relPath))
  const rel = relative(dir, resolved)
  if (rel.startsWith('..') || rel === '') {
    throw new Error(`path escapes project dir: ${relPath}`)
  }
  return resolved
}

async function readProject(uid: string): Promise<LocalProject | null> {
  try {
    return JSON.parse(await readFile(projectFile(uid), 'utf-8')) as LocalProject
  } catch {
    return null
  }
}

// Serializes reads/writes of one project's project.json. Without this, two
// concurrent updateProject() calls for the same uid (e.g. applyEditScript's
// un-awaited patchProject racing runRenderSilent's immediately-following one)
// each independently open+truncate+write the SAME path — two unsynchronized
// file descriptors racing on one file, not just a last-write-wins field loss,
// can literally interleave their write() calls and corrupt the JSON on disk
// (observed in production: two valid JSON bodies concatenated together,
// making the file unparseable and stranding the project mid-render even
// though the actual render had already finished).
const projectWriteLocks = new Map<string, Promise<unknown>>()

/** A stuck read-modify-write would otherwise wedge every future write for
 * this uid behind it forever (the lock chain never advances) — cap any
 * single write at 15s so the queue always keeps moving, and log which step
 * actually took long instead of the caller just hanging with no trail. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    )
  })
}

async function withProjectWriteLock<T>(uid: string, fn: () => Promise<T>): Promise<T> {
  const hadPrior = projectWriteLocks.has(uid)
  void appendLog('projects', `writeLock: ${hadPrior ? 'queued behind prior write' : 'acquired immediately'} uid=${uid}`)
  const prior = projectWriteLocks.get(uid) ?? Promise.resolve()
  const run = prior.catch(() => undefined).then(async () => {
    void appendLog('projects', `writeLock: running uid=${uid}`)
    try {
      const result = await withTimeout(fn(), 15_000, `writeLock uid=${uid}`)
      void appendLog('projects', `writeLock: done uid=${uid}`)
      return result
    } catch (err) {
      void appendLog('projects', `writeLock: failed uid=${uid}: ${String(err)}`)
      throw err
    }
  })
  projectWriteLocks.set(uid, run.catch(() => undefined))
  return run
}

async function writeProject(project: LocalProject): Promise<LocalProject> {
  project.updatedAt = new Date().toISOString()
  await mkdir(projectDir(project.uid), { recursive: true })
  await writeFile(projectFile(project.uid), JSON.stringify(project, null, 2), 'utf-8')
  return project
}

async function listProjects(): Promise<LocalProject[]> {
  try {
    const entries = await readdir(projectsRoot(), { withFileTypes: true })
    const projects = await Promise.all(
      entries.filter((e) => e.isDirectory()).map((e) => readProject(e.name))
    )
    return projects
      .filter((p): p is LocalProject => p !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  } catch {
    return []
  }
}

async function createProject(
  init: Partial<LocalProject> & { name: string }
): Promise<LocalProject> {
  const now = new Date().toISOString()
  const project: LocalProject = {
    uid: init.uid ?? randomUUID(),
    name: init.name,
    mode: init.mode ?? 'dub_first',
    step: init.step ?? 'imported',
    createdAt: now,
    updatedAt: now,
    clips: init.clips ?? [],
    brief: init.brief,
    userScript: init.userScript,
    targetDurationSec: init.targetDurationSec,
    remote: init.remote
  }
  return writeProject(project)
}

async function updateProject(uid: string, patch: Partial<LocalProject>): Promise<LocalProject> {
  return withProjectWriteLock(uid, async () => {
    const current = await readProject(uid)
    if (!current) throw new Error(`project not found: ${uid}`)
    return writeProject({ ...current, ...patch, uid: current.uid, createdAt: current.createdAt })
  })
}

async function deleteProject(uid: string): Promise<void> {
  const dir = projectDir(uid) // throws on any unsafe uid
  // Only remove a real project directory: it must exist, be a directory, and
  // hold a project.json. Never rm anything that isn't provably our project.
  try {
    const info = await stat(dir)
    if (!info.isDirectory()) return
    await stat(join(dir, 'project.json'))
  } catch {
    return // no such project dir (or no manifest) → nothing to delete
  }
  await rm(dir, { recursive: true, force: true })
}

/** Copy a user-picked music/video file into the project dir (music/<name>) so
 * it's servable via media:// for waveform decode/preview in the editor, same
 * as clips. Returns the project-relative path to store on LocalProject.music.
 * Render itself (sidecar) still opens the copy directly via resolvePath —
 * this is the ONLY server/editor-visible copy, not a second source of truth. */
async function importMusicFile(uid: string, srcPath: string): Promise<string> {
  const dir = projectDir(uid)
  const musicDir = join(dir, 'music')
  await rm(musicDir, { recursive: true, force: true })
  await mkdir(musicDir, { recursive: true })
  const base = srcPath.replace(/\\/g, '/').split('/').pop() || 'track'
  const dest = join(musicDir, base)
  await copyFile(srcPath, dest)
  return `music/${base}`
}

/** Register project-registry IPC handlers (call once from app.whenReady). */
export function registerProjectsIpc(): void {
  ipcMain.handle('projects:list', () => listProjects())
  ipcMain.handle('projects:get', (_e, uid: string) => readProject(uid))
  ipcMain.handle('projects:create', (_e, init: Partial<LocalProject> & { name: string }) =>
    createProject(init)
  )
  ipcMain.handle('projects:update', (_e, uid: string, patch: Partial<LocalProject>) =>
    updateProject(uid, patch)
  )
  ipcMain.handle('projects:delete', (_e, uid: string) => deleteProject(uid))
  ipcMain.handle('projects:dir', (_e, uid: string) => projectDir(uid))
  ipcMain.handle('projects:resolvePath', (_e, uid: string, relPath: string) =>
    resolveProjectPath(uid, relPath)
  )
  ipcMain.handle('projects:importMusic', (_e, uid: string, srcPath: string) =>
    importMusicFile(uid, srcPath)
  )
  ipcMain.handle('projects:openFolder', async (_e, uid: string, relPath = '.') => {
    await shell.openPath(join(projectDir(uid), relPath))
  })
}
