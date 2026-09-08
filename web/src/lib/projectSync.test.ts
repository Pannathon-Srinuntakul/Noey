/**
 * The client half of the file store: what is syncable, and what a failed PUT
 * is allowed to do quietly.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SOURCE = readFileSync(resolve(__dirname, 'projectSync.ts'), 'utf8')
const BACKEND = readFileSync(
  resolve(__dirname, '../../../backend/services/api/routers/videos_local.py'),
  'utf8'
)

describe('the sync allow-list agrees with the server', () => {
  const clientNames = [...SOURCE.matchAll(/^\s{2}'([\w.]+)',?$/gm)].map((m) => m[1])
  const serverBlock = BACKEND.slice(
    BACKEND.indexOf('_WEB_FILE_NAMES = ('),
    BACKEND.indexOf(')', BACKEND.indexOf('_WEB_FILE_NAMES = ('))
  )

  it('lists no file the server would refuse', () => {
    // A name the client uploads and the server rejects fails the sync at a
    // point nothing retries — the two lists have to be one list.
    expect(clientNames.length).toBeGreaterThan(5)
    for (const name of clientNames) {
      expect(serverBlock, `server refuses ${name}`).toContain(`"${name}"`)
    }
  })

  it('includes upload_sources.json', () => {
    // ingest's record of which normalized file each source became. Without it,
    // extract-proxy on a project opened in a second browser threw
    // "ยังไม่ได้นำเข้าคลิป" and there was no way to recover — the file could
    // never have been synced in the first place.
    expect(clientNames).toContain('upload_sources.json')
    expect(serverBlock).toContain('"upload_sources.json"')
  })
})

describe('a rejected upload', () => {
  it('surfaces the server message rather than a status code', () => {
    // 507 is "พื้นที่เก็บเต็มแล้ว" WITH the numbers, and 413 names the size
    // limit. Both used to collapse into a generic failure the caller ignored,
    // so a sync stopped halfway with nothing on screen.
    expect(SOURCE).toContain('serverMessage(res,')
  })

  it('goes through the refreshing fetch, not a bare one', () => {
    // An access token lives 30 minutes. Every plain `fetch` in here simply
    // started failing after that.
    expect(SOURCE).not.toMatch(/\bawait fetch\(/)
    expect(SOURCE).toContain('authedFetch')
  })
})

describe('the back-fill for projects that predate the sync', () => {
  it('exists and keys off project.json', () => {
    // Every push point is a pipeline TRANSITION, which never fires again for a
    // project already resting at waiting_vo or done. Without a catch-up, every
    // project finished before those transitions learned to sync stays on one
    // machine for good — which is what production looked like on 2026-09-08.
    expect(SOURCE).toContain('export async function backfillUnsyncedProjects')
    expect(SOURCE).toMatch(/f\.path === 'project\.json'/)
  })

  it('runs on mount, after the restore', () => {
    const jobs = readFileSync(resolve(__dirname, 'jobs.tsx'), 'utf8')
    expect(jobs).toContain('backfillUnsyncedProjects')
    expect(jobs.indexOf('restoreMissingProjects(session)')).toBeLessThan(
      jobs.indexOf('backfillUnsyncedProjects(session)')
    )
  })

  it('skips a project with no server row rather than guessing one', () => {
    const body = SOURCE.slice(SOURCE.indexOf('export async function backfillUnsyncedProjects'))
    expect(body).toContain('if (!remoteUid) continue')
  })
})
