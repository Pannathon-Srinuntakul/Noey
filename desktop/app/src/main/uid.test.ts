import { describe, expect, it } from 'vitest'
import { randomUUID } from 'crypto'
import { isSafeUid } from './uid'

describe('isSafeUid', () => {
  it('accepts real UUIDs and UUID-like ids', () => {
    expect(isSafeUid(randomUUID())).toBe(true)
    expect(isSafeUid('52fcfdf4-ab2e-4c5a-8000-5c1145aa4650')).toBe(true)
    expect(isSafeUid('abc_123-XYZ')).toBe(true)
  })

  it('rejects empty / whitespace / oversized', () => {
    expect(isSafeUid('')).toBe(false)
    expect(isSafeUid('   ')).toBe(false)
    expect(isSafeUid('a'.repeat(129))).toBe(false)
  })

  it('rejects path-traversal and separators (would escape projects root)', () => {
    expect(isSafeUid('..')).toBe(false)
    expect(isSafeUid('../..')).toBe(false)
    expect(isSafeUid('../../secret')).toBe(false)
    expect(isSafeUid('a/b')).toBe(false)
    expect(isSafeUid('a\\b')).toBe(false)
    expect(isSafeUid('.')).toBe(false)
  })

  it('rejects absolute paths and drive letters', () => {
    expect(isSafeUid('C:\\Windows')).toBe(false)
    expect(isSafeUid('/etc/passwd')).toBe(false)
    expect(isSafeUid('C:')).toBe(false)
  })

  it('rejects non-strings', () => {
    expect(isSafeUid(undefined)).toBe(false)
    expect(isSafeUid(null)).toBe(false)
    expect(isSafeUid(123)).toBe(false)
    expect(isSafeUid({})).toBe(false)
  })
})
