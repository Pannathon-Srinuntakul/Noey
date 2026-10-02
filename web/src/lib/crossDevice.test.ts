/**
 * Two browsers, one project (production 2026-10-02, d02d2d5e): browser B
 * restored A's project mid-run, restarted it, failed on a clip A was still
 * uploading, wrote `error` over A's run — and then kept that `error` forever
 * after A finished. These pin both halves of the fix.
 */
import { describe, expect, it } from 'vitest'
import type { LocalProject } from '@renderer/platform/types'
import {
  failureVerdict,
  isMissingFileError,
  mayStillArrive,
  MissingFileError,
  reconcileWithServer,
  runIsElsewhere,
  shouldCheckServer
} from './crossDevice'

const A = 'device-a'
const B = 'device-b'

function record(over: Partial<LocalProject>): LocalProject {
  return {
    uid: 'local-1',
    name: 'คลิปรองเท้า',
    mode: 'dub_first',
    step: 'imported',
    createdAt: '2026-10-02T17:31:46.000Z',
    updatedAt: '2026-10-02T17:31:46.000Z',
    clips: [
      {
        id: 'c1',
        file: 'normalized/norm_000.mp4',
        durationSec: 60,
        width: 1080,
        height: 1920,
        fps: 30,
        hasAudio: true
      }
    ],
    remote: { uid: 'd02d2d5e-c068-46a2-bc3f-ba989815cdbd' },
    ...over
  } as LocalProject
}

describe('a file still uploading is not a failure', () => {
  const missing = new MissingFileError('noeyfs://projects/local-1/normalized/norm_000.mp4')

  it('recognises the engine’s missing-file error, typed or re-wrapped', () => {
    expect(isMissingFileError(missing)).toBe(true)
    expect(isMissingFileError(new Error(missing.message))).toBe(true)
    expect(isMissingFileError(new Error('ไม่พบไฟล์เสียงพากย์เดิม'))).toBe(false)
    expect(isMissingFileError(new Error('HTTP 500'))).toBe(false)
  })

  it('waits when this browser does not hold the footage', () => {
    expect(failureVerdict({ exc: missing, footageLocal: false, elsewhere: false })).toBe('wait')
  })

  it('still fails a run whose footage is here — that file really is gone', () => {
    expect(failureVerdict({ exc: missing, footageLocal: true, elsewhere: false })).toBe('fail')
  })

  it('never fails a run another browser owns, whatever went wrong', () => {
    expect(
      failureVerdict({ exc: new Error('HTTP 500'), footageLocal: false, elsewhere: true })
    ).toBe('wait')
  })

  it('fails an ordinary error on this browser’s own run', () => {
    expect(
      failureVerdict({ exc: new Error('HTTP 500'), footageLocal: false, elsewhere: false })
    ).toBe('fail')
  })
})

describe('who runs a busy step', () => {
  it('is the browser that wrote it', () => {
    expect(runIsElsewhere(record({ step: 'analyzing', runDevice: A }), B, true)).toBe(true)
    expect(runIsElsewhere(record({ step: 'analyzing', runDevice: B }), B, false)).toBe(false)
  })

  it('falls back to footage on a record from before runDevice', () => {
    const legacy = record({ step: 'analyzing' })
    expect(runIsElsewhere(legacy, B, false)).toBe(true)
    expect(runIsElsewhere(legacy, B, true)).toBe(false)
    expect(runIsElsewhere(legacy, B, null)).toBe(false)
  })

  it('does not apply to a resting step', () => {
    expect(runIsElsewhere(record({ step: 'waiting_vo', runDevice: A }), B, false)).toBe(false)
    expect(runIsElsewhere(record({ step: 'error', runDevice: A }), B, false)).toBe(false)
  })
})

