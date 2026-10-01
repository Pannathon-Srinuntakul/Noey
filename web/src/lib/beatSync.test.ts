/**
 * ตัดตามจังหวะ on the web build (owner, 2026-10-01): the attached track goes
 * to the server's beat analysis like on the desktop, the grid lands on
 * `music.beats`, every AI cut call is told where the song plays, the wizard
 * offers the switch only when the analysis will run, and the editor's one
 * magnet gains beats as a target source — with no separate beat-snap control.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  analyzeVideo,
  planDub,
  reeditDubScenes,
  uploadMusic,
  type ApiSession
} from './videosLocalApi'
import { musicWindowBody, musicWindowFormFields } from './musicWindow'
import * as platformFeatures from './platformFeatures'
import { WIZARD_INITIAL, beatSyncOffer, type WizardState } from './wizardState'
import { buildOutputTargets } from '../components/timeline/snapTargets'
import { TimelineToolbar } from '../components/timeline/TimelineToolbar'

type FetchJob = {
  url: string
  method?: string
  jsonBody?: string
  formFields?: Record<string, string>
  formFiles?: { field: string; path: string; filename?: string }[]
}
type FetchResult = { ok: boolean; status: number; bodyText: string }

const session: ApiSession = { baseUrl: 'http://api', accessToken: 'a', refreshToken: 'r' }
let fetchMock: ReturnType<typeof vi.fn<(job: FetchJob) => Promise<FetchResult>>>

const ok = (body: unknown, status = 200): FetchResult => ({
  ok: true,
  status,
  bodyText: JSON.stringify(body)
})

beforeEach(() => {
  fetchMock = vi.fn<(job: FetchJob) => Promise<FetchResult>>()
  vi.stubGlobal('window', {
    noey: {
      api: { fetch: fetchMock },
      log: { write: vi.fn() },
      projects: { resolvePath: async (_uid: string, rel: string) => `/p/${rel}` }
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const PIPELINE = readFileSync(resolve(__dirname, 'useProjectPipeline.ts'), 'utf8')

describe('music upload → beats', () => {
  it('posts the track to the music route and returns the grid', async () => {
    fetchMock.mockResolvedValueOnce(ok({ tempo: 120, beats: [0.5, 1, 1.5], durationSec: 30 }, 201))
    const res = await uploadMusic(session, 'r1', 'music/song.mp3')
    const job = fetchMock.mock.calls[0][0]
    expect(job.url).toBe('http://api/videos/r1/music')
    expect(job.method).toBe('POST')
    expect(job.formFiles).toEqual([{ field: 'file', path: 'music/song.mp3', filename: 'song.mp3' }])
    expect(res.beats).toEqual([0.5, 1, 1.5])
  })

  it('runs on this build too — no platform flag gates the analysis', () => {
    expect('canSnapToBeat' in platformFeatures).toBe(false)
    const block = PIPELINE.slice(
      PIPELINE.indexOf("setProgressMsg('กำลังวิเคราะห์จังหวะเพลง…')") - 400,
      PIPELINE.indexOf("setProgressMsg('กำลังย่อวิดีโอให้ AI…')")
    )
    expect(block).toContain('if (current.music?.path && current.beatSync !== false) {')
    expect(block).toContain('await uploadMusic(session, remoteUid, absMusicPath)')
    // The grid is stored on the project's music, where the editor reads it.
    expect(block).toContain('music: current.music ? { ...current.music, beats: beats.beats }')
    // Same as desktop: a refusal (plan without music, unreadable file) is
    // logged and the cut goes on without a grid.
    expect(block).toContain('uploadMusic failed')
  })
})

describe('music window on the AI cut calls', () => {
  const music = { offsetSec: 2, trimInSec: 5, trimOutSec: 40 }

  it('sends only non-default, server-valid placement', () => {
    expect(musicWindowFormFields(null)).toEqual({})
    expect(musicWindowFormFields({ offsetSec: 0, trimInSec: 0, trimOutSec: null })).toEqual({})
    expect(musicWindowFormFields(music)).toEqual({
      music_offset_sec: '2',
      music_trim_in_sec: '5',
      music_trim_out_sec: '40'
    })
    // An end at or before the start would be a 422 for the whole run.
    expect(musicWindowFormFields({ offsetSec: -1, trimInSec: 5, trimOutSec: 5 })).toEqual({
      music_trim_in_sec: '5'
    })
    expect(musicWindowBody(music)).toEqual({
      musicOffsetSec: 2,
      musicTrimInSec: 5,
      musicTrimOutSec: 40
    })
  })

  it('analyze-video carries the placement', async () => {
    fetchMock.mockResolvedValueOnce(ok({ job_id: 'j' }, 202))
    await analyzeVideo(
      session,
      'r1',
      'l1',
      [{ clip_id: 'c', file: 'c.mp4', durationSec: 3, order: 0 } as never],
      undefined,
      undefined,
      undefined,
      false,
      music
    )
    expect(fetchMock.mock.calls[0][0].formFields).toMatchObject({
      music_offset_sec: '2',
      music_trim_in_sec: '5',
      music_trim_out_sec: '40'
    })
  })

  it('reedit-dub-scenes carries the placement', async () => {
    fetchMock.mockResolvedValueOnce(ok({ job_id: 'j' }, 202))
    await reeditDubScenes(
      session,
      'r1',
      'preview.mp4',
      { selectedLineIds: [], instruction: 'x' },
      undefined,
      false,
      music
    )
    expect(fetchMock.mock.calls[0][0].formFields).toMatchObject({ music_offset_sec: '2' })
  })

  it('plan-dub carries the placement', async () => {
    fetchMock.mockResolvedValueOnce(ok({ segments: [] }))
    await planDub(session, 'r1', 30, [10], false, music)
    expect(JSON.parse(fetchMock.mock.calls[0][0].jsonBody ?? '{}')).toMatchObject({
      musicOffsetSec: 2,
      musicTrimInSec: 5,
      musicTrimOutSec: 40
    })
  })

  it('the pipeline hands the project music to all three calls', () => {
    const analyze = PIPELINE.slice(PIPELINE.indexOf('await analyzeVideo('))
    expect(analyze.slice(0, analyze.indexOf(')\n'))).toContain('current.music')
    const plan = PIPELINE.slice(PIPELINE.indexOf('await planDub('))
    expect(plan.slice(0, plan.indexOf(')\n'))).toContain('live().music')
    const reedit = PIPELINE.slice(PIPELINE.indexOf('await reeditDubScenes('))
    expect(reedit.slice(0, reedit.indexOf(')\n'))).toContain('live().music')
  })
})

describe('wizard: ตัดตามจังหวะ is offered only when it will run', () => {
  const track = { path: 'a.mp3', name: 'a.mp3', trimInSec: 0, trimOutSec: 30 }
  const st = (p: Partial<WizardState>): WizardState => ({ ...WIZARD_INITIAL, ...p })

  it('is on by default, like the desktop', () => {
    expect(WIZARD_INITIAL.beatSync).toBe(true)
  })

  it('is live once a track is attached and the plan has music', () => {
    expect(beatSyncOffer(st({ uiMode: 'highlight', voiceover: 'ai', music: track }), false)).toBe(
      'available'
    )
  })

  it('asks for a track first', () => {
    expect(beatSyncOffer(st({ uiMode: 'highlight', voiceover: 'none', music: null }), false)).toBe(
      'needs_music'
    )
  })

  it('is hidden when the plan has no music or the mode has no music row', () => {
    expect(beatSyncOffer(st({ uiMode: 'highlight', voiceover: 'ai', music: track }), true)).toBe(
      'hidden'
    )
    expect(
      beatSyncOffer(st({ uiMode: 'highlight', voiceover: 'original', music: track }), false)
    ).toBe('hidden')
    expect(beatSyncOffer(st({ uiMode: 'silence', music: track }), false)).toBe('hidden')
    expect(beatSyncOffer(st({ uiMode: 'longform', music: track }), false)).toBe('hidden')
  })
})

describe('editor magnet: beats are one more target source', () => {
  const base = {
    cuts: [],
    voBlocks: [],
    capSpans: [],
    music: { offsetSec: 1, trimInSec: 2, trimOutSec: 20 },
    musicDurationSec: 30,
    markers: [],
    range: null,
    playheadSec: 0,
    editedDur: 10
  }
  const beatSecs = (beats: number[] | null): number[] =>
    buildOutputTargets({ ...base, beats })
      .filter((t) => t.kind === 'beat')
      .map((t) => t.sec)

  it('includes beats (on the output clock) when the track has them', () => {
    // b − trimIn + offset; a beat before the trim-in plays nowhere.
    expect(beatSecs([1, 2.5, 4])).toEqual([0, 1.5, 3])
  })

  it('has no beat targets without a grid', () => {
    expect(beatSecs(null)).toEqual([])
    expect(beatSecs([])).toEqual([])
  })
})

describe('no separate beat-snap control', () => {
  const props = {
    viewMode: 'edited' as const,
    thStats: null,
    hasSelection: false,
    snapEnabled: true,
    skimEnabled: false,
    pxPerSec: 40,
    canZoomSelection: false,
    onSwitchView: () => undefined,
    onSplit: () => undefined,
    onAddScene: () => undefined,
    onDelete: () => undefined,
    onToggleSnap: () => undefined,
    onToggleSkim: () => undefined,
    onZoom: () => undefined,
    onFitToggle: () => undefined,
    onZoomSelection: () => undefined
  }

  it('the toolbar has the one magnet, with beats in its wording only', () => {
    const withBeats = renderToStaticMarkup(
      createElement(TimelineToolbar, { ...props, beatCount: 12 })
    )
    const without = renderToStaticMarkup(createElement(TimelineToolbar, { ...props, beatCount: 0 }))
    for (const html of [withBeats, without]) {
      expect(html).not.toContain('ดูดเข้าจังหวะ')
      expect(html.match(/ดูดขอบ</g)).toHaveLength(1)
    }
    expect(withBeats).toContain('จังหวะ')
    expect(without).not.toContain('จังหวะ')
  })

  it('the editor draws no beat-snap button either', () => {
    const editor = readFileSync(resolve(__dirname, '../components/TimelineEditor.tsx'), 'utf8')
    expect(editor).not.toContain('ดูดเข้าจังหวะ')
    expect(editor).not.toContain('snapToBeatEnabled')
  })
})
