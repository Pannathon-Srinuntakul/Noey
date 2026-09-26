/**
 * The store's atomic contract, checked against the source.
 *
 * OPFS needs a real browser; what regresses in review is the SHAPE of a
 * write — a second copy that sneaks back in, a publish that copies where it
 * could rename, a sweeper that forgets one of the leftovers.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const fs = readFileSync(resolve(__dirname, 'fs.ts'), 'utf8')

describe('writeFileAtomic on the main thread', () => {
  const body = fs.slice(
    fs.indexOf('export async function writeFileAtomic'),
    fs.indexOf('export interface StagedWrite')
  )

  it('replaces an existing file in place, stages a NEW one under a dot-name', () => {
    // A replacement rides the writable's swap file (readers see the old
    // bytes until close). A new file cannot: `getFileHandle(create)` makes
    // an empty entry at once, and the server sync's PUT of a fresh
    // project.json died with net::ERR_UPLOAD_FILE_CHANGED when it caught it
    // (live, 2026-09-27). So a new file is staged and renamed in.
    expect(body).toContain('exists ? name : `.${name}.part`')
    expect(body).toContain('if (!exists) await publishStaged(dir, target, name)')
    expect(body.match(/createWritable\(\)/g)?.length).toBe(1)
  })

  it('aborts the writable on failure so the old file survives', () => {
    expect(body).toContain('writable.abort()')
  })
})

describe('openStagedWrite on the main thread', () => {
  it('still stages, because mediabunny CLOSES the stream on cancel', () => {
    // A closed swap-file writable commits; straight-to-destination would
    // publish every failed render as a truncated MP4.
    const body = fs.slice(fs.indexOf('export async function openStagedWrite'))
    expect(body).toContain('`.${name}.part`')
    expect(body).toContain('publishStaged(dir, staging, name)')
  })

  it('publishes by rename where move() exists, copying only as the fallback', () => {
    const body = fs.slice(
      fs.indexOf('export async function publishStaged'),
      fs.indexOf('export async function openStagedWrite')
    )
    expect(body.indexOf('movable.move(name)')).toBeGreaterThan(-1)
    expect(body.indexOf('movable.move(name)')).toBeLessThan(body.indexOf('dest.createWritable()'))
    // The fallback copy is itself atomic (swap file) and drops the staging file.
    expect(body).toContain('out.abort()')
    expect(body).toContain('dir.removeEntry(from.name)')
  })
})

describe('sweepStaleFiles', () => {
  const body = fs.slice(fs.indexOf('export async function sweepStaleFiles'))

  it('is exported', () => {
    expect(body.length).toBeGreaterThan(0)
  })

  it('knows every leftover a killed tab can leave', () => {
    expect(fs).toContain('/^\\..+\\.part$/')
    expect(fs).toContain('/\\.videoonly\\.mp4$/')
    expect(fs).toContain("'.clips_next'")
    expect(fs).toContain("'.opfs-write-probe'")
  })

  it('keeps staged sources a project row still points at', () => {
    // `pendingSources` is what "ลองใหม่" on a failed import re-reads; a
    // sweep that took them would turn a retry into "ไฟล์หายไปแล้ว".
    expect(body).toContain('pendingSources')
    expect(body).toContain('if (referenced) continue')
  })

  it('applies the age rule to render leftovers, never to orphaned staging', () => {
    expect(body).toContain('olderThan(dir, name)')
    const stagingPart = body.slice(body.indexOf('// Staging:'))
    expect(stagingPart.slice(0, 600)).not.toContain('olderThan')
  })

  it('lists a directory before removing from it', () => {
    expect(body.indexOf('await listed(')).toBeGreaterThan(-1)
    expect(body).not.toMatch(
      /for await \(const \[[^\]]+\] of entriesOf\([a-z]+\)\) \{\s*\n\s*if[^\n]*\n[^\n]*removeEntry/
    )
  })
})
