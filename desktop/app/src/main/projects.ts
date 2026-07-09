import { app, ipcMain, shell } from 'electron'
import { join, sep } from 'path'
import { mkdir, readdir, readFile, writeFile, rm, stat } from 'fs/promises'
import { randomUUID } from 'crypto'
import { isSafeUid } from './uid'

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
  mode?: 'dub_first' | 'talking_head'
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
  /** Planned dub timeline (from POST /videos/{uid}/plan-dub) — kept for post-VO manual edits. */
  timeline?: Record<string, unknown>
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

async function readProject(uid: string): Promise<LocalProject | null> {
  try {
    return JSON.parse(await readFile(projectFile(uid), 'utf-8')) as LocalProject
  } catch {
    return null
  }
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
  const current = await readProject(uid)
  if (!current) throw new Error(`project not found: ${uid}`)
  return writeProject({ ...current, ...patch, uid: current.uid, createdAt: current.createdAt })
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
  ipcMain.handle('projects:openFolder', async (_e, uid: string, relPath = '.') => {
    await shell.openPath(join(projectDir(uid), relPath))
  })
}
