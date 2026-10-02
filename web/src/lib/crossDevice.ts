/**
 * One account, several browsers: who is running a project, and whose copy of
 * it is true.
 *
 * WEB ONLY — the desktop keeps its projects in a local folder and never
 * restores one from the server, so it has neither question.
 *
 * Each browser profile keeps its own store (OPFS), and a project made in one
 * is restored into another from the server's `project.json`. That copy is a
 * SNAPSHOT of whatever the first browser was doing — `analyzing`, say — and
 * the second browser used to read a busy step as "a run of mine that a reload
 * interrupted", restart it, fail on footage that was still uploading, and
 * write `error` to the server over a run that was going fine elsewhere
 * (production, 2026-10-02, project d02d2d5e). Its own stale `error` then
 * outlived the real result forever, because a project already in the store
 * was never read from the server again.
 *
 * Two rules come out of that, and they live here so the pipeline, the list
 * restore and the tests all read the same definitions:
 *
 *   1. A busy step belongs to the browser that wrote it (`runDevice`). Any
 *      other browser shows it as "working elsewhere" and runs nothing.
 *   2. The newest truthful record wins: the server's copy replaces the local
 *      one when it is newer, or when the server's status has moved past a
 *      local `error`.
 */

import type { LocalProject } from '@renderer/platform/types'
import { isBusy, type ProjectStep } from './projectFlow'

declare module '../platform/types' {
  interface LocalProject {
    /**
     * The browser that wrote the current busy step (`deviceId()`), stamped on
     * every patch that sets one. Kept after the run ends, so a resting record
     * still says which browser produced it. Absent on records written before
     * 2026-10-03.
     */
    runDevice?: string
    /**
     * A run on THIS browser stopped on footage that has not reached the
     * server yet (`failureVerdict` → wait). Local only — never uploaded,
     * because a browser in this state syncs nothing — and dropped by the
     * next run here or by adopting the server's copy, which never has it.
     */
    waitingFiles?: boolean
  }
}

// ── this browser ─────────────────────────────────────────────────────────────

const DEVICE_KEY = 'noey:device-id'
let memoDeviceId: string | null = null

function newId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }
}

/**
 * A stable id for this browser PROFILE — the same granularity as its project
 * store. Two tabs share it (the project lock keeps them apart); two profiles or
 * two machines never do. Falls back to a per-page id when storage is blocked,
 * which errs on the side of "this tab is a different device".
 */
export function deviceId(): string {
  if (memoDeviceId) return memoDeviceId
  let id: string | null = null
  try {
    id = window.localStorage.getItem(DEVICE_KEY)
    if (!id) {
      id = newId()
      window.localStorage.setItem(DEVICE_KEY, id)
    }
  } catch {
    id = id ?? newId()
  }
  memoDeviceId = id
  return id
}

// ── who runs a project ───────────────────────────────────────────────────────

/** What the card and the progress page say instead of a progress line. */
export const ELSEWHERE_MESSAGE = 'กำลังทำบนอีกเครื่อง — ผลจะขึ้นที่นี่เองเมื่อเสร็จ'
export const WAITING_FILES_MESSAGE =
  'รอไฟล์จากอีกเครื่อง — ไฟล์วิดีโอของโปรเจกต์นี้ยังส่งขึ้นเซิร์ฟเวอร์ไม่ครบ จะลองดึงให้อีกครั้งเอง'

/**
 * Is this project's busy step being worked on by another browser?
 *
 * `footageLocal` covers records written before `runDevice` existed: a busy
 * step with no owner is ours only when this browser holds the footage it
 * would need (a project made here always does — the import writes it). Pass
 * null when it has not been checked; that answers "not elsewhere", which is
 * the old behaviour.
 */
export function runIsElsewhere(
  project: Pick<LocalProject, 'step' | 'runDevice'>,
  me: string,
  footageLocal: boolean | null
): boolean {
  if (!isBusy(project.step as ProjectStep)) return false
  if (project.runDevice) return project.runDevice !== me
  return footageLocal === false
}

/** A missing project file (`ไม่พบไฟล์ <path>`), thrown when neither this
 * browser's store nor the server has it — yet. */
export class MissingFileError extends Error {
  readonly path: string
  constructor(path: string) {
    super(`ไม่พบไฟล์ ${path}`)
    this.name = 'MissingFileError'
    this.path = path
  }
}

/** The engine's errors can be re-wrapped on the way up, so the message is
 * matched as well as the class. Only a message that NAMES a path counts. */
export function isMissingFileError(exc: unknown): boolean {
  if (exc instanceof MissingFileError) return true
  const message = exc instanceof Error ? exc.message : typeof exc === 'string' ? exc : ''
  return /^ไม่พบไฟล์ \S*\//.test(message)
}

export type FailureVerdict = 'fail' | 'wait'

/**
 * Does this failure mean the run failed, or that this browser is not where
 * the run can happen (yet)?
 *
 * `wait` writes nothing anywhere — no local `error`, no `local-status`, no
 * project.json upload — because every one of those would land on top of the
 * browser that IS running the project.
 */
export function failureVerdict(opts: {
  exc: unknown
  /** This browser holds the project's source footage itself. */
  footageLocal: boolean
  /** The busy step belongs to another browser. */
  elsewhere: boolean
}): FailureVerdict {
  if (opts.elsewhere) return 'wait'
  if (!opts.footageLocal && isMissingFileError(opts.exc)) return 'wait'
  return 'fail'
}

