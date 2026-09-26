/**
 * Safari writes files through a different API, in a different thread.
 *
 * iOS Safari implements OPFS but not `FileSystemFileHandle.createWritable()`.
 * Every write in the app went through that one call, so an iPhone loaded the
 * app, accepted a clip, and died on the first write with
 * `c.createWritable is not a function` (live, 2026-09-09). The capability gate
 * had waved it through because it only asked whether OPFS existed.
 *
 * These are source checks: the behaviour needs a real browser (verified there
 * — whole-file write, out-of-order positional writes, and stale-lock
 * recovery), and what regresses in code review is the WIRING.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (rel: string): string => readFileSync(resolve(__dirname, rel), 'utf8')

describe('every write has a Safari path', () => {
  const fs = read('fs.ts')

  it('writeFileAtomic routes through the fallback', () => {
    const body = fs.slice(fs.indexOf('export async function writeFileAtomic'))
    expect(body.slice(0, 900)).toContain("writeCapability()) === 'worker'")
  })

  it('openStagedWrite routes through the fallback', () => {
    const body = fs.slice(fs.indexOf('export async function openStagedWrite'))
    expect(body.slice(0, 900)).toContain('workerStagedWrite(path)')
  })

  it('no other module calls createWritable directly', () => {
    // fs.ts is the only place allowed to touch it, and only on the fast path.
    const files = ['projects.ts', 'picked.ts', 'noey-web.ts', 'api.ts']
    for (const f of files) {
      expect(read(f), `${f} must write through fs.ts`).not.toContain('createWritable')
    }
  })
})

describe('the capability gate asks whether writing WORKS', () => {
  it('does not stop at getDirectory', () => {
    // The old check let an iPhone all the way to "เริ่มตัดต่อ" before failing.
    const cap = read('capability.ts')
    expect(cap).toContain('writeCapability()')
    expect(cap).toContain("!== 'none'")
  })
})

describe('the worker protocol cannot deadlock or cross wires', () => {
  const worker = read('opfsWriteWorker.ts')
  const client = read('opfsWrite.ts')

  it('separates the message id from the file id', () => {
    // They were the same value, so a reply could resolve the wrong pending
    // promise as soon as two operations on one file overlapped.
    expect(client).toContain('const id = `m${++seq}`')
    expect(client).toContain('w.postMessage({ ...payload, id, op }, transfer)')
    expect(worker).toContain('file?: string')
  })

  it('closes a stale handle instead of blocking on its lock', () => {
    // A sync access handle is an exclusive lock held until close(). An
    // interrupted write left one open, and re-opening that path froze the tab
    // with no error at all.
    const begin = worker.slice(worker.indexOf('async function begin'))
    expect(begin.slice(0, 900)).toContain('f.handle.close()')
  })

  it('an aborted stream releases the handle', () => {
    const staged = client.slice(client.indexOf('export async function workerStagedWrite'))
    expect(staged).toContain('async abort()')
  })

  it('publishes in slices rather than one buffer', () => {
    // The destination of a long render is hundreds of megabytes; materialising
    // it whole would undo the streaming this path exists to provide.
    expect(worker).toContain('COPY_SLICE')
  })

  it('publishes by rename where the browser has one, copying only as the fallback', () => {
    // A copy is the one publish a killed tab can leave half done — and the
    // truncated destination then "exists", which every reader takes to mean
    // "complete". `move()` changes one directory entry instead.
    const publish = worker.slice(worker.indexOf('async function publish'))
    expect(publish.indexOf('staging.move(f.name)')).toBeGreaterThan(-1)
    expect(publish.indexOf('staging.move(f.name)')).toBeLessThan(publish.indexOf('COPY_SLICE'))
    // The exclusive lock is released BEFORE the rename is attempted.
    expect(publish.indexOf('f.handle.close()')).toBeLessThan(publish.indexOf('staging.move'))
  })

  it('a dead worker rejects every pending call instead of hanging them', () => {
    // No `error`/`messageerror` listener meant a worker that crashed (or
    // failed to load) left the render at its last percentage for ever.
    expect(client).toContain("addEventListener('error'")
    expect(client).toContain("addEventListener('messageerror'")
    const died = client.slice(client.indexOf('const died'))
    expect(died.slice(0, 400)).toContain('pending.clear()')
    expect(died.slice(0, 400)).toContain('p.reject(')
    // ...and the next call gets a fresh worker.
    expect(died.slice(0, 200)).toContain('current = null')
  })

  it('keeps the error NAME across the worker boundary', () => {
    // `QuotaExceededError` has to be recognisable on the main thread
    // (storageQuota.ts); the message alone is "The operation failed".
    expect(worker).toContain('err.name')
  })

  it('sends a Blob across in slices, never whole', () => {
    // A staged source clip is a Blob; `arrayBuffer()` on all of it put a
    // multi-gigabyte file in memory to copy it into a store it was already in.
    const body = client.slice(client.indexOf('export async function workerWriteFile'))
    expect(body).toContain('BLOB_SLICE')
    expect(body).toContain('data.slice(at')
  })
})
