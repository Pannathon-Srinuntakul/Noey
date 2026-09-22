/**
 * The billing half of the local-render client: refusals become typed
 * `ApiError`s, `allow_wallet` is sent only with consent, and a job waiting
 * for one of the plan's slots is never mistaken for a wedged queue.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './api'
import { analyzeVideo, estimateUsage, planDub, pollJob, type ApiSession } from './videosLocalApi'

type FetchJob = {
  url: string
  method?: string
  headers?: Record<string, string>
  jsonBody?: string
  formFields?: Record<string, string>
}
type FetchResult = { ok: boolean; status: number; bodyText: string }

const session: ApiSession = { baseUrl: 'http://api', accessToken: 'a', refreshToken: 'r' }
let fetchMock: ReturnType<typeof vi.fn<(job: FetchJob) => Promise<FetchResult>>>

function reply(status: number, body: unknown): FetchResult {
  return { ok: status < 400, status, bodyText: JSON.stringify(body) }
}

beforeEach(() => {
  fetchMock = vi.fn<(job: FetchJob) => Promise<FetchResult>>()
  vi.stubGlobal('window', {
    noey: {
      api: { fetch: fetchMock },
      log: { write: vi.fn() },
      projects: { resolvePath: async (_uid: string, rel: string) => `/p/${rel}` }
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function job(
  status: string,
  result: Record<string, unknown> | null,
  error: string | null = null
): FetchResult {
  return reply(200, { id: 'j', type: 't', status, progress: 2, result, error })
}

describe('pollJob', () => {
  it('waits out the concurrency queue instead of calling it a stall', async () => {
    const waiting = job('queued', { step: 'waiting_slot', message: 'รอคิว' })
    fetchMock
      .mockResolvedValueOnce(waiting)
      .mockResolvedValueOnce(waiting)
      .mockResolvedValueOnce(waiting)
      .mockResolvedValueOnce(job('ok', { step: 'done' }))
    const ticks: unknown[] = []
    // A negative stall budget would fail any ordinary queued tick at once.
    const final = await pollJob(session, 'j', (s) => ticks.push(s.result), {
      intervalMs: 0,
      queuedStallMs: -1
    })
    expect(final.status).toBe('ok')
    expect(ticks).toHaveLength(4)
  })

  it('still reports a genuinely wedged queue', async () => {
    fetchMock.mockResolvedValue(job('queued', null))
    await expect(
      pollJob(session, 'j', () => undefined, { intervalMs: 0, queuedStallMs: -1 })
    ).rejects.toMatchObject({ status: 503 })
  })

  it('turns a stopped run into a typed refusal', async () => {
    fetchMock.mockResolvedValueOnce(
      job('error', { step: 'stopped', code: 'limit_stop', message: 'หยุดแล้ว' }, 'หยุดแล้ว')
    )
    const err = await pollJob(session, 'j', () => undefined, { intervalMs: 0 }).catch(
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).refusal?.code).toBe('limit_stop')
    expect((err as ApiError).detail).not.toMatch(/HTTP/)
  })

  it('keeps an ordinary failure as it was', async () => {
    fetchMock.mockResolvedValueOnce(job('error', { step: 'analyze' }, 'พัง'))
    const err = (await pollJob(session, 'j', () => undefined, { intervalMs: 0 }).catch(
      (e: unknown) => e
    )) as ApiError
    expect(err.status).toBe(500)
    expect(err.detail).toBe('พัง')
    expect(err.refusal).toBeNull()
  })
})

describe('start routes', () => {
  const proxies = [{ clip_id: 'c', file: 'clip0.mp4', durationSec: 10, order: 0 }]

  it('sends allow_wallet only with consent', async () => {
    fetchMock.mockResolvedValue(reply(202, { job_id: 'j' }))
    await analyzeVideo(session, 'uid', 'local', proxies)
    expect(fetchMock.mock.calls[0][0].formFields).not.toHaveProperty('allow_wallet')
    await analyzeVideo(session, 'uid', 'local', proxies, undefined, undefined, undefined, true)
    expect(fetchMock.mock.calls[1][0].formFields?.allow_wallet).toBe('true')

    await planDub(session, 'uid', 30, [10], true)
    expect(JSON.parse(fetchMock.mock.calls[2][0].jsonBody ?? '{}').allow_wallet).toBe(true)
  })

  it('carries the device id on every call', async () => {
    fetchMock.mockResolvedValue(reply(202, { job_id: 'j' }))
    await analyzeVideo(session, 'uid', 'local', proxies)
    expect(fetchMock.mock.calls[0][0].headers?.['X-Noey-Device']).toMatch(/^[a-f0-9]{32}$/)
  })

  it('turns a 402 into a refusal the card can act on', async () => {
    fetchMock.mockResolvedValue(
      reply(402, {
        detail: {
          code: 'limit_reached',
          window: 'weekly',
          label: 'Weekly limit',
          resets_at: null,
          wallet_can_cover: true,
          wallet_satang: 900,
          message: 'ใช้งานครบ Weekly limit แล้ว'
        }
      })
    )
    const err = (await analyzeVideo(session, 'uid', 'local', proxies).catch(
      (e: unknown) => e
    )) as ApiError
    expect(err.status).toBe(402)
    expect(err.refusal).toMatchObject({ code: 'limit_reached', walletCanCover: true })
    expect(err.detail).toBe('โควตารายสัปดาห์หมดแล้ว — ใช้ยอดเงินคงเหลือทำงานนี้ต่อได้')
  })

  it('asks for an estimate with the wizard body', async () => {
    fetchMock.mockResolvedValue(
      reply(200, {
        fits: 'plan',
        pct: { weekly: 3 },
        wallet_satang: 0,
        binding: 'weekly',
        resets_at: null,
        unlimited: false
      })
    )
    const body = { mode: 'dub_first', clips: [{ duration_sec: 10, has_audio: true }] }
    const est = await estimateUsage(session, body)
    expect(est.fits).toBe('plan')
    expect(fetchMock.mock.calls[0][0].url).toBe('http://api/usage/estimate')
    expect(JSON.parse(fetchMock.mock.calls[0][0].jsonBody ?? '{}')).toEqual(body)
  })
})
