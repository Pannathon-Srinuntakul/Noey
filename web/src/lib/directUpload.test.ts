/**
 * The direct-to-bucket upload and its two fallbacks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Call = { url: string; method: string; body?: unknown }
const apiCalls: Call[] = []
const bucketCalls: Call[] = []
let ticketStatus = 200
let completeStatus = 200
let bucketMode: 'ok' | 'error' | 'unreachable' = 'ok'

vi.mock('./authedFetch', () => ({
  authedFetch: async (_s: unknown, url: string, init?: RequestInit) => {
    apiCalls.push({ url, method: init?.method ?? 'GET', body: init?.body })
    if (url.endsWith('/uploads')) {
      if (ticketStatus !== 200)
        return new Response('{"detail":"พื้นที่เก็บเต็มแล้ว"}', { status: ticketStatus })
      return new Response(
        JSON.stringify({
          url: 'https://bucket.test/videos/r/outputs/final.mp4?sig=1',
          method: 'PUT',
          headers: { 'Content-Type': 'video/mp4' },
          expires_in: 3600
        })
      )
    }
    if (url.endsWith('/uploads/complete')) {
      return new Response(JSON.stringify({ path: 'final.mp4', bytes: 10 }), {
        status: completeStatus
      })
    }
    return new Response('{}')
  },
  serverMessage: async (r: Response, fallback: string) =>
    (await r.json().catch(() => ({ detail: fallback }))).detail ?? fallback
}))

import { resetDirectUploadState, uploadDirect } from './directUpload'

const realFetch = globalThis.fetch
const session = {} as never
const file = new File(['0123456789'], 'final.mp4', { type: 'video/mp4' })

beforeEach(() => {
  apiCalls.length = 0
  bucketCalls.length = 0
  ticketStatus = 200
  completeStatus = 200
  bucketMode = 'ok'
  resetDirectUploadState()
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    bucketCalls.push({ url: String(url), method: init?.method ?? 'GET' })
    if (bucketMode === 'unreachable') throw new TypeError('Failed to fetch')
    return new Response('', { status: bucketMode === 'ok' ? 200 : 403 })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('uploadDirect', () => {
  it('signs, PUTs to the bucket without the bearer token, then confirms', async () => {
    expect(await uploadDirect(session, 'r', 'final.mp4', file)).toBe('direct')
    expect(apiCalls.map((c) => c.url)).toEqual(['/videos/r/uploads', '/videos/r/uploads/complete'])
    expect(JSON.parse(apiCalls[0]!.body as string)).toEqual({
      path: 'final.mp4',
      bytes: 10,
      content_type: 'video/mp4'
    })
    expect(bucketCalls).toEqual([
      { url: 'https://bucket.test/videos/r/outputs/final.mp4?sig=1', method: 'PUT' }
    ])
  })

  it('reports "unavailable" on a deploy with no bucket, touching nothing else', async () => {
    ticketStatus = 409
    expect(await uploadDirect(session, 'r', 'final.mp4', file)).toBe('unavailable')
    expect(bucketCalls).toEqual([])
    expect(apiCalls).toHaveLength(1)
  })

  it('falls back for the rest of the session when the bucket cannot be reached', async () => {
    bucketMode = 'unreachable'
    expect(await uploadDirect(session, 'r', 'final.mp4', file)).toBe('blocked')
    // The next file does not even ask for a ticket.
    expect(await uploadDirect(session, 'r', 'clips/c1.mp4', file)).toBe('blocked')
    expect(apiCalls.filter((c) => c.url.endsWith('/uploads'))).toHaveLength(1)
    expect(bucketCalls).toHaveLength(1)
  })

  it('surfaces a refusal from the server as the same error the API route gives', async () => {
    ticketStatus = 507
    await expect(uploadDirect(session, 'r', 'final.mp4', file)).rejects.toMatchObject({
      status: 507,
      message: 'พื้นที่เก็บเต็มแล้ว'
    })
    expect(bucketCalls).toEqual([])
  })

  it('does not hide a bucket that answered with an error behind the fallback', async () => {
    bucketMode = 'error'
    await expect(uploadDirect(session, 'r', 'final.mp4', file)).rejects.toMatchObject({
      status: 403
    })
    // Not blocked: the bucket is reachable, the ticket was the problem.
    bucketMode = 'ok'
    expect(await uploadDirect(session, 'r', 'final.mp4', file)).toBe('direct')
  })

  it('propagates a failed confirmation (the object was deleted again)', async () => {
    completeStatus = 507
    await expect(uploadDirect(session, 'r', 'final.mp4', file)).rejects.toMatchObject({
      status: 507
    })
  })
})
