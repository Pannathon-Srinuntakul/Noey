/**
 * Staging paths.
 *
 * Two bugs lived here, both invisible until a second thing happened at the
 * same time as the first.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { stagingDir } from './picked'

describe('stagingDir', () => {
  it('is namespaced per project', () => {
    // ingest ends by deleting its project's staging directory. When staging
    // was one flat root, the wizard's "one project per file" mode had the
    // first import to finish delete every other import's sources mid-read.
    expect(stagingDir('aaa')).not.toEqual(stagingDir('bbb'))
    expect(stagingDir('aaa')).toContain('aaa')
  })
})

describe('the wizard', () => {
  const WIZARD = readFileSync(resolve(__dirname, '../pages/WizardPage.tsx'), 'utf8')

  it('stages picked files before writing anything to the project', () => {
    // A `picked://` id is backed by an in-memory Map. Persisting one into
    // project.json meant a reload before ingest finished — minutes, for a clip
    // that goes through a server conversion — left a project pointing at a
    // file that no longer existed anywhere: unimportable, and "ลองใหม่" could
    // not recover it either.
    expect(WIZARD).toContain('stageAll(')
    expect(WIZARD).toContain('pendingSources: stagedSources')
    expect(WIZARD).not.toContain('pendingSources: group.map((f) => f.path)')
  })
})

describe('ingest', () => {
  const INGEST = readFileSync(resolve(__dirname, '../engine/jobs/ingest.ts'), 'utf8')

  it('deletes only its own staging directory', () => {
    expect(INGEST).toContain('deleteDir(stagingDir(uid))')
    expect(INGEST).not.toContain("deleteDir('noeyfs://staging')")
  })

  it('honours the cancel signal', () => {
    // Only the encoder read `job.signal`, so หยุดงาน left a long import
    // decoding to completion — and because jobs are serialised per project,
    // the next thing the user started queued behind work the UI had already
    // said was stopped.
    expect(INGEST).toContain('throwIfAborted(signal)')
    expect(INGEST).toContain('transcodeToH264(blob, info, signal)')
  })
})
