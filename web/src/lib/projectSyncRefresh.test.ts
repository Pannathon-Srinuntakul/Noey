/**
 * The list restore used to skip every project already in this browser, so a
 * stale local `error` never met the finished server copy (production
 * 2026-10-02, d02d2d5e). It now re-reads the ones the server row says are out
 * of date, and adopts the truer record.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalProject } from '../platform/types'

const REMOTE = 'd02d2d5e-c068-46a2-bc3f-ba989815cdbd'
const fetchCalls: string[] = []
const replaced: LocalProject[] = []
// What this browser's store holds; `replace` writes into it.
let localRecord: LocalProject

const staleError = {
  uid: 'local-1',
  name: 'p',
  mode: 'dub_first',
  step: 'error',
  error: 'ไม่พบไฟล์ noeyfs://projects/local-1/normalized/norm_000.mp4',
  createdAt: '2026-10-02T17:31:46.000Z',
  updatedAt: '2026-10-02T17:31:58.000Z',
  clips: [],
  remote: { uid: REMOTE }
} as unknown as LocalProject

const serverCopy = {
  ...staleError,
  step: 'waiting_vo',
  error: undefined,
  runDevice: 'device-a',
  updatedAt: '2026-10-02T17:46:12.000Z'
}

let rowStatus = 'waiting_vo'
let rowUpdated = '2026-10-02T17:46:20.000Z'

vi.mock('../platform/fs', () => ({
  listProjectUids: vi.fn(async () => ['local-1']),
  readFile: vi.fn(),
  listDir: vi.fn(),
  projectDirPath: (uid: string) => `/p/${uid}`,
  projectFilePath: (uid: string, rel: string) => `/p/${uid}/${rel}`,
  readJson: vi.fn(),
  writeFileAtomic: vi.fn(async () => undefined),
  SERVER_MANIFEST: 'server_manifest.json'
}))

vi.mock('../platform/projects', () => ({
  get: vi.fn(async () => localRecord),
  replace: vi.fn(async (p: LocalProject) => {
    replaced.push(p)
    localRecord = p
    return p
  })
}))

vi.mock('./authedFetch', () => ({
  serverMessage: vi.fn(),
  authedFetch: vi.fn(async (_session: unknown, path: string) => {
    fetchCalls.push(path)
    if (path.startsWith('/videos?')) {
      return new Response(
        JSON.stringify([
          { uid: REMOTE, origin: 'local', status: rowStatus, updated_at: rowUpdated }
        ]),
        { status: 200 }
      )
    }
    if (path === `/videos/${REMOTE}/files/project.json`) {
      return new Response(JSON.stringify(serverCopy), { status: 200 })
    }
    if (path === `/videos/${REMOTE}/files`) return new Response('[]', { status: 200 })
    return new Response('', { status: 404 })
  })
}))

const store = new Map<string, string>()
;(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v)
  },
  noey: {
    projects: { list: async () => [localRecord] },
    log: { write: async () => undefined }
  },
  setTimeout: globalThis.setTimeout.bind(globalThis)
}

beforeEach(() => {
  fetchCalls.length = 0
  replaced.length = 0
  store.clear()
  rowStatus = 'waiting_vo'
  rowUpdated = '2026-10-02T17:46:20.000Z'
  localRecord = staleError
  vi.resetModules()
})

describe('restore refreshes projects this browser already holds', () => {
  it('replaces a stale local error with the server’s waiting_vo copy', async () => {
    const { restoreMissingProjects } = await import('./projectSync')
    await restoreMissingProjects({} as never)
    expect(replaced).toHaveLength(1)
    expect(replaced[0].step).toBe('waiting_vo')
    expect(replaced[0].error).toBeUndefined()
    expect(replaced[0].uid).toBe('local-1')
  })

  it('does not fetch again for a row it already looked at', async () => {
    const { restoreMissingProjects } = await import('./projectSync')
    await restoreMissingProjects({} as never)
    expect(localRecord.step).toBe('waiting_vo')
    fetchCalls.length = 0
    // The row's updated_at (17:46:20) is still later than the adopted record
    // (17:46:12), but this exact pair was already examined.
    await restoreMissingProjects({} as never)
    expect(fetchCalls.filter((p) => p.endsWith('/project.json'))).toHaveLength(0)
  })

  it('leaves a project alone when the server row is still processing and older', async () => {
    rowStatus = 'processing'
    rowUpdated = '2026-10-02T17:00:00.000Z'
    const { restoreMissingProjects } = await import('./projectSync')
    await restoreMissingProjects({} as never)
    expect(fetchCalls.filter((p) => p.endsWith('/project.json'))).toHaveLength(0)
    expect(replaced).toHaveLength(0)
  })
})

describe('the upload order', () => {
  it('sends project.json after every file it names', async () => {
    const { projectJsonLast } = await import('./projectSync')
    const order = projectJsonLast([
      { path: 'project.json' },
      { path: 'manifest.json' },
      { path: 'normalized/norm_000.mp4' }
    ]).map((f) => f.path)
    expect(order).toEqual(['manifest.json', 'normalized/norm_000.mp4', 'project.json'])
  })
})
