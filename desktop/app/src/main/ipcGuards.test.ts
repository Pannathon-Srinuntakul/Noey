import { describe, expect, it } from 'vitest'
import { join, normalize, resolve } from 'path'
import {
  checkReadablePath,
  checkSidecarJob,
  FileGrants,
  hasMediaExtension,
  isAllowedApiUrl,
  isAllowedExternalUrl,
  isAppNavigation,
  openFolderTarget,
  vetApiFetchJob
} from './ipcGuards'

const API = 'https://noey-api-production.up.railway.app'
const ROOT = resolve('/data/noey/projects')
const INBOX = resolve('/data/noey/lan-inbox')
const PROJECT = join(ROOT, 'abc-123')

describe('isAllowedApiUrl', () => {
  it('allows the baked API origin only', () => {
    expect(isAllowedApiUrl(`${API}/videos/x/analyze-video`, API, false)).toBe(true)
    expect(isAllowedApiUrl('https://evil.example/collect', API, false)).toBe(false)
    expect(isAllowedApiUrl('http://noey-api-production.up.railway.app/x', API, false)).toBe(false)
    expect(isAllowedApiUrl('file:///etc/passwd', API, false)).toBe(false)
    expect(isAllowedApiUrl('http://192.168.1.1/admin', API, false)).toBe(false)
    expect(isAllowedApiUrl(`https://user:pw@noey-api-production.up.railway.app/`, API, false)).toBe(
      false
    )
    expect(isAllowedApiUrl('not a url', API, false)).toBe(false)
  })

  it('admits a loopback API only in a dev run', () => {
    expect(isAllowedApiUrl('http://localhost:8000/auth/login', API, false)).toBe(false)
    expect(isAllowedApiUrl('http://localhost:8000/auth/login', API, true)).toBe(true)
    expect(isAllowedApiUrl('http://127.0.0.1:8000/auth/login', API, true)).toBe(true)
    expect(isAllowedApiUrl('http://10.0.0.5:8000/', API, true)).toBe(false)
  })
})

describe('isAllowedExternalUrl', () => {
  it('opens https payment pages', () => {
    expect(isAllowedExternalUrl('https://checkout.stripe.com/c/pay/cs_test_1')).toBe(true)
    expect(isAllowedExternalUrl('https://billing.stripe.com/p/session/x')).toBe(true)
  })

  it('refuses other schemes and hosts', () => {
    expect(isAllowedExternalUrl('file://attacker/share/run.exe')).toBe(false)
    expect(isAllowedExternalUrl('ms-msdt:/id PCWDiagnostic')).toBe(false)
    expect(isAllowedExternalUrl('search-ms:query=x')).toBe(false)
    expect(isAllowedExternalUrl('http://checkout.stripe.com/x')).toBe(false)
    expect(isAllowedExternalUrl('https://evil.example/')).toBe(false)
    expect(isAllowedExternalUrl('https://checkout.stripe.com.evil.example/')).toBe(false)
  })
})

describe('isAppNavigation', () => {
  const fileApp = 'file:///C:/Program%20Files/Noey/resources/app.asar/out/renderer/index.html'
  it('keeps the packaged window on its own page', () => {
    expect(isAppNavigation(`${fileApp}#/projects`, fileApp)).toBe(true)
    // A dropped HTML file is a file: navigation to another path — refused.
    expect(isAppNavigation('file:///C:/Users/x/Downloads/evil.html', fileApp)).toBe(false)
    expect(isAppNavigation('https://evil.example/', fileApp)).toBe(false)
  })
  it('keeps the dev window on the dev server', () => {
    expect(isAppNavigation('http://localhost:5173/', 'http://localhost:5173')).toBe(true)
    expect(isAppNavigation('file:///tmp/evil.html', 'http://localhost:5173')).toBe(false)
    expect(isAppNavigation('http://localhost:5174/', 'http://localhost:5173')).toBe(false)
  })
})

describe('checkReadablePath / FileGrants', () => {
  it('reads inside the library and the inbox, or a granted file', () => {
    const grants = new FileGrants()
    expect(checkReadablePath(join(PROJECT, 'proxy', 'c0.mp4'), [ROOT, INBOX], grants)).toBe(
      normalize(join(PROJECT, 'proxy', 'c0.mp4'))
    )
    expect(() => checkReadablePath(join(INBOX, 'x.mp4'), [ROOT, INBOX], grants)).not.toThrow()
    const picked = resolve('/Users/me/Music/song.mp3')
    expect(() => checkReadablePath(picked, [ROOT], grants)).toThrow(/outside/)
    grants.add(picked)
    expect(checkReadablePath(picked, [ROOT], grants)).toBe(picked)
  })

  it('refuses traversal, relative paths and the root itself', () => {
    const grants = new FileGrants()
    expect(() => checkReadablePath(join(PROJECT, '..', '..', 'auth.bin'), [ROOT], grants)).toThrow()
    expect(() => checkReadablePath('proxy/c0.mp4', [ROOT], grants)).toThrow(/absolute/)
    expect(() => checkReadablePath(ROOT, [ROOT], grants)).toThrow()
    expect(() => checkReadablePath(resolve('/home/me/.ssh/id_rsa'), [ROOT], grants)).toThrow()
  })

  it('is case-insensitive when asked (Windows)', () => {
    const grants = new FileGrants(true)
    grants.add(resolve('/Users/Me/Song.MP3'))
    expect(grants.has(resolve('/users/me/song.mp3'))).toBe(true)
  })

  it('stays bounded', () => {
    const grants = new FileGrants(false, 2)
    grants.add(resolve('/a'))
    grants.add(resolve('/b'))
    grants.add(resolve('/c'))
    expect(grants.has(resolve('/a'))).toBe(false)
    expect(grants.list()).toHaveLength(2)
  })

  it('only admits media files for music', () => {
    expect(hasMediaExtension('/x/Song.MP3')).toBe(true)
    expect(hasMediaExtension('/x/clip.mov')).toBe(true)
    expect(hasMediaExtension('/x/auth.bin')).toBe(false)
    expect(hasMediaExtension('/x/id_rsa')).toBe(false)
  })
})

