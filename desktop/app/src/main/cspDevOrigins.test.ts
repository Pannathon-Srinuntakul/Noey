import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { cspDevOrigins, DEV_ORIGINS } from '../../electron.vite.config'

type Hooks = {
  configResolved: (c: { command: string }) => void
  transformIndexHtml: (html: string) => string
}

function transform(command: 'serve' | 'build'): string {
  const html = readFileSync(join(__dirname, '../renderer/index.html'), 'utf-8')
  const plugin = cspDevOrigins() as unknown as Hooks
  plugin.configResolved({ command })
  return plugin.transformIndexHtml(html)
}

describe('renderer CSP dev origins', () => {
  it('a production build does not allow the local port-8000 API', () => {
    const html = transform('build')
    expect(html).not.toContain('localhost:8000')
    expect(html).not.toContain('127.0.0.1:8000')
    expect(html).not.toContain('%DEV_ORIGINS%')
    expect(html).toContain('connect-src')
  })

  it('the dev server still does', () => {
    expect(transform('serve')).toContain(DEV_ORIGINS)
  })
})
