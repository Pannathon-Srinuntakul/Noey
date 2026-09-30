import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The editor is a signed-in app; people find Noey through the marketing site.
// Three layers so a crawler that reads only one of them still stays out.
const read = (rel: string): string => readFileSync(resolve(__dirname, '../..', rel), 'utf8')

describe('editor stays out of search results', () => {
  it('index.html carries a robots noindex meta tag', () => {
    expect(read('index.html')).toMatch(/<meta name="robots" content="noindex, nofollow" \/>/)
  })

  it('robots.txt disallows everything', () => {
    expect(read('public/robots.txt')).toMatch(/User-agent: \*\s+Disallow: \/\s*$/)
  })

  it('nginx sends X-Robots-Tag in every block that sets its own headers', () => {
    const conf = read('nginx.conf.template')
    const csp = conf.match(/add_header Content-Security-Policy/g)?.length ?? 0
    const robots = conf.match(/add_header X-Robots-Tag "noindex, nofollow" always;/g)?.length ?? 0
    expect(csp).toBeGreaterThan(0)
    expect(robots).toBe(csp)
  })
})
