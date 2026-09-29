import { describe, expect, it } from 'vitest'
import { initMonitoring, monitoringConfig, scrubEvent, scrubText, scrubUrl } from './monitoring'

describe('monitoringConfig', () => {
  it('is off without a DSN, or with a malformed one', () => {
    expect(monitoringConfig({})).toBeNull()
    expect(monitoringConfig({ dsn: '   ' })).toBeNull()
    expect(monitoringConfig({ dsn: 'not a url' })).toBeNull()
    expect(monitoringConfig({ dsn: 'javascript:alert(1)' })).toBeNull()
  })

  it('reads a DSN with defaults', () => {
    expect(monitoringConfig({ dsn: 'https://k@o1.ingest.us.sentry.io/2' })).toEqual({
      dsn: 'https://k@o1.ingest.us.sentry.io/2',
      environment: 'production',
      release: ''
    })
  })
})

describe('initMonitoring', () => {
  it('does nothing and returns no root hooks when the build has no DSN', async () => {
    expect(await initMonitoring()).toEqual({})
  })
})

describe('scrubbing', () => {
  it('masks emails, bearer tokens, JWTs and URL queries in text', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdefghijk'
    const out = scrubText(
      `user a.b+c@example.co.th failed Bearer abc.def-123 ${jwt} at https://x.test/auth/google/callback?code=4/secret&state=s`
    )
    expect(out).not.toMatch(/example\.co\.th|abc\.def-123|eyJ|4\/secret|state=s/)
    expect(out).toContain('https://x.test/auth/google/callback?[Filtered]')
  })

  it('masks the phone-transfer token in a /transfer/<token> path', () => {
    const token = '0123456789abcdef0123456789abcdef'
    const page = `https://editor.noey.test/transfer/${token}`
    expect(scrubUrl(page)).toBe('https://editor.noey.test/transfer/[Filtered]')
    expect(scrubText(`upload failed on /transfer/${token} (HTTP 500)`)).not.toContain(token)
    const event = scrubEvent({
      transaction: `/transfer/${token}`,
      request: { url: page },
      breadcrumbs: [{ message: `navigation to ${page}`, data: { from: page, to: page, url: page } }]
    })
    expect(JSON.stringify(event)).not.toContain(token)
  })

  it('drops query and fragment from URLs', () => {
    expect(scrubUrl('https://s/auth/google/callback?code=1&state=2#x')).toBe(
      'https://s/auth/google/callback'
    )
  })

  it('removes request extras and user, filters secret-looking keys', () => {
    const event = scrubEvent({
      message: 'login failed for me@x.com',
      user: { email: 'me@x.com', ip_address: '1.2.3.4' },
      request: {
        url: 'https://s/p?token=abc',
        headers: { Authorization: 'Bearer x' },
        cookies: { a: 'b' },
        data: '{"password":"p"}',
        query_string: 'token=abc'
      },
      exception: { values: [{ value: 'HTTP 401 for x@y.co' }] },
      breadcrumbs: [
        {
          message: 'fetch https://api/auth/me?t=1',
          data: { url: 'https://api/x?y=1', status_code: 401, access_token: 't', code: 'c' }
        }
      ],
      extra: { refreshToken: 'r', note: 'keep' }
    })
    expect(event.user).toBeUndefined()
    expect(event.request).toEqual({ url: 'https://s/p' })
    expect(event.message).toBe('login failed for [email]')
    expect(event.exception?.values?.[0].value).toBe('HTTP 401 for [email]')
    const crumb = event.breadcrumbs![0]
    expect(crumb.message).toBe('fetch https://api/auth/me?[Filtered]')
    expect(crumb.data).toEqual({
      url: 'https://api/x',
      status_code: 401,
      access_token: '[Filtered]',
      code: '[Filtered]'
    })
    expect(event.extra).toEqual({ refreshToken: '[Filtered]', note: 'keep' })
  })
})
