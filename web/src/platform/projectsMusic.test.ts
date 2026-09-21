/**
 * Music files in a project folder.
 *
 * importMusic used to clear `music/` and overwrite a same-named file, so
 * undoing "เปลี่ยนเพลง" in the editor pointed at a file that was gone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const files = new Map<string, Blob>()

vi.mock('./picked', () => ({
  stageIntoStore: async (src: string) => src,
  stagingDir: (uid: string) => `noeyfs://staging/${uid}`
}))

vi.mock('./fs', () => ({
  projectFilePath: (uid: string, rel: string) => `p/${uid}/${rel}`,
  projectDirPath: (uid: string) => `p/${uid}`,
  readFile: async (path: string) => {
    const b = files.get(path)
    return b ? new File([b], path.split('/').pop() as string) : null
  },
  writeFileAtomic: async (path: string, data: Blob) => {
    files.set(path, data)
    return path
  },
  exists: async (path: string) => files.has(path),
  deleteFile: async (path: string) => {
    files.delete(path)
  },
  listDir: async (dir: string) =>
    [...files.keys()]
      .filter((k) => k.startsWith(`${dir}/`) && !k.slice(dir.length + 1).includes('/'))
      .map((k) => ({ name: k.slice(dir.length + 1), kind: 'file' as const })),
  deleteDir: async () => undefined,
  ensureProjectsRoot: async () => undefined,
  fileSize: async () => null,
  listProjectDir: async () => [],
  listProjectUids: async () => [],
  readJson: async () => null,
  SERVER_MANIFEST: '.server_manifest.json'
}))

import { importMusic, pruneMusic } from './projects'

beforeEach(() => {
  files.clear()
})

describe('importMusic', () => {
  it('keeps the track it replaces, so an undo can put it back', async () => {
    files.set('pick/a.mp3', new Blob(['a']))
    files.set('pick/b.mp3', new Blob(['b']))
    const first = await importMusic('u', 'pick/a.mp3')
    const second = await importMusic('u', 'pick/b.mp3')
    expect(first).toBe('music/a.mp3')
    expect(second).toBe('music/b.mp3')
    expect(files.has('p/u/music/a.mp3')).toBe(true)
  })

  it('never overwrites a same-named track', async () => {
    files.set('pick/a.mp3', new Blob(['a']))
    await importMusic('u', 'pick/a.mp3')
    expect(await importMusic('u', 'pick/a.mp3')).toBe('music/a-2.mp3')
    expect(await importMusic('u', 'pick/a.mp3')).toBe('music/a-3.mp3')
  })
})

describe('pruneMusic', () => {
  it('removes every track but the one attached', async () => {
    files.set('p/u/music/a.mp3', new Blob(['a']))
    files.set('p/u/music/b.mp3', new Blob(['b']))
    expect(await pruneMusic('u', 'music/b.mp3')).toBe(1)
    expect([...files.keys()]).toEqual(['p/u/music/b.mp3'])
    expect(await pruneMusic('u', undefined)).toBe(1)
    expect(files.size).toBe(0)
  })

  it('keeps every track a kept undo history can restore', async () => {
    files.set('p/u/music/a.mp3', new Blob(['a']))
    files.set('p/u/music/b.mp3', new Blob(['b']))
    files.set('p/u/music/c.mp3', new Blob(['c']))
    expect(await pruneMusic('u', ['music/c.mp3', 'music/a.mp3'])).toBe(1)
    expect([...files.keys()].sort()).toEqual(['p/u/music/a.mp3', 'p/u/music/c.mp3'])
  })
})