describe('reconcileWithServer — the newest truthful record wins', () => {
  // B's stale copy: it wrote `error` at 17:31:58.
  const staleError = record({
    step: 'error',
    error: 'ไม่พบไฟล์ noeyfs://projects/local-1/normalized/norm_000.mp4',
    updatedAt: '2026-10-02T17:31:58.000Z',
    syncPending: true
  })
  // A's copy, uploaded after its silent render at 17:46:12.
  const serverWaiting = record({
    step: 'waiting_vo',
    runDevice: A,
    updatedAt: '2026-10-02T17:46:12.000Z',
    editScript: { segments: [{ order: 1 }] }
  })

  it('adopts a newer server copy over a stale local error (the d02d2d5e case)', () => {
    const out = reconcileWithServer({
      local: staleError,
      server: serverWaiting,
      row: { status: 'waiting_vo', updated_at: '2026-10-02T17:46:20.000Z' },
      me: B
    })
    expect(out?.step).toBe('waiting_vo')
    expect(out?.error).toBeUndefined()
    expect(out?.editScript).toEqual({ segments: [{ order: 1 }] })
    // The server's own time, so it does not look newer than the server.
    expect(out?.updatedAt).toBe('2026-10-02T17:46:12.000Z')
  })

  it('keeps local-only fields from this browser', () => {
    const out = reconcileWithServer({
      local: staleError,
      server: { ...serverWaiting, allowWallet: true } as LocalProject,
      row: { status: 'waiting_vo' },
      me: B
    })
    expect(out?.syncPending).toBe(true)
    expect(out?.allowWallet).toBeUndefined()
    expect(out?.uid).toBe(staleError.uid)
    expect(out?.createdAt).toBe(staleError.createdAt)
  })

  it('lets the server status beat a local error even when its json is older', () => {
    // A's project.json predates B's error, but A's later PATCH moved the row on.
    const olderJson = { ...serverWaiting, updatedAt: '2026-10-02T17:30:00.000Z' }
    const out = reconcileWithServer({
      local: staleError,
      server: olderJson,
      row: { status: 'done' },
      me: B
    })
    expect(out?.step).toBe('waiting_vo')
    expect(out?.error).toBeUndefined()
    // Never older than the record it replaces, or the pipeline host ignores it.
    expect(Date.parse(out!.updatedAt)).toBeGreaterThan(Date.parse(staleError.updatedAt))
  })

  it('takes the step from the row when the server json is the stale error itself', () => {
    // B's own `error` upload is what the server holds; the row says waiting_vo.
    const out = reconcileWithServer({
      local: staleError,
      server: { ...staleError, updatedAt: '2026-10-02T17:32:00.000Z' },
      row: { status: 'waiting_vo' },
      me: B
    })
    expect(out?.step).toBe('waiting_vo')
    expect(out?.error).toBeUndefined()
  })

  it('does not let a local error override server done/waiting_vo, and keeps a newer local resting record', () => {
    const localDone = record({ step: 'done', updatedAt: '2026-10-02T18:00:00.000Z' })
    expect(
      reconcileWithServer({
        local: localDone,
        server: { ...serverWaiting, updatedAt: '2026-10-02T17:46:12.000Z' },
        row: { status: 'waiting_vo' },
        me: B
      })
    ).toBeNull()
  })

  it('never replaces a run this browser is driving', () => {
    const live = record({
      step: 'final_rendering',
      runDevice: B,
      updatedAt: '2026-10-02T17:00:00.000Z'
    })
    expect(
      reconcileWithServer({
        local: live,
        server: serverWaiting,
        row: { status: 'waiting_vo' },
        me: B
      })
    ).toBeNull()
  })

  it('adopts the other browser’s progress over a busy step it owns', () => {
    const shownHere = record({
      step: 'analyzing',
      runDevice: A,
      updatedAt: '2026-10-02T17:33:00.000Z'
    })
    const out = reconcileWithServer({
      local: shownHere,
      server: serverWaiting,
      row: { status: 'waiting_vo' },
      me: B
    })
    expect(out?.step).toBe('waiting_vo')
  })

  it('adopts over a pre-runDevice busy record only when this browser lacks the footage', () => {
    // The production record: A's upload from an older build, step analyzing,
    // no runDevice, restored here without its clip.
    const legacy = record({ step: 'analyzing', updatedAt: '2026-10-02T17:33:00.000Z' })
    const args = { local: legacy, server: serverWaiting, row: { status: 'waiting_vo' }, me: B }
    expect(reconcileWithServer({ ...args, footageLocal: false })?.step).toBe('waiting_vo')
    // With the footage here it is this browser's own interrupted run.
    expect(reconcileWithServer({ ...args, footageLocal: true })).toBeNull()
  })

  it('keeps the local record when the server has nothing newer', () => {
    expect(
      reconcileWithServer({
        local: serverWaiting,
        server: serverWaiting,
        row: { status: 'waiting_vo' },
        me: B
      })
    ).toBeNull()
    expect(
      reconcileWithServer({ local: staleError, server: null, row: { status: 'waiting_vo' }, me: B })
    ).toBeNull()
  })

  it('does not adopt a different project', () => {
    expect(
      reconcileWithServer({
        local: staleError,
        server: { ...serverWaiting, uid: 'other' },
        row: { status: 'waiting_vo' },
        me: B
      })
    ).toBeNull()
  })
})

describe('shouldCheckServer — which known projects are worth a fetch', () => {
  it('checks a stale error the server has moved past', () => {
    const local = record({ step: 'error', updatedAt: '2026-10-02T18:00:00.000Z' })
    expect(
      shouldCheckServer(local, { status: 'waiting_vo', updated_at: '2026-10-02T17:00:00Z' }, B)
    ).toBe(true)
  })

  it('checks a busy step another browser owns', () => {
    expect(
      shouldCheckServer(record({ step: 'analyzing', runDevice: A }), { status: 'processing' }, B)
    ).toBe(true)
  })

  it('skips this browser’s own live run and an up-to-date resting record', () => {
    expect(
      shouldCheckServer(
        record({ step: 'analyzing', runDevice: B }),
        { status: 'processing', updated_at: '2030-01-01T00:00:00Z' },
        B
      )
    ).toBe(false)
    const resting = record({ step: 'done', updatedAt: '2026-10-02T18:00:00.000Z' })
    expect(
      shouldCheckServer(resting, { status: 'done', updated_at: '2026-10-02T17:59:00Z' }, B)
    ).toBe(false)
    expect(
      shouldCheckServer(resting, { status: 'done', updated_at: '2026-10-02T18:01:00Z' }, B)
    ).toBe(true)
  })
})

describe('mayStillArrive', () => {
  const now = Date.parse('2026-10-02T17:50:00.000Z')
  it('is true for a recent record another browser wrote', () => {
    expect(
      mayStillArrive(record({ runDevice: A, updatedAt: '2026-10-02T17:46:12.000Z' }), B, now)
    ).toBe(true)
  })
  it('is false for this browser’s own record, an old one, or one with no server row', () => {
    expect(
      mayStillArrive(record({ runDevice: B, updatedAt: '2026-10-02T17:46:12.000Z' }), B, now)
    ).toBe(false)
    expect(
      mayStillArrive(record({ runDevice: A, updatedAt: '2026-10-02T16:00:00.000Z' }), B, now)
    ).toBe(false)
    expect(mayStillArrive(record({ runDevice: A, remote: undefined }), B, now)).toBe(false)
  })
})
