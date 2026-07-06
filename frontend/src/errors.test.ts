import { describe, expect, it } from 'vitest'
import { formatUserError } from './errors'

const CLOUDFLARE_520 = `litellm.exceptions.APIConnectionError: litellm.APIConnectionError: AnthropicException - {"type":"https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-520/","title":"Error 520: Web server is returning an unknown error","status":520,"detail":"The origin web server sent a response that Cloudflare could not parse.","instance":"a117c5c1fe75ee2d","error_code":520,"ray_id":"a117c5c1fe75ee2d","zone":"api.anthropic.com","cloudflare_error":true,"retryable":true}`

describe('formatUserError', () => {
  it('maps Cloudflare 520 LiteLLM blob to Thai', () => {
    const msg = formatUserError(CLOUDFLARE_520)
    expect(msg).not.toContain('litellm')
    expect(msg).not.toContain('cloudflare')
    expect(msg).not.toContain('ray_id')
    expect(msg).not.toContain('{')
    expect(msg).toContain('ลองใหม่')
  })
})
