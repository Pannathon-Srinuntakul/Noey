import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const refresh = vi.fn()
vi.mock('./api', () => ({ refresh: (...args: unknown[]) => refresh(...args) }))

import { refreshOnce, resetRefreshState } from './tokenRefresh'

const pair = (n: number): { access_token: string; refresh_token: string; token_type: string } => ({
  access_token: `access-${n}`,
  refresh_token: `refresh-${n}`,
  token_type: 'bearer'
})

describe('refreshOnce', () => {
  beforeEach(() => {
    resetRefreshState()
    refresh.mockReset()
  })
  afterEach(() => vi.useRealTimers())

  it('shares one request between callers holding the same refresh token', async () => {
    let settle!: (p: unknown) => void
    refresh.mockImplementation(() => new Promise((r) => (settle = r)))
    const session = { baseUrl: 'http://api', refreshToken: 'refresh-0' }
    const a = refreshOnce(session)
    const b = refreshOnce(session)
    const c = refreshOnce({ ...session })
    expect(refresh).toHaveBeenCalledTimes(1)
    settle(pair(1))
    await expect(Promise.all([a, b, c])).resolves.toEqual([pair(1), pair(1), pair(1)])
  })

  it('hands a late caller with the ROTATED token the pair that replaced it', async () => {
    refresh.mockResolvedValueOnce(pair(1))
    const session = { baseUrl: 'http://api', refreshToken: 'refresh-0' }
    await refreshOnce(session)
    // A request built before the rotation still carries refresh-0 — sending
    // it would be a reuse, and reuse revokes the session.
    await expect(
      refreshOnce({ baseUrl: 'http://api', refreshToken: 'refresh-0' })
    ).resolves.toEqual(pair(1))
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('refreshes again once the caller holds the new token', async () => {
    refresh.mockResolvedValueOnce(pair(1)).mockResolvedValueOnce(pair(2))
    const first = await refreshOnce({ baseUrl: 'http://api', refreshToken: 'refresh-0' })
    const second = await refreshOnce({ baseUrl: 'http://api', refreshToken: first.refresh_token })
    expect(second).toEqual(pair(2))
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('does not remember a pair the server did not rotate, and forgets one after the window', async () => {
    vi.useFakeTimers()
    // Same refresh token back: nothing to remember, so the next call is live.
    refresh.mockResolvedValueOnce({ ...pair(1), refresh_token: 'refresh-0' })
    await refreshOnce({ baseUrl: 'http://api', refreshToken: 'refresh-0' })
    refresh.mockResolvedValueOnce(pair(2))
    await refreshOnce({ baseUrl: 'http://api', refreshToken: 'refresh-0' })
    expect(refresh).toHaveBeenCalledTimes(2)
    // Rotated now; after the window the old token is no longer answered.
    vi.setSystemTime(Date.now() + 3 * 60 * 1000)
    refresh.mockRejectedValueOnce(new Error('401'))
    await expect(refreshOnce({ baseUrl: 'http://api', refreshToken: 'refresh-0' })).rejects.toThrow(
      '401'
    )
    expect(refresh).toHaveBeenCalledTimes(3)
  })

  it('lets every sharer see the failure, and retries on the next call', async () => {
    refresh.mockRejectedValueOnce(new Error('dead')).mockResolvedValueOnce(pair(1))
    const session = { baseUrl: 'http://api', refreshToken: 'refresh-0' }
    const a = refreshOnce(session)
    const b = refreshOnce(session)
    await expect(a).rejects.toThrow('dead')
    await expect(b).rejects.toThrow('dead')
    await expect(refreshOnce(session)).resolves.toEqual(pair(1))
  })
})
