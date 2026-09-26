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

describe('nothing reads a whole source video into memory', () => {
  it('the audio decode goes packet by packet, and only falls back on an audio-only demux', () => {
    // `blob.arrayBuffer()` of a 2 h source video, then `decodeAudioData` of
    // the lot: multi-gigabyte, on the tab with the least memory to spare.
    const src = read('audio.ts')
    expect(src).toContain('decodeAudioStreamed(blob')
    expect(src).toContain('demuxAudioOnly(blob')
    expect(src).not.toMatch(/const bytes = await blob\.arrayBuffer\(\)/)
  })

  it('render-timeline decodes each cut’s own window from the clips the cuts reference', () => {
    // It decoded EVERY project clip in full, cuts or no cuts.
    const src = read('jobs/renderTimeline.ts')
    expect(src).toContain('openAudioSource(blob)')
    expect(src).toContain('startSec: cut.sourceIn')
    expect(src).not.toMatch(/for \(const c of sources\) \{[\s\S]{0,400}decodeBlob/)
  })

  it('the speech WAV streams to disk', () => {
    expect(read('jobs/extractAudio.ts')).toContain('speechWavStream(source')
    expect(read('jobs/extractAudio.ts')).toContain(
      'writeFileAtomic(projectFilePath(uid, `audio/${name}`), stream)'
    )
  })

  it('ingest streams the container remux into the store', () => {
    const src = read('jobs/ingest.ts')
    expect(src).toContain('remuxToMp4(blob, signal, projectFilePath(uid, mp4Rel))')
  })

  it('remuxToMp4 does not force in-memory faststart on a streamed target', () => {
    const src = read('media.ts')
    const remux = src.slice(src.indexOf('export async function remuxToMp4'))
    expect(remux).toContain("staged ? {} : { fastStart: 'in-memory' }")
    expect(remux).toContain('staged?.discard()')
  })

  it('extract-proxy streams its encode', () => {
    const src = read('jobs/extractProxy.ts')
    expect(src).toContain('{ writable: staged.writable }')
    expect(src).toContain('staged.discard()')
  })

  it('blobForPath pipes a server download into the store instead of materialising it', () => {
    const src = read('jobs/probe.ts')
    expect(src).toContain('writeFileAtomic(path, res.body)')
  })

  it('bundles are written as a stream, not zipSync', () => {
    const src = read('bundle.ts')
    expect(src).not.toContain('zipSync(')
    expect(src).toContain('new Zip(')
    expect(src).toContain('ZipPassThrough')
    expect(src).toContain('openStagedWrite(outPath)')
  })
})

describe('storage is checked before an import moves bytes', () => {
  it('ingest asks ensureRoomFor with the sources’ sizes first', () => {
    const src = read('jobs/ingest.ts')
    const at = src.indexOf('await ensureRoomFor(sourceBytes)')
    expect(at).toBeGreaterThan(-1)
    expect(at).toBeLessThan(src.indexOf('stageIntoStore(src, uid)'))
  })
})

describe('a failed job does not leave its intermediates behind', () => {
  it('transcode drops .videoonly.mp4 in a finally', () => {
    const src = read('jobs/transcode.ts')
    const fin = src.slice(src.lastIndexOf('} finally {'))
    expect(fin).toContain('deleteFile(tempPath)')
  })

  it('ingest drops the normalized files it wrote when it throws', () => {
    const src = read('jobs/ingest.ts')
    const onError = src.slice(src.indexOf('} catch (err) {'))
    expect(onError.slice(0, 300)).toContain('for (const rel of written)')
    // ...but never the staged sources: a retry reads those.
    expect(onError.slice(0, 300)).not.toContain('stagingDir')
  })
})

describe('shared arithmetic has one home', () => {
  for (const f of ['cutRender.ts', 'jobs/transcode.ts', 'jobs/extractProxy.ts']) {
    it(`${f} imports even() rather than defining it`, () => {
      expect(read(f)).not.toMatch(/function even\(|const even = /)
    })
  }
  for (const f of ['jobs/renderFinal.ts', 'jobs/renderTimeline.ts']) {
    it(`${f} imports quantiseToFrames rather than defining it`, () => {
      expect(read(f)).not.toMatch(/const quantise[d]? = /)
      expect(read(f)).toContain('quantiseToFrames')
    })
  }
})

describe('a stopped render leaves the previous clips/ intact', () => {
  it('writes scene clips to a staging folder and swaps them in after publish', () => {
    // clips/ used to be deleted before the encode: a stop mid-render left the
    // old final beside a partial set of the new cut's scenes.
    const src = read('cutRender.ts')
    const body = src.slice(src.indexOf('export async function renderCutList'))
    expect(body.indexOf("deleteDir(projectFilePath(uid, 'clips'))")).toBe(-1)
    expect(body.indexOf('publishClips(uid)')).toBeGreaterThan(body.indexOf('staged.publish()'))
    const onError = body.slice(body.indexOf('} catch (err) {'))
    expect(onError.slice(0, 900)).toContain('deleteDir(projectFilePath(uid, CLIPS_STAGING))')
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
    expect(read('jobs/renderHighlights.ts')).toContain(
      "deleteDir(projectFilePath(uid, 'highlights'))"
    )
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
