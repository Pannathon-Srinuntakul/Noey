import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * Focus is ONE ring, and it is the OUTER one.
 *
 * `assets/main.css` draws a global `*:focus-visible` accent outline around
 * every focusable element. Anything that ALSO paints an accent border, ring or
 * shadow on focus draws a second gold rectangle just inside the first. That was
 * fixed once on 2026-08-13, and came straight back the next time someone
 * hand-rolled a field instead of reusing `ui/Input` — a comment in one file
 * cannot stop that, so the rule is a test.
 *
 * If a design ever genuinely needs its own ring, opt the element out of the
 * global outline with `data-focus-ring="none"` instead of stacking a second one.
 */
const ROOT = join(__dirname, '..')
const BANNED = [/focus:border-accent/, /focus:ring/, /focus-visible:ring/, /focus:shadow/]

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sources(full, out)
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

describe('focus ring', () => {
  it('is never stacked on top of the global focus-visible outline', () => {
    const offenders: string[] = []
    for (const file of sources(ROOT)) {
      const text = readFileSync(file, 'utf-8')
      for (const rule of BANNED) {
        if (rule.test(text)) offenders.push(`${file.slice(ROOT.length + 1)} → ${rule.source}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
