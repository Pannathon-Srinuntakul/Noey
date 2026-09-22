/**
 * The startup restore must not flood the API: overlapping callers share one
 * run, and a server project with no project.json is not asked for again on
 * every load (live report 2026-09-22 — a demo account with ~40 file-less rows
 * made the home page and the settings page crawl).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchCalls: string[] = []

vi.mock('../platform/fs', () => ({
  listProjectUids: vi.fn(async () => []),
  readFile: vi.fn(),
  listDir: vi.fn(),
  projectDirPath: (uid: string) => `/p/${uid}`,
  projectFilePath: (uid: string, rel: string) => `/p/${uid}/${rel}`,
  readJson: vi.fn(),
  writeFileAtomic: vi.fn(async () => undefined),
  SERVER_MANIFEST: 'server_manifest.json'
}))

vi.mock('./authedFetch', () => ({
  serverMessage: vi.fn(),
  authedFetch: vi.fn(async (_session: unknown, path: string) => {
    fetchCalls.push(path)
    if (path.startsWith('/videos?')) {
      return new Response(
        JSON.stringify([
          { uid: 'gone-1', origin: 'local' },
          { uid: 'gone-2', origin: 'local' }
        ]),
        { status: 200 }
      )
    }
    return new Response('', { status: 404 })
  })
}))

const session = {} as never

// Node environment (no DOM package installed): a minimal window with the two
// things the restore touches — localStorage and the platform project list.
const store = new Map<string, string>()
const localStorageStub = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  clear: () => store.clear()
}
;(globalThis as unknown as { window: unknown }).window = {
  localStorage: localStorageStub,
  noey: { projects: { list: async () => [] } },
  setTimeout: globalThis.setTimeout.bind(globalThis)
}

beforeEach(() => {
  fetchCalls.length = 0
  store.clear()
  vi.resetModules()
})

describe('restoreMissingProjects', () => {
  it('shares one run between overlapping callers', async () => {
    const { restoreMissingProjects } = await import('./projectSync')
    const [a, b] = await Promise.all([
      restoreMissingProjects(session),
      restoreMissingProjects(session)
    ])
    expect(a).toBe(0)
    expect(b).toBe(0)
    expect(fetchCalls.filter((p) => p.endsWith('/project.json'))).toHaveLength(2)
    expect(fetchCalls.filter((p) => p.startsWith('/videos?'))).toHaveLength(1)
  })

  it('does not ask again for a project.json the server does not have', async () => {
    const { restoreMissingProjects } = await import('./projectSync')
    await restoreMissingProjects(session)
    fetchCalls.length = 0
    await restoreMissingProjects(session)
    expect(fetchCalls.filter((p) => p.endsWith('/project.json'))).toHaveLength(0)
  })

  it('asks again once the remembered miss is a day old', async () => {
    window.localStorage.setItem(
      'noey:restore-missing',
      JSON.stringify({ 'gone-1': Date.now() - 25 * 60 * 60 * 1000, 'gone-2': Date.now() })
    )
    const { restoreMissingProjects } = await import('./projectSync')
    await restoreMissingProjects(session)
    expect(fetchCalls.filter((p) => p.endsWith('/project.json'))).toEqual([
      '/videos/gone-1/files/project.json'
    ])
  })
})
