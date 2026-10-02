/**
 * A hard reload (Cmd+Shift+R) loads the page without the media worker, and
 * every `/media/...` clip then 404s. The gate must get control back — by a
 * claim, or by ONE ordinary reload — and must never reload in a loop.
 */
import { describe, expect, it, vi } from 'vitest'
import { ensureControlled, type ControlDeps } from './swControl'

interface Harness {
  deps: ControlDeps
  reload: ReturnType<typeof vi.fn>
  posted: unknown[]
  flag: () => string | null
}

function harness(opts: {
  controlled?: boolean
  claimWorks?: boolean
  flag?: string | null
  flagSticks?: boolean
}): Harness {
  let controlled = opts.controlled ?? false
  let flag: string | null = opts.flag ?? null
  const listeners = new Set<() => void>()
  const reload = vi.fn()
  const posted: unknown[] = []
  const deps: ControlDeps = {
    isControlled: () => controlled,
    activeWorker: () => ({
      postMessage: (msg) => {
        posted.push(msg)
        if (opts.claimWorks) {
          controlled = true
          for (const cb of [...listeners]) cb()
        }
      }
    }),
    onControllerChange: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    getFlag: () => flag,
    setFlag: (v) => {
      if (opts.flagSticks !== false) flag = v
    },
    clearFlag: () => {
      flag = null
    },
    reload,
    timeoutMs: 5
  }
  return { deps, reload, posted, flag: () => flag }
}

describe('ensureControlled', () => {
  it('does nothing on a page the worker already controls, and clears a leftover flag', async () => {
    const h = harness({ controlled: true, flag: '1' })
    expect(await ensureControlled(h.deps)).toBe('controlled')
    expect(h.reload).not.toHaveBeenCalled()
    expect(h.flag()).toBeNull()
  })

  it('asks the active worker to claim a hard-reloaded page', async () => {
    const h = harness({ claimWorks: true })
    expect(await ensureControlled(h.deps)).toBe('controlled')
    expect(h.posted).toEqual([{ type: 'sw:claim' }])
    expect(h.reload).not.toHaveBeenCalled()
  })

  it('reloads once when the claim does not take', async () => {
    const h = harness({ claimWorks: false })
    expect(await ensureControlled(h.deps)).toBe('reloading')
    expect(h.reload).toHaveBeenCalledTimes(1)
    expect(h.flag()).not.toBeNull()
  })

  it('never reloads a second time in the same session', async () => {
    const h = harness({ claimWorks: false, flag: 'already' })
    expect(await ensureControlled(h.deps)).toBe('uncontrolled')
    expect(h.reload).not.toHaveBeenCalled()
  })

  it('does not reload when the guard flag cannot be stored', async () => {
    const h = harness({ claimWorks: false, flagSticks: false })
    expect(await ensureControlled(h.deps)).toBe('uncontrolled')
    expect(h.reload).not.toHaveBeenCalled()
  })
})
