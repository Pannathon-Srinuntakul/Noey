import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acquireProjectLock,
  holdsProjectLock,
  isCrossTabStorageError,
  resetProjectLocks
} from './projectLock'

/** A Web Locks stand-in: one origin-wide table, `ifAvailable` semantics. */
function fakeLocks(): {
  locks: LockManager
  heldNames: () => string[]
} {
  const taken = new Set<string>()
  const locks = {
    request: async (
      name: string,
      _opts: LockOptions,
      cb: (lock: Lock | null) => Promise<unknown> | unknown
    ): Promise<unknown> => {
      if (taken.has(name)) return cb(null)
      taken.add(name)
      try {
        return await cb({ name, mode: 'exclusive' })
      } finally {
        taken.delete(name)
      }
    },
    query: async () => ({ held: [], pending: [] })
  } as unknown as LockManager
  return { locks, heldNames: () => [...taken] }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('acquireProjectLock', () => {
  beforeEach(() => resetProjectLocks())
  afterEach(() => vi.unstubAllGlobals())

  it('takes the lock, and a second tab is refused until it is released', async () => {
    const { locks, heldNames } = fakeLocks()
    vi.stubGlobal('navigator', { locks })
    const mine = await acquireProjectLock('p1')
    expect(mine).not.toBeNull()
    expect(heldNames()).toEqual(['project:p1'])
    expect(holdsProjectLock('p1')).toBe(true)

    // "Another tab": bypass this tab's ref-count by asking the manager
    // directly, as a second page would.
    let other: Lock | null | undefined
    await locks.request('project:p1', { ifAvailable: true }, (l) => {
      other = l
    })
    expect(other).toBeNull()

    mine!.release()
    await flush()
    expect(heldNames()).toEqual([])
    expect(holdsProjectLock('p1')).toBe(false)
  })

  it('is ref-counted within one tab: the editor opening over a running job is not a conflict', async () => {
    const { locks, heldNames } = fakeLocks()
    vi.stubGlobal('navigator', { locks })
    const job = await acquireProjectLock('p1')
    const editor = await acquireProjectLock('p1')
    expect(editor).not.toBeNull()
    job!.release()
    await flush()
    expect(heldNames()).toEqual(['project:p1'])
    editor!.release()
    await flush()
    expect(heldNames()).toEqual([])
  })

  it('release is idempotent', async () => {
    const { locks, heldNames } = fakeLocks()
    vi.stubGlobal('navigator', { locks })
    const a = await acquireProjectLock('p1')
    const b = await acquireProjectLock('p1')
    a!.release()
    a!.release()
    await flush()
    expect(heldNames()).toEqual(['project:p1'])
    b!.release()
    await flush()
    expect(heldNames()).toEqual([])
  })

  it('resolves null when another tab already holds it', async () => {
    const { locks } = fakeLocks()
    vi.stubGlobal('navigator', { locks })
    let releaseOther: () => void = () => undefined
    void locks.request(
      'project:p1',
      { ifAvailable: true },
      () => new Promise<void>((r) => (releaseOther = r))
    )
    await flush()
    expect(await acquireProjectLock('p1')).toBeNull()
    expect(holdsProjectLock('p1')).toBe(false)
    releaseOther()
    await flush()
    expect(await acquireProjectLock('p1')).not.toBeNull()
  })

  it('is a no-op where the Web Locks API is missing', async () => {
    vi.stubGlobal('navigator', {})
    const lock = await acquireProjectLock('p1')
    expect(lock).not.toBeNull()
    expect(() => lock!.release()).not.toThrow()
  })

  it('names the OPFS cross-tab error and nothing else', () => {
    expect(isCrossTabStorageError({ name: 'NoModificationAllowedError' })).toBe(true)
    expect(isCrossTabStorageError(new Error('QuotaExceededError'))).toBe(false)
    expect(isCrossTabStorageError(null)).toBe(false)
  })
})

describe('two hooks in one tab asking at once', () => {
  it('share the one request instead of the second reporting its own tab as another', async () => {
    const { acquireProjectLock, resetProjectLocks, holdsProjectLock } =
      await import('./projectLock')
    resetProjectLocks()
    // A browser whose grant takes a tick, like the real one: the second
    // request arrives while the first is still being granted.
    const taken = new Set<string>()
    const locks = {
      request: (name: string, _opts: LockOptions, cb: (lock: Lock | null) => unknown) =>
        new Promise<void>((resolve) => {
          setTimeout(async () => {
            if (taken.has(name)) {
              await cb(null)
              resolve()
              return
            }
            taken.add(name)
            try {
              await cb({ name, mode: 'exclusive' } as Lock)
            } finally {
              taken.delete(name)
              resolve()
            }
          }, 0)
        }),
      query: async () => ({ held: [], pending: [] })
    } as unknown as LockManager
    vi.stubGlobal('navigator', { locks })
    const [a, b] = await Promise.all([acquireProjectLock('u1'), acquireProjectLock('u1')])
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(holdsProjectLock('u1')).toBe(true)
    a!.release()
    expect(holdsProjectLock('u1')).toBe(true) // b still counts
    b!.release()
    expect(holdsProjectLock('u1')).toBe(false)
    resetProjectLocks()
    vi.unstubAllGlobals()
  })
})
