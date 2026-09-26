/**
 * Storage-full handling: the pre-flight refusal and the after-the-fact
 * translation of whatever the browser threw.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  StorageFullError,
  describeStorageError,
  ensureRoomFor,
  fmtBytes,
  isStorageFullError
} from './storageQuota'

const GB = 1024 ** 3

function mockEstimate(est: { usage: number; quota: number } | null | (() => never)): void {
  const storage = {
    estimate: typeof est === 'function' ? est : async () => est
  }
  vi.stubGlobal('navigator', { storage })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ensureRoomFor', () => {
  it('passes when twice the bytes still fit', async () => {
    mockEstimate({ usage: 1 * GB, quota: 10 * GB })
    await expect(ensureRoomFor(2 * GB)).resolves.toBeUndefined()
  })

  it('refuses when twice the bytes would cross the quota, naming the numbers', async () => {
    mockEstimate({ usage: 7 * GB, quota: 10 * GB })
    const err = await ensureRoomFor(2 * GB).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(StorageFullError)
    const e = err as StorageFullError
    expect(e.needed).toBe(4 * GB)
    expect(e.message).toContain('4.0 GB') // needed
    expect(e.message).toContain('3.0 GB') // free
    expect(e.message).toContain('7.0 GB') // used
    expect(e.message).toContain('10.0 GB') // quota
    expect(e.message).toContain('ล้างสำเนา')
    expect(e.message).not.toMatch(/[A-Za-z]{6,}/) // Thai, not an API name
  })

  it('stays silent when the browser gives no estimate', async () => {
    mockEstimate(null)
    await expect(ensureRoomFor(50 * GB)).resolves.toBeUndefined()
  })

  it('stays silent when estimate() itself throws', async () => {
    mockEstimate(() => {
      throw new Error('blocked')
    })
    await expect(ensureRoomFor(50 * GB)).resolves.toBeUndefined()
  })

  it('stays silent when there is no navigator.storage at all', async () => {
    vi.stubGlobal('navigator', {})
    await expect(ensureRoomFor(50 * GB)).resolves.toBeUndefined()
  })

  it('ignores a zero or unknown size', async () => {
    mockEstimate({ usage: 10 * GB, quota: 10 * GB })
    await expect(ensureRoomFor(0)).resolves.toBeUndefined()
    await expect(ensureRoomFor(NaN)).resolves.toBeUndefined()
  })
})

describe('isStorageFullError / describeStorageError', () => {
  it('recognises the DOMException Chrome and Firefox throw', () => {
    const err = new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    expect(isStorageFullError(err)).toBe(true)
    expect(describeStorageError(err)).toContain('พื้นที่เก็บไฟล์ของเบราว์เซอร์เต็ม')
    expect(describeStorageError(err)).toContain('ล้างสำเนา')
  })

  it('recognises the legacy Safari name and code', () => {
    expect(isStorageFullError({ name: 'QUOTA_EXCEEDED_ERR', message: '' })).toBe(true)
    const legacy = new DOMException('x', 'QuotaExceededError')
    expect(legacy.code).toBe(22)
    expect(isStorageFullError(legacy)).toBe(true)
  })

  it('recognises the worker path, where only the message text survives', () => {
    // opfsWrite.ts re-throws the worker's reply as a plain Error; the worker
    // prefixes the name so the text still says what it was.
    expect(isStorageFullError(new Error('QuotaExceededError: The operation failed'))).toBe(true)
    expect(isStorageFullError(new Error('not enough space on the device'))).toBe(true)
  })

  it('returns the pre-flight error’s own sentence', () => {
    const err = new StorageFullError('พื้นที่ไม่พอ', 1, 2, 3)
    expect(describeStorageError(err)).toBe('พื้นที่ไม่พอ')
  })

  it('answers null for anything else', () => {
    expect(describeStorageError(new Error('ยกเลิกแล้ว'))).toBeNull()
    expect(describeStorageError(new DOMException('x', 'AbortError'))).toBeNull()
    expect(describeStorageError('string')).toBeNull()
    expect(describeStorageError(null)).toBeNull()
  })
})

describe('fmtBytes', () => {
  it('uses GB above a gigabyte and whole MB below', () => {
    expect(fmtBytes(1.5 * GB)).toBe('1.5 GB')
    expect(fmtBytes(640 * 1024 ** 2)).toBe('640 MB')
    expect(fmtBytes(10)).toBe('1 MB')
  })
})
