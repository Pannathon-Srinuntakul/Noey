import { describe, expect, it } from 'vitest'
import {
  WIZARD_INITIAL,
  backendMode,
  buildSubmission,
  SOFT_CAP_SEC,
  capSecFor,
  captionGate,
  defaultProjectName,
  fileStepGate,
  fmtBytes,
  fmtClock,
  mergeNameValue,
  moveToIndex,
  outcomeStepGate,
  projectCount,
  resolvedProjectName,
  roleFor,
  summaryRows,
  totalDurationSec,
  type WizardFile,
  type WizardState
} from './wizardState'

function fileOf(id: string, durationSec: number | null = 60): WizardFile {
  return {
    id,
    path: `C:/clips/${id}.mp4`,
    name: `${id}.mp4`,
    durationSec,
    width: 1080,
    height: 1920,
    sizeBytes: 1024 ** 2 * 10
  }
}

function stateWith(patch: Partial<WizardState> = {}): WizardState {
  return { ...WIZARD_INITIAL, ...patch }
}

describe('backendMode', () => {
  it('maps ตัดช่วงเงียบ to talking_head regardless of voiceover', () => {
    expect(backendMode('silence', 'ai')).toBe('talking_head')
    expect(backendMode('silence', 'none')).toBe('talking_head')
  })

  // The whole point of HANDOFF §6 item 2 — the third backend mode is reachable
  // only through this one function.
  it('maps ตัดฉากเด่น + ไม่พากย์ to the highlight backend mode', () => {
    expect(backendMode('highlight', 'none')).toBe('highlight')
  })

  it('maps ตัดฉากเด่น with any voiceover to dub_first', () => {
    expect(backendMode('highlight', 'ai')).toBe('dub_first')
    expect(backendMode('highlight', 'own')).toBe('dub_first')
  })
})

describe('totalDurationSec', () => {
  it('is zero for no files', () => {
    expect(totalDurationSec([])).toBe(0)
  })

  it('sums known durations', () => {
    expect(totalDurationSec([fileOf('a', 30), fileOf('b', 45)])).toBe(75)
  })

  it('is null while any clip is still unprobed', () => {
    expect(totalDurationSec([fileOf('a', 30), fileOf('b', null)])).toBeNull()
  })
})

describe('fileStepGate', () => {
  it('blocks with no files', () => {
    expect(fileStepGate(stateWith()).ok).toBe(false)
  })

  it('passes under the cap', () => {
    expect(fileStepGate(stateWith({ files: [fileOf('a', 300)] })).ok).toBe(true)
  })

  it('lets ตัดฉากเด่น run on an hour of footage — the old 20-minute cap is gone', () => {
    expect(fileStepGate(stateWith({ uiMode: 'highlight', files: [fileOf('a', 60 * 60)] })).ok).toBe(
      true
    )
  })

  it('still blocks past two hours, in both modes', () => {
    for (const uiMode of ['highlight', 'silence'] as const) {
      const gate = fileStepGate(stateWith({ uiMode, files: [fileOf('a', 2 * 3600 + 1)] }))
      expect(gate.ok).toBe(false)
      expect(gate.reason).toContain('2 ชั่วโมง')
    }
    expect(capSecFor('silence')).toBe(7200)
    expect(capSecFor('highlight')).toBe(7200)
  })

  it('warns before it blocks: the soft cap is well under the hard one', () => {
    expect(SOFT_CAP_SEC).toBeLessThan(capSecFor('highlight'))
  })

  // Unprobed clips must not block the step, or a slow probe would look like a
  // broken button.
  it('passes while durations are still unknown', () => {
    expect(fileStepGate(stateWith({ files: [fileOf('a', null)] })).ok).toBe(true)
  })
})

describe('outcomeStepGate', () => {
  it('always passes for ตัดช่วงเงียบ', () => {
    expect(outcomeStepGate(stateWith({ duration: '' })).ok).toBe(true)
  })

  it('needs a duration for ตัดฉากเด่น', () => {
    expect(outcomeStepGate(stateWith({ uiMode: 'highlight', duration: '' })).ok).toBe(false)
  })

  it('needs the custom seconds when กำหนดเอง is picked', () => {
    const s = stateWith({ uiMode: 'highlight', duration: 'custom', customSec: '' })
    expect(outcomeStepGate(s).ok).toBe(false)
    expect(outcomeStepGate({ ...s, customSec: '45' }).ok).toBe(true)
  })

  it('needs a script when the user is writing it themselves', () => {
    const s = stateWith({ uiMode: 'highlight', voiceover: 'own', userScript: '   ' })
    expect(outcomeStepGate(s).ok).toBe(false)
    expect(outcomeStepGate({ ...s, userScript: 'ทดสอบ' }).ok).toBe(true)
  })
})

