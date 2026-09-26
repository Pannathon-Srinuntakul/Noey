/**
 * Which dropped files count as video.
 *
 * Windows reports `type === ''` for any extension its registry has no
 * player for, and the filter `type.startsWith('video/')` threw those away
 * without a word — a `.mov` from a phone, dragged in, produced an empty list.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  VIDEO_EXTENSIONS,
  isVideoFile,
  splitVideoFiles,
  toPickedVideoFiles,
  toPickedVideoFilesDetailed
} from './pickVideoFiles'

function file(name: string, type: string): File {
  return new File([new Uint8Array(4)], name, { type })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isVideoFile', () => {
  it('accepts any video/* MIME type', () => {
    expect(isVideoFile({ name: 'x.bin', type: 'video/quicktime' })).toBe(true)
  })

  it('accepts a known extension when the type is empty', () => {
    for (const ext of VIDEO_EXTENSIONS) {
      expect(isVideoFile({ name: `clip${ext}`, type: '' }), ext).toBe(true)
      expect(isVideoFile({ name: `CLIP${ext.toUpperCase()}`, type: '' }), ext).toBe(true)
    }
  })

  it('rejects other files, typed or not', () => {
    expect(isVideoFile({ name: 'notes.txt', type: 'text/plain' })).toBe(false)
    expect(isVideoFile({ name: 'photo.jpg', type: '' })).toBe(false)
    expect(isVideoFile({ name: 'README', type: '' })).toBe(false)
  })
})

describe('splitVideoFiles', () => {
  it('keeps order and names what it dropped', () => {
    const { accepted, rejected } = splitVideoFiles([
      file('a.mov', ''),
      file('notes.txt', 'text/plain'),
      file('b.mp4', 'video/mp4'),
      file('c.jpg', 'image/jpeg')
    ])
    expect(accepted.map((f) => f.name)).toEqual(['a.mov', 'b.mp4'])
    expect(rejected).toEqual(['notes.txt', 'c.jpg'])
  })
})

describe('toPickedVideoFiles', () => {
  it('registers accepted files and reports the rest, with the old shape intact', () => {
    const register = vi.fn((f: File) => `picked://1-${f.name}`)
    vi.stubGlobal('window', { noey: { pick: { register } } })
    const files = [file('a.mov', ''), file('notes.txt', 'text/plain')]

    const detailed = toPickedVideoFilesDetailed(files)
    expect(detailed.picked.map((p) => p.path)).toEqual(['picked://1-a.mov'])
    expect(detailed.rejected).toEqual(['notes.txt'])

    // The array form other call sites use is unchanged.
    expect(toPickedVideoFiles(files).map((p) => p.name)).toEqual(['a.mov'])
    expect(register).toHaveBeenCalledTimes(2)
  })
})
