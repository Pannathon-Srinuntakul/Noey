import { describe, expect, it } from 'vitest'
import { isReloadShortcut } from './reloadGuard'

type Shortcut = Parameters<typeof isReloadShortcut>[0]

const key = (
  k: string,
  code: string,
  mods: { metaKey?: boolean; ctrlKey?: boolean } = {}
): Shortcut => ({
  key: k,
  code,
  metaKey: mods.metaKey ?? false,
  ctrlKey: mods.ctrlKey ?? false
})

describe('isReloadShortcut', () => {
  it('catches F5 and Cmd/Ctrl+R', () => {
    expect(isReloadShortcut(key('F5', 'F5'))).toBe(true)
    expect(isReloadShortcut(key('r', 'KeyR', { metaKey: true }))).toBe(true)
    expect(isReloadShortcut(key('R', 'KeyR', { ctrlKey: true }))).toBe(true)
  })

  it('catches Cmd+R with a Thai layout active', () => {
    expect(isReloadShortcut(key('พ', 'KeyR', { metaKey: true }))).toBe(true)
  })

  it('leaves plain typing and other shortcuts alone', () => {
    expect(isReloadShortcut(key('r', 'KeyR'))).toBe(false)
    expect(isReloadShortcut(key('s', 'KeyS', { metaKey: true }))).toBe(false)
  })
})
