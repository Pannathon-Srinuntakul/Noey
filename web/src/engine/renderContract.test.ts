/**
 * The engine's own invariants, checked against the source.
 *
 * These are all ABSENCES — a missing `outPath`, a swallowed abort, a cleanup
 * that never runs. Nothing throws when they regress and every behavioural test
 * around them still passes, which is exactly why they need a reader that looks
 * for the call.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (rel: string): string => readFileSync(resolve(__dirname, rel), 'utf8')

describe('renders stream to disk instead of buffering the whole MP4', () => {
  // Every encode used to allocate the finished file in RAM (plus mediabunny's
  // in-memory faststart copy). On a long 1080x1920 render that is gigabytes,
  // on exactly the devices with the least to spare.
  for (const job of ['renderSilent', 'renderFinal', 'renderTimeline']) {
    it(`${job} passes an outPath`, () => {
      expect(read(`jobs/${job}.ts`)).toMatch(/outPath: projectFilePath\(/)
    })
  }

  it('cutRender honours it and discards the staging file on failure', () => {
    const src = read('cutRender.ts')
    expect(src).toContain('openStagedWrite(req.outPath)')
    expect(src).toContain('staged?.discard()')
  })

  it('encodeVideo does not force in-memory faststart on a streamed target', () => {
    // fastStart:'in-memory' holds the whole file until finalize, defeating the
    // stream it was just given.
    expect(read('media.ts')).toContain("target.writable ? {} : { fastStart: 'in-memory' }")
  })
})

describe('a cut that cannot produce a frame fails loudly', () => {
  it('cutRender throws instead of ending the render early', () => {
    // Returning false finalized the output, still reported durationSec for the
    // FULL cut list, and let the bundle ship a subset with no notice.
    const src = read('cutRender.ts')
    const draw = src.slice(src.indexOf('const src = (await pass.next())'))
    expect(draw.slice(0, 400)).toMatch(/throw new Error\(/)
  })
})

describe('the cancel signal reaches the long-running work', () => {
  it('filmstrip re-throws AbortError rather than warning past it', () => {
    const src = read('jobs/filmstrip.ts')
    const idx = src.indexOf('} catch (err) {')
    expect(src.slice(idx, idx + 300)).toContain("err.name === 'AbortError'")
  })

  it('the packet-copy remux checks it per packet', () => {
    const src = read('media.ts')
    const remux = src.slice(src.indexOf('export async function remuxToMp4'))
    expect(remux).toContain('signal?.aborted')
  })
})

describe('sources are read through the server-aware path', () => {
  it('renderTimeline only treats a genuinely audio-less clip as silence', () => {
    // The catch used to swallow fetch and decode failures too — and these are
    // the modes built on the ORIGINAL audio, so one transient failure wrote a
    // silent final.mp4 and reported it as done.
    const src = read('jobs/renderTimeline.ts')
    expect(src).toContain('c.hasAudio === false')
    expect(src).toContain('อ่านเสียงจากคลิปต้นฉบับไม่ได้')
  })

  it('extract-proxy can run without a local upload_sources.json', () => {
    // A restored project has only project.json locally; the bare OPFS read
    // made "ให้ AI ตัดใหม่" flip a finished project to an error state.
    const src = read('jobs/extractProxy.ts')
    expect(src).toContain("blobForPath(projectFilePath(uid, 'upload_sources.json'))")
    expect(src).toContain('window.noey.projects.get(uid)')
  })

  it('renderFinal keeps blobForPath’s own reason for a missing voiceover', () => {
    const src = read('jobs/renderFinal.ts')
    expect(src).not.toContain('voiceover file not found')
  })
})

describe('a re-render leaves nothing from the previous run', () => {
  it('render-highlights clears highlights/ first', () => {
    // A re-plan can produce FEWER highlights; the extras stayed on disk, in
    // the export list and on S3 against the quota.
    expect(read('jobs/renderHighlights.ts')).toContain("deleteDir(projectFilePath(uid, 'highlights'))")
  })
})

describe('no English internals reach the project card', () => {
  const files = [
    'jobs/renderSilent.ts',
    'jobs/renderTimeline.ts',
    'jobs/renderFinal.ts',
    'jobs/renderHighlights.ts',
    'jobs/extractAudio.ts'
  ]
  for (const f of files) {
    it(`${f} throws Thai`, () => {
      const src = read(f)
      // `throw new Error('...')` with a Latin-only literal is the shape that
      // put "voiceover file not found: noeyfs://…" on a user's screen.
      const throws = [...src.matchAll(/throw new Error\(\s*[`'"]([^`'"]{4,})/g)].map((m) => m[1])
      const latinOnly = throws.filter((t) => !/[฀-๿]/.test(t) && !t.includes('${'))
      expect(latinOnly, `English throw in ${f}`).toEqual([])
    })
  }
})