describe('captionGate', () => {
  it('allows captions for ตัดช่วงเงียบ', () => {
    expect(captionGate(stateWith()).ok).toBe(true)
  })

  it('disables captions with a reason when nothing is spoken', () => {
    const gate = captionGate(stateWith({ uiMode: 'highlight', voiceover: 'none' }))
    expect(gate.ok).toBe(false)
    expect(gate.reason).toContain('ไม่พากย์')
  })

  // Chunk 9: dub_first captions come from splitting the voiceover script
  // across each line's scenes, so a spoken mode can burn them in.
  it('allows captions for ตัดฉากเด่น once something writes a voiceover', () => {
    expect(captionGate(stateWith({ uiMode: 'highlight', voiceover: 'ai' })).ok).toBe(true)
    expect(captionGate(stateWith({ uiMode: 'highlight', voiceover: 'own' })).ok).toBe(true)
  })

  // The review screen must never promise a caption the submission drops.
  it('agrees with what buildSubmission actually sends', () => {
    for (const s of [
      stateWith(),
      stateWith({ uiMode: 'highlight', voiceover: 'ai' }),
      stateWith({ uiMode: 'highlight', voiceover: 'none' })
    ]) {
      const sent = buildSubmission({ ...s, captionEnabled: true }).captionStyle !== undefined
      expect(sent).toBe(captionGate(s).ok)
    }
  })
})

describe('roleFor', () => {
  it('labels a lone clip', () => {
    expect(roleFor(0, 1)).toBe('only')
  })

  it('labels first and last', () => {
    expect(roleFor(0, 3)).toBe('open')
    expect(roleFor(1, 3)).toBe('mid')
    expect(roleFor(2, 3)).toBe('close')
  })
})

