/**
 * Every job that walks a whole clip decodes in ONE sequential pass.
 *
 * `VideoReader.frameAt(t)` is random access: each call seeks and re-walks the
 * GOP from the last keyframe, so the cost grows far faster than clip length.
 * `framesAt(stamps)` decodes once, in order.
 *
 * Measured on the same 12-second clip through `extract-proxy`:
 *
 *     frameAt   22,665 ms
 *     framesAt   1,732 ms      — 13x, byte-identical output
 *
 * That ratio matches the note already in cutRender.ts (263 s → 19 s on a
 * 27-cut render). Three jobs were still on the slow path after the port, and
 * the one a user hits first — the proxy encode before the AI call — sat at
 * "25% · กำลังย่อวิดีโอให้ AI" long enough on an iPhone to be reported as a
 * hang (2026-09-09). It was not stuck; it was ~13x too slow.
 *
 * A grep, because the defect is a CHOICE OF METHOD that reads as ordinary in
 * review and produces correct output either way.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ENGINE = __dirname

function engineFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...engineFiles(path))
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(path)
  }
  return out
}

describe('no job seeks per frame', () => {
  for (const file of engineFiles(ENGINE)) {
    const rel = file.slice(ENGINE.length + 1).replace(/\\/g, '/')
    // media.ts DEFINES both methods; `frameAt` stays for genuine one-off
    // lookups (a poster frame), which is not what this rule is about.
    if (rel === 'media.ts') continue
    it(`${rel} uses framesAt`, () => {
      const src = readFileSync(file, 'utf8')
      const calls = src.split('\n').filter((l) => /\breader\.frameAt\(|\.frameAt\(/.test(l))
      expect(calls, `per-frame seek in ${rel}`).toEqual([])
    })
  }
})

describe('each sequential pass is closed', () => {
  // An abandoned generator keeps its decoder alive until GC; the reader is
  // closed in the same `finally`, so the pass must be too.
  for (const file of engineFiles(ENGINE)) {
    const src = readFileSync(file, 'utf8')
    const rel = file.slice(ENGINE.length + 1).replace(/\\/g, '/')
    // media.ts DEFINES the generator; it does not consume one.
    if (rel === 'media.ts') continue
    if (!src.includes('framesAt(')) continue
    it(`${rel} returns its generator`, () => {
      expect(src).toContain('pass.return(undefined)')
    })
  }
})
