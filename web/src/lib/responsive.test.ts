/**
 * Layout rules that hold at every width.
 *
 * The owner's report was "responsive แต่ละหน้า เหมือนยังไม่สมบูรณ์ ... บางหน้า
 * มันไม่สวยเลย". A 16-agent audit found 74 distinct defects, and almost all of
 * them were the same two shapes:
 *
 *   - a fixed `w-[NNNpx]` with no breakpoint prefix, in a row that cannot wrap
 *   - a `w-full shrink-0` label beside a `flex-1` control, which by the
 *     flexbox spec lays the control out at exactly 0px
 *
 * Overflow itself is measured in a real browser at 360/390/430/768/834/1024/
 * 1280/1440 (all clean). These are the class-level rules that keep it that
 * way, because a new `w-[420px]` reads as perfectly ordinary in review.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const SRC = resolve(__dirname, '..')

function tsxFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...tsxFiles(path))
    else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) out.push(path)
  }
  return out
}

const FILES = tsxFiles(SRC)
const rel = (f: string): string => f.slice(SRC.length + 1).replace(/\\/g, '/')

/**
 * Screens this build cannot reach, so their layout cannot be seen.
 * `canUseZoomEffects` is a constant false in a browser.
 */
const UNREACHABLE = ['components/EffectsCanvasEditor.tsx', 'pages/EffectsClipRoute.tsx']

describe('no unprefixed fixed width big enough to overflow a phone', () => {
  // 340px: a 360px viewport minus the smallest page gutters still holds ~320,
  // so anything at or above this is a real overflow risk with no escape.
  const RISKY = /(?<![:\w-])(?:min-)?w-\[(\d{3,4})px\]/g

  for (const file of FILES) {
    if (UNREACHABLE.includes(rel(file))) continue
    it(`${rel(file)} is fluid below sm`, () => {
      const src = readFileSync(file, 'utf8')
      const hits: string[] = []
      for (const m of src.matchAll(RISKY)) {
        if (Number(m[1]) < 340) continue
        // A breakpoint prefix immediately before it is the correct pattern
        // (`w-full lg:w-[440px]`), and so is `max-w-`.
        const before = src.slice(Math.max(0, m.index - 12), m.index)
        if (/(sm|md|lg|xl|2xl):$/.test(before)) continue
        if (/max-$/.test(before)) continue
        hits.push(m[0])
      }
      expect(hits, `unprefixed fixed width in ${rel(file)}`).toEqual([])
    })
  }
})

describe('the flexbox trap that zeroed every control in wizard step 2', () => {
  it('no `w-full shrink-0` sits in an unprefixed flex row', () => {
    // `w-full shrink-0` next to `flex-1` means the sibling is laid out at 0px:
    // flex-basis 0 with nothing able to shrink. It is invisible in review and
    // it made every control in step 2 disappear.
    const offenders: string[] = []
    for (const file of FILES) {
      const src = readFileSync(file, 'utf8')
      // Line by line: a quoted-region regex spans newlines and swallows the
      // whole file between two unrelated quotes.
      for (const line of src.split('\n')) {
        if (!/\bw-full shrink-0\b/.test(line)) continue
        if (/^\s*(\/\/|\*)/.test(line)) continue // prose about the trap
        if (/(sm|md|lg|xl):w-\[/.test(line)) continue // the corrected shape
        // A box that derives its own height from its width is sizing itself,
        // not competing with a `flex-1` sibling for the row.
        if (/\baspect-/.test(line)) continue
        offenders.push(`${rel(file)}: ${line.trim().slice(0, 70)}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('the mobile viewport is the small one', () => {
  it('#root uses dvh with a vh fallback', () => {
    // `vh` is the LARGE viewport: on a 390x844 iPhone with the URL bar showing
    // the shell lays 844px into ~745px, and because body is overflow:hidden no
    // gesture retracts the toolbar — the bottom ~100px is permanently lost,
    // taking the wizard's ถัดไป and every dialog footer with it.
    const css = readFileSync(resolve(SRC, 'assets/main.css'), 'utf8')
    const root = css.slice(css.indexOf('#root'))
    expect(root).toContain('height: 100vh')
    expect(root).toContain('height: 100dvh')
    expect(root).toContain('env(safe-area-inset-bottom)')
  })

  it('the viewport meta opts into the safe areas', () => {
    // Without `viewport-fit=cover` every env(safe-area-inset-*) resolves to 0.
    const html = readFileSync(resolve(SRC, '../index.html'), 'utf8')
    expect(html).toContain('viewport-fit=cover')
  })
})

describe('form controls do not make iOS Safari zoom', () => {
  it('every field is at least 16px on a phone', () => {
    // Mobile Safari zooms the layout viewport whenever a focused control
    // computes below 16px, and does not zoom back out on blur.
    const input = readFileSync(resolve(SRC, 'components/ui/Input.tsx'), 'utf8')
    expect(input).toContain("md: 'h-10 text-[16px] sm:text-[15px]'")
    const textarea = input.slice(input.indexOf('min-h-16'))
    expect(textarea).toContain('text-[16px]')
  })
})
