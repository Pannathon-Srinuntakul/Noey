/**
 * pushProjectFiles against a fake store and server.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const local = new Map<string, Blob>()
let remote: { path: string; bytes: number }[] = []
let manifestStatus = 200
const puts: string[] = []

vi.mock('../platform/fs', () => ({
  projectFilePath: (_uid: string, rel: string) => rel,
  projectDirPath: (uid: string) => uid,
  readFile: async (path: string) => {
    const b = local.get(path)
    return b ? new File([b], path.split('/').pop() as string) : null
  },
  listDir: async () => [],
  listProjectUids: async () => [],
  readJson: async () => null,
  writeFileAtomic: async () => '',
  SERVER_MANIFEST: '.server_manifest.json'
}))

vi.mock('./authedFetch', () => ({
  authedFetch: async (_s: unknown, url: string, init?: RequestInit) => {
    if (!init) return new Response(JSON.stringify(remote), { status: manifestStatus })
    // This deploy has no bucket: every file goes through the API route.
    if (url.endsWith('/uploads')) return new Response('{}', { status: 409 })
    if (init.method === 'PUT') puts.push(decodeURIComponent(url.split('/files/')[1]))
    return new Response('{}')
  },
  serverMessage: async (_r: Response, fallback: string) => fallback
}))

import { pushProjectFiles } from './projectSync'

const session = {} as never

beforeEach(() => {
  local.clear()
  remote = []
  manifestStatus = 200
  puts.length = 0
})

describe('pushProjectFiles', () => {
  it('sends a project.json edit that kept the same byte size', async () => {
    // Music volume 0.25 -> 0.35 rewrites project.json at the same length; the
    // size match alone never uploaded it, and a second browser restored the
    // old value.
    const json = JSON.stringify({ music: { volume: 0.35 } })
    local.set('project.json', new Blob([json]))
    local.set('final.mp4', new Blob(['0123456789']))
    remote = [
      { path: 'project.json', bytes: json.length },
      { path: 'final.mp4', bytes: 10 }
    ]
    const res = await pushProjectFiles(session, 'u', 'r')
    expect(puts).toEqual(['project.json'])
    expect(res.uploaded).toBe(1)
  })
})

describe('when the server manifest cannot be read', () => {
  it('aborts the round instead of re-uploading everything', async () => {
    local.set('project.json', new Blob(['{}']))
    local.set('final.mp4', new Blob(['0123456789']))
    local.set('clips/clip_001.mp4', new Blob(['abc']))
    manifestStatus = 503
    await expect(pushProjectFiles(session, 'u', 'r')).rejects.toMatchObject({ status: 503 })
    // Not one byte went up on the strength of a guess about the server.
    expect(puts).toEqual([])
  })
})
