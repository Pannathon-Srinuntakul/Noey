import { describe, expect, it } from 'vitest'
import { join, normalize } from 'path'
import { mediaPathForUrl } from './mediaPath'

const ROOT = normalize(join('C:', 'users', 'x', 'projects'))
const INBOX = normalize(join('C:', 'users', 'x', 'lan-inbox'))

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

  // The inbox host — how the wizard draws a thumbnail for a phone upload.
  describe('inbox host', () => {
    it('resolves a file in the inbox', () => {
      const abs = mediaPathForUrl('media://inbox/9f2c-4a.mp4', ROOT, INBOX)
      expect(abs).toBe(normalize(join(INBOX, '9f2c-4a.mp4')))
    })

    it('is off unless an inbox dir is supplied', () => {
      expect(mediaPathForUrl('media://inbox/9f2c-4a.mp4', ROOT)).toBeNull()
    })

    it('allows exactly one segment — no subdirectories, no traversal', () => {
      expect(mediaPathForUrl('media://inbox/sub/file.mp4', ROOT, INBOX)).toBeNull()
      expect(mediaPathForUrl('media://inbox/..%5C..%5Csecret.txt', ROOT, INBOX)).toBeNull()
      expect(mediaPathForUrl('media://inbox/%2E%2E%2Fsecret.txt', ROOT, INBOX)).toBeNull()
      expect(mediaPathForUrl('media://inbox/', ROOT, INBOX)).toBeNull()
    })

    it('leaves the project host alone', () => {
      const abs = mediaPathForUrl('media://project/abc/final.mp4', ROOT, INBOX)
      expect(abs).toBe(normalize(join(ROOT, 'abc', 'final.mp4')))
    })
  })
})