/**
 * A rendered file that 404s may still be on its way up from the browser that
 * made it (the server's project.json can land before the video it points at).
 * True for a record another browser wrote recently.
 */
export function mayStillArrive(
  project: Pick<LocalProject, 'runDevice' | 'updatedAt' | 'remote'>,
  me: string,
  now: number = Date.now()
): boolean {
  if (!project.remote?.uid) return false
  if (!project.runDevice || project.runDevice === me) return false
  const at = Date.parse(project.updatedAt)
  return Number.isFinite(at) && now - at < ARRIVAL_WINDOW_MS
}

const ARRIVAL_WINDOW_MS = 30 * 60 * 1000

// ── whose record is true ─────────────────────────────────────────────────────

/** The server row's say, from `GET /videos` or `GET /videos/{uid}`. */
export interface ServerRow {
  status: string
  updated_at?: string | null
}

/** Server statuses that mean "a run finished or parked" — past any `error`
 * this browser may hold from an earlier attempt. */
const RESTING_STEP: Record<string, ProjectStep> = {
  waiting_vo: 'waiting_vo',
  done: 'done',
  paused_quota: 'paused'
}

/**
 * Fields that describe THIS browser, never the project: a sync this browser
 * owes, and a per-run consent to spend the balance given here. They are
 * carried over from the local record whatever the server says.
 */
export const LOCAL_ONLY_FIELDS = ['syncPending', 'allowWallet'] as const

function time(iso: string | null | undefined): number {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : 0
}

/**
 * Is this local record one THIS browser is actively driving? Such a record is
 * never replaced from the server — its next write is the truth, and the
 * server's copy is at best the previous one.
 *
 * Same footage fallback as `runIsElsewhere` for a record without `runDevice`:
 * a busy step restored from another browser's (pre-runDevice) upload is not
 * live here when this browser does not hold the footage.
 */
export function isLocalRunLive(
  local: LocalProject,
  me: string,
  footageLocal: boolean | null = null
): boolean {
  if (!isBusy(local.step as ProjectStep)) return false
  return !runIsElsewhere(local, me, footageLocal)
}

/**
 * Worth fetching the server's project.json for this project? Keeps the list
 * restore from downloading every project on every load: only a record the
 * server row says is out of date, a local `error` the server has moved past,
 * or a busy step another browser owns.
 */
export function shouldCheckServer(
  local: LocalProject,
  row: ServerRow,
  me: string,
  footageLocal: boolean | null = null
): boolean {
  if (isLocalRunLive(local, me, footageLocal)) return false
  if (isBusy(local.step as ProjectStep)) return true // someone else's run
  if (local.step === 'error' && RESTING_STEP[row.status]) return true
  return time(row.updated_at) > time(local.updatedAt)
}

/**
 * The record this browser should hold, given its own and the server's.
 * Returns null to keep the local record unchanged.
 *
 *   - The server's copy wins when it is newer (`updatedAt`).
 *   - It also wins over a local `error` when the server ROW has moved on to a
 *     resting status (waiting_vo / done / paused_quota), even if the json is
 *     not newer — the error was written over a run that then finished. When
 *     the server's json itself still says error or busy, the step is taken
 *     from the row.
 *   - A run this browser is driving is never replaced.
 *   - LOCAL_ONLY_FIELDS always come from the local record.
 */
export function reconcileWithServer(opts: {
  local: LocalProject
  server: LocalProject | null
  row: ServerRow | null
  me: string
  /** Whether this browser holds the footage (null = not checked) — only
   * consulted for a busy record without `runDevice`. */
  footageLocal?: boolean | null
}): LocalProject | null {
  const { local, server, row, me } = opts
  if (!server || server.uid !== local.uid) return null
  if (isLocalRunLive(local, me, opts.footageLocal ?? null)) return null

  const serverNewer = time(server.updatedAt) > time(local.updatedAt)
  const rowResting = row ? RESTING_STEP[row.status] : undefined
  const statusAhead = local.step === 'error' && !!rowResting
  if (!serverNewer && !statusAhead) return null

  const merged: LocalProject = { ...server, uid: local.uid, createdAt: local.createdAt }
  const bag = merged as unknown as Record<string, unknown>
  const localBag = local as unknown as Record<string, unknown>
  for (const key of LOCAL_ONLY_FIELDS) {
    if (localBag[key] === undefined) delete bag[key]
    else bag[key] = localBag[key]
  }

  // The server's json can itself be behind its row: still the busy step the
  // other browser last uploaded, or this browser's own earlier `error`.
  // A resting step in the json is kept: it matches the files that json lists.
  const jsonStep = merged.step as ProjectStep
  if (rowResting && (jsonStep === 'error' || isBusy(jsonStep))) merged.step = rowResting
  if (merged.step !== 'error') {
    delete merged.error
    delete merged.billingStop
  }
  // Never older than what it replaces: the pipeline host only adopts a record
  // whose updatedAt is at least the one it holds.
  if (!serverNewer) {
    merged.updatedAt = new Date(time(local.updatedAt) + 1).toISOString()
  }
  return merged
}
