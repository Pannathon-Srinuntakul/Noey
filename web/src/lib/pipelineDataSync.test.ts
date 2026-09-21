/**
 * Server copy, recut and music invariants of useProjectPipeline.
 *
 * The hook drives OPFS, the render engine and the API at once, so these read
 * the source for the call that has to be there — the same approach as
 * pipelineSync.test.ts. Every one of them is a MISSING or MISPLACED call that
 * no other test notices.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { needsRenderFields, renderSig } from './useProjectPipeline'

const SOURCE = readFileSync(resolve(__dirname, 'useProjectPipeline.ts'), 'utf8')

/** The body of `const <name> = async (` up to the next top-level const. */
function body(name: string): string {
  const start = SOURCE.indexOf(`const ${name} = async (`)
  expect(start, `${name} not found`).toBeGreaterThan(-1)
  const next = SOURCE.indexOf('\n  const ', start + 10)
  return SOURCE.slice(start, next > 0 ? next : undefined)
}

describe('server edit script / timeline writes are ordered', () => {
  it('no PUT bypasses the write queue', () => {
    // A direct PUT could land before a draft queued earlier — the server then
    // kept an older cut and plan-dub planned the voiceover on it.
    const direct = SOURCE.split('\n').filter(
      (l) => /await putLocal(EditScript|Timeline)\(/.test(l) && !l.includes('queueServerWrite')
    )
    expect(direct).toEqual([])
  })

  it('plan-dub waits for queued writes', () => {
    const run = body('runFinalWithAudioInner')
    expect(run.indexOf('serverWrites.idle()')).toBeGreaterThan(-1)
    expect(run.indexOf('serverWrites.idle()')).toBeLessThan(run.indexOf('planDub('))
  })
})

describe('revertRecut', () => {
  const revert = body('revertRecut')

  it('puts the kept script and timeline back on the server', () => {
    expect(revert).toContain("queueServerWrite('edit_script'")
    expect(revert).toContain("queueServerWrite('timeline'")
  })

  it('restores the resting step and clears an owed analysis', () => {
    expect(revert).toContain('step: restStep')
    expect(revert).toContain('analysisOwed: undefined')
  })
})

describe('a recut is never answered with the previous round', () => {
  it('both chains drop the stored job id when a run starts', () => {
    expect(body('runAnalyze')).toContain('...withoutJobId()')
    expect(body('runTalkingHead')).toContain('...withoutJobId()')
  })

  it('recut owes an analysis, retry honours it, a new script settles it', () => {
    expect(body('recut')).toContain('analysisOwed: true')
    expect(body('retry')).toContain('!projectRef.current.analysisOwed')
    expect(body('adoptAnalyzedScript')).toContain('analysisOwed: undefined')
  })
})

describe('renderSig', () => {
  const script = { segments: [{ sourceClip: 'clip0', sourceIn: 1, sourceOut: 2 }] }
  const music = {
    path: 'music/a.mp3',
    volume: 0.25,
    offsetSec: 0,
    trimInSec: 0,
    trimOutSec: null,
    muted: false
  }

  it('is unchanged for a project without a voiced final', () => {
    // Stored fingerprints of every existing project must still match.
    expect(renderSig({ editScript: script, music })).toBe(renderSig({ editScript: script }))
  })

  it('covers the music of a voiced final, which no remix reaches', () => {
    const voiced = { editScript: script, timeline: { timeline: [] }, voiceoverPath: 'vo.wav' }
    expect(renderSig({ ...voiced, music })).not.toBe(
      renderSig({ ...voiced, music: { ...music, volume: 0.35 } })
    )
  })

  it('reads an empty caption edit list the same as none', () => {
    // Renders store no list; the editor drafts [] when nothing was edited.
    const tl = { timeline: [{ source: 'clip0', in: 0, out: 2 }] }
    expect(renderSig({ editScript: script, captionLines: [] })).toBe(
      renderSig({ editScript: script })
    )
    expect(renderSig({ timeline: { ...tl, captionLines: [] } })).toBe(renderSig({ timeline: tl }))
  })
})

describe('needsRenderFields', () => {
  const music = {
    path: 'music/a.mp3',
    volume: 0.25,
    offsetSec: 0,
    trimInSec: 0,
    trimOutSec: null,
    muted: false
  }
  const timeline = { timeline: [{ source: 'clip0', in: 0, out: 2 }] }
  const voiced = { timeline, voiceoverPath: 'vo.wav', music }
  // What a build before the music element stored for this project.
  const oldSig = JSON.stringify([[], [['clip0', 0, 2]], null, null])

  it("upgrades an older build's fingerprint when nothing changed", () => {
    const out = needsRenderFields({ ...voiced, renderedSig: oldSig }, voiced)
    expect(out.needsRender).toBe(false)
    expect(out.renderedSig).toBe(renderSig(voiced))
  })

  it('still flags a music change on such a project', () => {
    const after = { ...voiced, music: { ...music, volume: 0.5 } }
    expect(needsRenderFields({ ...voiced, renderedSig: oldSig }, after).needsRender).toBe(true)
  })

  it('leaves a current fingerprint alone', () => {
    const out = needsRenderFields({ ...voiced, renderedSig: renderSig(voiced) }, voiced)
    expect(out).toEqual({ needsRender: false })
  })
})
