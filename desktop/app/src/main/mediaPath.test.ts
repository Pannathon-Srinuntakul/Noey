import { describe, expect, it } from 'vitest'
import { join, normalize } from 'path'
import { mediaPathForUrl } from './mediaPath'

const ROOT = normalize(join('C:', 'users', 'x', 'projects'))

describe('mediaPathForUrl', () => {
  it('resolves a normal project file', () => {
    const abs = mediaPathForUrl('media://project/abc-123/normalized/norm_000.mp4', ROOT)
    expect(abs).toBe(normalize(join(ROOT, 'abc-123', 'normalized', 'norm_000.mp4')))
  })

  it('decodes URL-encoded segments', () => {
    const abs = mediaPathForUrl('media://project/abc/frames/clip0_1%2E50.jpg', ROOT)
    expect(abs).toBe(normalize(join(ROOT, 'abc', 'frames', 'clip0_1.50.jpg')))
  })

  it('rejects or confines path traversal', () => {
    // Unencoded ../ collapses in the URL parser: "abc/../../secret.txt" → "/secret.txt"
    // → single segment (uid without file) → rejected.
    expect(mediaPathForUrl('media://project/abc/../../secret.txt', ROOT)).toBeNull()
    // %2E%2E also collapses during URL parsing → lands confined under ROOT.
    const collapsed = mediaPathForUrl('media://project/%2E%2E/%2E%2E/etc/passwd', ROOT)
    expect(collapsed === null || collapsed.startsWith(ROOT + '\\')).toBe(true)
    // Backslash-encoded traversal survives URL parsing — must be rejected.
    expect(mediaPathForUrl('media://project/abc/..%5C..%5Csecret.txt', ROOT)).toBeNull()
    expect(mediaPathForUrl('media://project/abc', ROOT)).toBeNull() // uid without file
  })

  it('rejects wrong scheme/host and malformed URLs', () => {
    expect(mediaPathForUrl('file:///C:/windows', ROOT)).toBeNull()
    expect(mediaPathForUrl('media://other/abc/file.mp4', ROOT)).toBeNull()
    expect(mediaPathForUrl('not a url', ROOT)).toBeNull()
    expect(mediaPathForUrl('media://project/', ROOT)).toBeNull()
  })
})