describe('moveToIndex', () => {
  it('moves an item forward and back', () => {
    expect(moveToIndex(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a'])
    expect(moveToIndex(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
  })

  it('returns the same array for a no-op or out-of-range move', () => {
    const items = ['a', 'b']
    expect(moveToIndex(items, 1, 1)).toBe(items)
    expect(moveToIndex(items, 0, 5)).toBe(items)
  })
})

describe('formatting', () => {
  it('formats under and over an hour', () => {
    expect(fmtClock(75)).toBe('1:15')
    expect(fmtClock(3661)).toBe('1:01:01')
    expect(fmtClock(0)).toBe('0:00')
  })

  it('formats sizes', () => {
    expect(fmtBytes(1024 ** 2 * 612)).toBe('612 MB')
    expect(fmtBytes(1024 ** 3 * 2.5)).toBe('2.5 GB')
  })
})

describe('projectCount', () => {
  it('is one when merging', () => {
    expect(projectCount(stateWith({ files: [fileOf('a'), fileOf('b')] }))).toBe(1)
  })

  it('is one per clip when separating', () => {
    const s = stateWith({ uploadMode: 'separate', files: [fileOf('a'), fileOf('b')] })
    expect(projectCount(s)).toBe(2)
  })

  it('ignores separate with a single file', () => {
    expect(projectCount(stateWith({ uploadMode: 'separate', files: [fileOf('a')] }))).toBe(1)
  })
})

describe('buildSubmission', () => {
  it('sends the caption style for ตัดฉากเด่น when something is spoken', () => {
    const s = stateWith({ uiMode: 'highlight', voiceover: 'ai', captionEnabled: true })
    expect(buildSubmission(s).captionStyle).toBeTruthy()
    // …but never with no voiceover: there would be no text to burn.
    expect(buildSubmission({ ...s, voiceover: 'none' }).captionStyle).toBeUndefined()
  })

  it('sends the caption style for ตัดช่วงเงียบ when enabled', () => {
    expect(buildSubmission(stateWith({ captionEnabled: true })).captionStyle).toBeTruthy()
    expect(buildSubmission(stateWith({ captionEnabled: false })).captionStyle).toBeUndefined()
  })

  it('only forwards a user script for dub_first + พิมพ์เอง', () => {
    const own = stateWith({ uiMode: 'highlight', voiceover: 'own', userScript: ' บทพูด ' })
    expect(buildSubmission(own).userScript).toBe('บทพูด')
    expect(buildSubmission({ ...own, voiceover: 'ai' }).userScript).toBe('')
  })

  it('uses the note verbatim as the brief for ตัดช่วงเงียบ', () => {
    expect(buildSubmission(stateWith({ note: '  รีวิวรองเท้า ' })).brief).toBe('รีวิวรองเท้า')
  })

  it('folds the duration and note into the brief for ตัดฉากเด่น', () => {
    const s = stateWith({ uiMode: 'highlight', duration: '30', note: 'เน้นกลิ่น' })
    const brief = buildSubmission(s).brief
    expect(brief).toContain('30')
    expect(brief).toContain('เน้นกลิ่น')
    // The script-style picker is gone: nothing adds a "สไตล์:" line any more.
    expect(brief).not.toContain('สไตล์')
  })

  it('resolves the target duration from the chip', () => {
    const s = stateWith({ uiMode: 'highlight', duration: '60' })
    expect(buildSubmission(s).targetDurationSec).toBe(60)
    expect(buildSubmission({ ...s, duration: 'auto' }).targetDurationSec).toBeUndefined()
  })

  it('never reports beat sync on a build that cannot snap to a beat', () => {
    // `canSnapToBeat` is false in the browser: computing the grid is a
    // server-side pass this build does not run, and the editor has no snap
    // control to use the result. The wizard's switch is hidden accordingly, so
    // the submission must not carry the state's default `true` into a project
    // and describe a cut that was never made that way.
    expect(buildSubmission(stateWith({ beatSync: true })).beatSync).toBe(false)

    const withMusic = stateWith({
      uiMode: 'highlight',
      beatSync: true,
      music: { path: 'a.mp3', name: 'a.mp3', trimInSec: 0, trimOutSec: 30 }
    })
    expect(buildSubmission(withMusic).beatSync).toBe(false)
    expect(buildSubmission({ ...withMusic, beatSync: false }).beatSync).toBe(false)
  })
})

describe('summaryRows', () => {
  it('never names the highlight backend mode', () => {
    const s = stateWith({ uiMode: 'highlight', voiceover: 'none', files: [fileOf('a', 30)] })
    const text = summaryRows(s, null)
      .map((r) => `${r.label} ${r.value}`)
      .join(' ')
    expect(text).not.toContain('highlight')
    expect(text).toContain('ตัดฉากเด่น')
    expect(text).toContain('ไม่พากย์')
  })

  it('omits cut style and music rows for ตัดช่วงเงียบ', () => {
    const keys = summaryRows(stateWith({ files: [fileOf('a')] }), null).map((r) => r.key)
    expect(keys).not.toContain('cutStyle')
    expect(keys).not.toContain('music')
  })

  it('shows the chosen cut style name', () => {
    const s = stateWith({ uiMode: 'highlight', cutStyleUid: 'x', files: [fileOf('a')] })
    const row = summaryRows(s, 'รีวิวสายรัว').find((r) => r.key === 'cutStyle')
    expect(row?.value).toBe('รีวิวสายรัว')
  })

  it('explains a caption row that is off because nothing is spoken', () => {
    const s = stateWith({ uiMode: 'highlight', voiceover: 'none', files: [fileOf('a')] })
    const row = summaryRows(s, null).find((r) => r.key === 'captions')
    expect(row?.value).toContain('ปิด')
  })

  it('mentions the split when creating one project per clip', () => {
    const s = stateWith({ uploadMode: 'separate', files: [fileOf('a'), fileOf('b')] })
    const row = summaryRows(s, null).find((r) => r.key === 'sources')
    expect(row?.value).toContain('2 โปรเจกต์')
  })
})

// ── probe loop guard ─────────────────────────────────────────────────────────
//
// The wizard's probe effect picks its work with this predicate. A LAN-received
// clip has no File, so a SUCCESSFUL sidecar probe still leaves sizeBytes null —
// the predicate has to be satisfied by the attempt, or the effect re-fires on
// its own output and spawns a sidecar process per round, forever.
describe('probe pending predicate', () => {
  const pending = (f: WizardFile): boolean =>
    !f.probed && f.durationSec === null && f.sizeBytes === null

  const lanClip: WizardFile = {
    id: 'lan1',
    path: 'C:/inbox/9f2c.mp4',
    name: 'IMG_1.mov',
    durationSec: null,
    width: null,
    height: null,
    sizeBytes: null
  }

  it('selects a freshly received clip', () => {
    expect(pending(lanClip)).toBe(true)
  })

  it('stops after a probe that could not fill sizeBytes', () => {
    // Exactly what probeClip's sidecar path returns: duration/dimensions, no size.
    const probed = { ...lanClip, durationSec: 21.4, width: 576, height: 1024, probed: true }
    expect(pending(probed)).toBe(false)
  })

  it('stops even when the probe yielded nothing at all', () => {
    expect(pending({ ...lanClip, probed: true })).toBe(false)
  })
})

describe('project name', () => {
  it('defaults to the first clip file name without its extension', () => {
    expect(defaultProjectName([fileOf('IMG_2989')])).toBe('IMG_2989')
    expect(defaultProjectName([])).toBe('')
  })

  it('shows the file-name default until the field is touched', () => {
    const files = [fileOf('IMG_2989'), fileOf('IMG_2990')]
    expect(mergeNameValue(stateWith({ files }))).toBe('IMG_2989')
    expect(
      mergeNameValue(stateWith({ files, projectName: 'unbox ลิปทินท์', projectNameTouched: true }))
    ).toBe('unbox ลิปทินท์')
  })

  it('keeps an emptied field empty instead of restoring the default', () => {
    const files = [fileOf('IMG_2989')]
    expect(mergeNameValue(stateWith({ files, projectName: '', projectNameTouched: true }))).toBe('')
  })

  it('resolves merge mode to the typed name, trimmed', () => {
    const files = [fileOf('IMG_2989'), fileOf('IMG_2990')]
    const state = stateWith({ files, projectName: '  รีวิวลิป  ', projectNameTouched: true })
    expect(resolvedProjectName(state, files)).toBe('รีวิวลิป')
  })

  it('falls back to the file name when the merge name is blank or untouched', () => {
    const files = [fileOf('IMG_2989')]
    expect(resolvedProjectName(stateWith({ files }), files)).toBe('IMG_2989')
    expect(
      resolvedProjectName(stateWith({ files, projectName: '   ', projectNameTouched: true }), files)
    ).toBe('IMG_2989')
  })

  it('resolves separate mode per clip and falls back per clip', () => {
    const a = { ...fileOf('IMG_2989'), projectName: 'รีวิวลิปทินท์' }
    const b = fileOf('IMG_2990')
    const c = { ...fileOf('IMG_2991'), projectName: '  ' }
    const state = stateWith({ files: [a, b, c], uploadMode: 'separate' })
    expect(resolvedProjectName(state, [a])).toBe('รีวิวลิปทินท์')
    expect(resolvedProjectName(state, [b])).toBe('IMG_2990')
    expect(resolvedProjectName(state, [c])).toBe('IMG_2991')
  })

  it('ignores the merge name once the wizard is splitting clips', () => {
    const files = [fileOf('IMG_2989'), fileOf('IMG_2990')]
    const state = stateWith({
      files,
      uploadMode: 'separate',
      projectName: 'ชื่อรวม',
      projectNameTouched: true
    })
    expect(resolvedProjectName(state, [files[0]])).toBe('IMG_2989')
  })

  it('still uses the merge name when separate mode has only one clip', () => {
    const files = [fileOf('IMG_2989')]
    const state = stateWith({
      files,
      uploadMode: 'separate',
      projectName: 'ชื่อเดียว',
      projectNameTouched: true
    })
    expect(projectCount(state)).toBe(1)
    expect(resolvedProjectName(state, files)).toBe('ชื่อเดียว')
  })
})

describe('ตัดไฮไลต์จากคลิปยาว has no length to choose', () => {
  // Owner decision 2026-09-23: a number picked before the clip is read forces
  // the selector to pad or truncate a highlight, which is what breaks the cut.
  const longform = (patch: Partial<WizardState> = {}): WizardState =>
    stateWith({ uiMode: 'longform', files: [fileOf('a', 600)], ...patch })

  it('lets the step through with no duration chosen at all', () => {
    expect(outcomeStepGate(longform({ duration: '' })).ok).toBe(true)
  })

  it('sends no target length, whatever the state carries', () => {
    expect(buildSubmission(longform({ duration: '' })).targetDurationSec).toBeUndefined()
    // A value left over from another mode must not travel either.
    expect(buildSubmission(longform({ duration: '60' })).targetDurationSec).toBeUndefined()
    expect(
      buildSubmission(longform({ duration: 'custom', customSec: '45' })).targetDurationSec
    ).toBeUndefined()
  })

  it('is still the speech_highlights mode', () => {
    expect(buildSubmission(longform()).mode).toBe('speech_highlights')
  })

  it('does not print a length in the review summary', () => {
    const row = summaryRows(longform({ duration: '60' }), null).find((r) => r.key === 'outcome')
    expect(row?.value).not.toMatch(/วินาที|ความยาว/)
  })
})