describe('vetApiFetchJob', () => {
  const opts = (grants = new FileGrants()): Parameters<typeof vetApiFetchJob>[1] => ({
    backendUrl: API,
    allowLocalDev: false,
    roots: [ROOT, INBOX],
    grants,
    realpath: async (p: string) => p
  })

  it('lets a normal upload through', async () => {
    await expect(
      vetApiFetchJob(
        {
          url: `${API}/videos/r/analyze-video`,
          formFiles: [{ field: 'files', path: join(PROJECT, 'proxy', 'c0.mp4') }]
        },
        opts()
      )
    ).resolves.toBeUndefined()
  })

  it('refuses another host', async () => {
    await expect(vetApiFetchJob({ url: 'https://evil.example/x' }, opts())).rejects.toThrow(
      /host other than the API/
    )
  })

  it('refuses uploading a file outside the library', async () => {
    await expect(
      vetApiFetchJob(
        {
          url: `${API}/videos/r/music`,
          formFiles: [{ field: 'file', path: resolve('/home/me/.ssh/id_rsa') }]
        },
        opts()
      )
    ).rejects.toThrow(/outside/)
  })

  it('follows a symlink before deciding', async () => {
    const linked = join(PROJECT, 'proxy', 'link.mp4')
    await expect(
      vetApiFetchJob(
        { url: `${API}/x`, formFiles: [{ field: 'f', path: linked }] },
        { ...opts(), realpath: async (p) => (p === linked ? resolve('/etc/shadow') : p) }
      )
    ).rejects.toThrow(/outside/)
  })

  it('uploads a file the user picked', async () => {
    const picked = resolve('/Users/me/Music/song.mp3')
    const grants = new FileGrants()
    grants.add(picked)
    await expect(
      vetApiFetchJob(
        { url: `${API}/videos/r/music`, formFiles: [{ field: 'file', path: picked }] },
        opts(grants)
      )
    ).resolves.toBeUndefined()
  })
})

describe('openFolderTarget', () => {
  const dirs = new Set([PROJECT, join(PROJECT, 'clips')])
  const isDir = (abs: string): boolean => dirs.has(abs)

  it('opens the project root and sub-directories', () => {
    expect(openFolderTarget(PROJECT, undefined, isDir)).toEqual({ action: 'open', path: PROJECT })
    expect(openFolderTarget(PROJECT, '.', isDir)).toEqual({ action: 'open', path: PROJECT })
    expect(openFolderTarget(PROJECT, 'clips', isDir).action).toBe('open')
  })

  it('never opens (executes) a file — reveals it instead', () => {
    expect(openFolderTarget(PROJECT, 'x.bat', isDir)).toEqual({
      action: 'reveal',
      path: join(PROJECT, 'x.bat')
    })
  })

  it('refuses a path outside the project', () => {
    expect(() => openFolderTarget(PROJECT, '../../..', isDir)).toThrow(/escapes/)
    expect(() => openFolderTarget(PROJECT, '../other-uid', isDir)).toThrow(/escapes/)
  })
})

describe('checkSidecarJob', () => {
  it('accepts a job on a real project', () => {
    expect(() => checkSidecarJob({ projectDir: PROJECT }, ROOT)).not.toThrow()
    expect(() =>
      checkSidecarJob({ projectDir: PROJECT, outName: 'highlights/h01.mp4' }, ROOT)
    ).not.toThrow()
    expect(() =>
      checkSidecarJob({ projectDir: PROJECT, output: join(PROJECT, 'out.mp4') }, ROOT)
    ).not.toThrow()
    expect(() => checkSidecarJob({ output: join(PROJECT, 'out.mp4') }, ROOT)).not.toThrow()
  })

  it('refuses a projectDir that is not a project', () => {
    expect(() => checkSidecarJob({ projectDir: resolve('/Users/me') }, ROOT)).toThrow(/projectDir/)
    expect(() => checkSidecarJob({ projectDir: ROOT }, ROOT)).toThrow(/projectDir/)
    expect(() => checkSidecarJob({ projectDir: join(PROJECT, 'clips') }, ROOT)).toThrow(
      /projectDir/
    )
    expect(() => checkSidecarJob({ projectDir: 'abc-123' }, ROOT)).toThrow(/projectDir/)
  })

  it('refuses outputs outside the project', () => {
    expect(() =>
      checkSidecarJob({ projectDir: PROJECT, output: resolve('/Users/me/.bashrc') }, ROOT)
    ).toThrow(/output/)
    expect(() =>
      checkSidecarJob({ projectDir: PROJECT, output: join(ROOT, 'other', 'x.mp4') }, ROOT)
    ).toThrow(/output/)
    expect(() => checkSidecarJob({ output: resolve('/tmp/x.mp4') }, ROOT)).toThrow(/output/)
    expect(() => checkSidecarJob({ projectDir: PROJECT, outName: '../../x.mp4' }, ROOT)).toThrow(
      /outName/
    )
    expect(() =>
      checkSidecarJob({ projectDir: PROJECT, outName: resolve('/tmp/x.mp4') }, ROOT)
    ).toThrow(/outName/)
  })
})
