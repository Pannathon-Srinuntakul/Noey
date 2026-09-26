import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './api'
import { pollJob, type ApiSession, type JobStatus } from './videosLocalApi'

const session: ApiSession = { baseUrl: 'http://api', accessToken: 'a', refreshToken: 'r' }

const snap = (status: JobStatus['status'], progress = 0): JobStatus => ({
  id: 'j1',
  type: 'analyze',
  status,
  progress,
  result: null,
  error: null
})

/** Answers in order; a thrown entry is thrown. */
function script(...answers: (JobStatus | Error)[]): {
  fetchJob: () => Promise<JobStatus>
  calls: () => number
} {
  let i = 0
  return {
    fetchJob: () => {
      const a = answers[Math.min(i++, answers.length - 1)]
      return a instanceof Error ? Promise.reject(a) : Promise.resolve(a)
    },
    calls: () => i
  }
}

/** Run the fake clock until `p` settles or `maxMs` of fake time has passed. */
async function settle<T>(p: Promise<T>, maxMs: number): Promise<T> {
  let done = false
  // Both arms, so a rejection is observed while the clock runs.
  p.then(
    () => (done = true),
    () => (done = true)
  )
  for (let t = 0; t < maxMs && !done; t += 500) {
    await vi.advanceTimersByTimeAsync(500)
  }
  return p
}

describe('pollJob', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {
      noey: { log: { write: async () => undefined } },
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    })
    vi.stubGlobal('navigator', { onLine: true })
    vi.stubGlobal('document', { hidden: false })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('rides out transport errors and returns the job that finished', async () => {
    const s = script(
      snap('running', 10),
      new ApiError(0, 'เชื่อมต่อ server ไม่ได้'),
      new ApiError(502, 'Bad Gateway'),
      snap('running', 50),
      snap('ok', 100)
    )
    const ticks: number[] = []
    const result = await settle(
      pollJob(session, 'j1', (st) => ticks.push(st.progress), { fetchJob: s.fetchJob }),
      60_000
    )
    expect(result.status).toBe('ok')
    // The two failed polls produced no tick — the card never saw a failure.
    expect(ticks).toEqual([10, 50, 100])
  })

  it('backs off between retries: 2s, 4s, 8s, 16s, 30s, then gives up', async () => {
    const s = script(new ApiError(0, 'เชื่อมต่อ server ไม่ได้'))
    let failed: unknown = null
    const run = pollJob(session, 'j1', () => undefined, { fetchJob: s.fetchJob }).catch((e) => {
      failed = e
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(s.calls()).toBe(1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(s.calls()).toBe(2)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(s.calls()).toBe(3)
    await vi.advanceTimersByTimeAsync(8_000)
    expect(s.calls()).toBe(4)
    await vi.advanceTimersByTimeAsync(16_000)
    expect(s.calls()).toBe(5)
    expect(failed).toBeNull()
    await vi.advanceTimersByTimeAsync(30_000)
    await run
    expect(s.calls()).toBe(6)
    expect(failed).toBeInstanceOf(ApiError)
    expect((failed as ApiError).status).toBe(0)
  })

  it('does not retry an answer about the job itself (4xx)', async () => {
    const s = script(new ApiError(404, 'ไม่พบงาน'))
    await expect(
      settle(
        pollJob(session, 'j1', () => undefined, { fetchJob: s.fetchJob }),
        5_000
      )
    ).rejects.toMatchObject({ status: 404 })
    expect(s.calls()).toBe(1)
  })

  it('a successful answer resets the retry budget', async () => {
    const answers: (JobStatus | Error)[] = []
    for (let round = 0; round < 3; round++) {
      for (let k = 0; k < 4; k++) answers.push(new ApiError(503, 'down'))
      answers.push(snap('running', round))
    }
    answers.push(snap('ok', 100))
    const s = script(...answers)
    const result = await settle(
      pollJob(session, 'j1', () => undefined, { fetchJob: s.fetchJob }),
      10 * 60_000
    )
    expect(result.status).toBe('ok')
  })

  it('waits for the browser to come back online before asking again', async () => {
    let onlineHandler: (() => void) | null = null
    vi.stubGlobal('window', {
      noey: { log: { write: async () => undefined } },
      addEventListener: (name: string, cb: () => void) => {
        if (name === 'online') onlineHandler = cb
      },
      removeEventListener: () => undefined
    })
    const nav = { onLine: true }
    vi.stubGlobal('navigator', nav)
    const s = script(snap('running', 1), snap('ok', 100))
    const run = pollJob(session, 'j1', () => undefined, { fetchJob: s.fetchJob })
    await vi.advanceTimersByTimeAsync(0)
    expect(s.calls()).toBe(1)
    nav.onLine = false
    await vi.advanceTimersByTimeAsync(30_000)
    // Offline for 30 s: not one request, and no retry budget spent.
    expect(s.calls()).toBe(1)
    expect(onlineHandler).not.toBeNull()
    nav.onLine = true
    onlineHandler!()
    await settle(run, 5_000)
    expect(s.calls()).toBe(2)
  })

  it('polls every 5 s instead of 2 s while the tab is hidden', async () => {
    const doc = { hidden: true }
    vi.stubGlobal('document', doc)
    const s = script(snap('running', 1), snap('running', 2), snap('ok', 100))
    const run = pollJob(session, 'j1', () => undefined, { fetchJob: s.fetchJob })
    await vi.advanceTimersByTimeAsync(0)
    expect(s.calls()).toBe(1)
    await vi.advanceTimersByTimeAsync(2_500)
    expect(s.calls()).toBe(1)
    await vi.advanceTimersByTimeAsync(2_500)
    expect(s.calls()).toBe(2)
    await settle(run, 10_000)
  })

  it('an outage does not count towards the queued-stall deadline', async () => {
    const s = script(
      snap('queued', 0),
      new ApiError(0, 'offline'),
      new ApiError(0, 'offline'),
      snap('queued', 0),
      snap('running', 1),
      snap('ok', 100)
    )
    const result = await settle(
      pollJob(session, 'j1', () => undefined, { fetchJob: s.fetchJob, queuedStallMs: 5_000 }),
      60_000
    )
    expect(result.status).toBe('ok')
  })
})
