/**
 * Settings → ล้างสำเนาในเครื่องนี้ must bring the projects straight back from
 * the server. It used to wipe the store and stop, and the projects page stayed
 * EMPTY until a full browser reload (owner, 2026-10-01).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** The fake local store: uid → project.json text. */
const local = new Map<string, string>()
const fetchCalls: string[] = []
/** Held open to model a restore that started BEFORE the wipe. */
let gateListing: Promise<void> | null = null

const SERVER = [
  { uid: 'r-1', origin: 'local', local: 'l-1' },
  { uid: 'r-2', origin: 'local', local: 'l-2' }
]

vi.mock('../platform/fs', () => ({
  listProjectUids: vi.fn(async () => [...local.keys()]),
  readFile: vi.fn(),
  listDir: vi.fn(),
  projectDirPath: (uid: string) => `/p/${uid}`,
  projectFilePath: (uid: string, rel: string) => `/p/${uid}/${rel}`,
  readJson: vi.fn(),
  writeFileAtomic: vi.fn(async (path: string, data: Uint8Array) => {
    const [, , uid, rel] = path.split('/')
    if (rel === 'project.json') local.set(uid, new TextDecoder().decode(data))
  }),
  SERVER_MANIFEST: 'server_manifest.json'
}))

vi.mock('./authedFetch', () => ({
  serverMessage: vi.fn(),
  authedFetch: vi.fn(async (_session: unknown, path: string) => {
    fetchCalls.push(path)
    if (path.startsWith('/videos?')) {
      if (gateListing) await gateListing
      return new Response(JSON.stringify(SERVER.map(({ uid, origin }) => ({ uid, origin }))), {
        status: 200
      })
    }
    const row = SERVER.find((r) => path === `/videos/${r.uid}/files/project.json`)
    if (row) {
      return new Response(
        JSON.stringify({ uid: row.local, name: row.local, remote: { uid: row.uid } }),
        { status: 200 }
      )
    }
    // The manifest listing: nothing on the server worth caching here.
    return new Response('[]', { status: 200 })
  })
}))

const session = {} as never
const store = new Map<string, string>()

;(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v)
  },
  noey: {
    projects: {
      list: async () => [...local.values()].map((t) => JSON.parse(t) as unknown)
    },
    storage: {
      clearAll: async () => {
        const n = local.size
        local.clear()
        return n
      }
    }
  },
  setTimeout: globalThis.setTimeout.bind(globalThis)
}

/** Put both server projects in the local store, as a browser that has them. */
function seedLocal(): void {
  for (const r of SERVER) {
    local.set(r.local, JSON.stringify({ uid: r.local, name: r.local, remote: { uid: r.uid } }))
  }
}

beforeEach(() => {
  local.clear()
  store.clear()
  fetchCalls.length = 0
  gateListing = null
  vi.resetModules()
})

describe('clearLocalCopy', () => {
  it('wipes the store and pulls every server project back', async () => {
    seedLocal()
    const { clearLocalCopy } = await import('./projectSync')
    const landed: number[] = []
    const { removed, restored } = await clearLocalCopy(session, () => landed.push(local.size))

    expect(removed).toBe(2)
    expect(await restored).toBe(2)
    expect([...local.keys()].sort()).toEqual(['l-1', 'l-2'])
    // The list is told as EACH one lands, not once at the end.
    expect(landed).toHaveLength(2)
  })

  it('still restores when a resync was already in flight at the wipe', async () => {
    seedLocal()
    const { clearLocalCopy, restoreMissingProjects } = await import('./projectSync')

    // A focus resync starts while the projects are still local...
    let open!: () => void
    gateListing = new Promise<void>((r) => (open = r))
    const early = restoreMissingProjects(session)
    await Promise.resolve()

    // ...the wipe lands under it...
    const { restored } = await clearLocalCopy(session)
    gateListing = null
    open()

    // ...and the projects still come back, each exactly once.
    expect((await early) + (await restored)).toBe(2)
    expect([...local.keys()].sort()).toEqual(['l-1', 'l-2'])
  })
})
