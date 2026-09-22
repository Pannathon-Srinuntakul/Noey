/**
 * Nothing a user can read may name the AI stack behind the product.
 *
 * The rule is in CLAUDE.md and it is easy to break by accident — a provider's
 * own error string, an env-var name in a settings hint, a model id in a
 * placeholder. This walks the actual source of everything that renders.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const SRC = resolve(__dirname, '..')

const VENDOR =
  /anthropic|claude|openai|chatgpt|gpt-4|gemini|twelve ?labs|pegasus|eleven ?labs|elevenlabs|scribe_v|whisper|litellm|deepgram/i

/** Files whose STRINGS reach a user. Comments are allowed to name reality. */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path))
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(path)
    }
  }
  return out
}

/**
 * Every quoted string in a file, comments excluded.
 *
 * Crude on purpose: it over-reports rather than under-reports, and a false
 * positive here costs one rename while a false negative ships a leak.
 */
function stringsOf(source: string): string[] {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  // Single-quoted, double-quoted, TEMPLATE LITERALS (multi-line) and JSX text
  // between tags. The first version saw only the quoted pair, which left
  // backtick strings and plain JSX copy unscanned.
  const quoted = [...withoutComments.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g)].map(
    (m) => m[1] ?? m[2] ?? ''
  )
  const templates = [...withoutComments.matchAll(/`((?:[^`\\]|\\.)*)`/g)].map((m) => m[1] ?? '')
  const jsxText = [...withoutComments.matchAll(/>([^<>{}]+)</g)].map((m) => m[1] ?? '')
  return [...quoted, ...templates, ...jsxText]
}

describe('nothing under web/public names the AI stack either', () => {
  // The service worker is user-fetchable source, comments included.
  const PUB = resolve(SRC, '../public')
  for (const name of readdirSync(PUB)) {
    if (!/\.(js|html|json)$/.test(name)) continue
    it(`public/${name} is clean`, () => {
      const text = readFileSync(join(PUB, name), 'utf8')
      const hits = text.split('\n').filter((line) => VENDOR.test(line))
      expect(hits, `vendor name in public/${name}`).toEqual([])
    })
  }
})

describe('the UI never names the AI stack', () => {
  const files = sourceFiles(SRC)

  it('scans a real number of files', () => {
    expect(files.length).toBeGreaterThan(100)
  })

  for (const file of files) {
    const rel = file.slice(SRC.length + 1)
    it(`${rel} has no vendor name in any string`, () => {
      const hits = stringsOf(readFileSync(file, 'utf8')).filter((s) => VENDOR.test(s))
      expect(hits, `strings naming a provider in ${rel}`).toEqual([])
    })
  }
})

/**
 * Users never see token counts (docs/token-billing-plan.md §1): limits are
 * percentages, the top-up balance is baht. The word itself in a rendered
 * string is the tell — a label, a unit, a "N tokens" — so screens (.tsx) and
 * the module that words limits for them may not carry it at all.
 */
describe('the UI never states usage in tokens', () => {
  const TOKEN_WORD = /โทเคน|\btokens?\b/i
  const files = sourceFiles(SRC).filter(
    (f) => f.endsWith('.tsx') || f.endsWith('usageLimits.ts') || f.endsWith('usageEstimate.ts')
  )

  for (const file of files) {
    const rel = file.slice(SRC.length + 1)
    it(`${rel} has no token wording in any string`, () => {
      // `${token}` inside a URL template is a variable, not wording.
      const hits = stringsOf(readFileSync(file, 'utf8'))
        .map((s) => s.replace(/\$\{[^}]*\}/g, ''))
        .filter((s) => TOKEN_WORD.test(s))
      expect(hits, `token wording in ${rel}`).toEqual([])
    })
  }
})
