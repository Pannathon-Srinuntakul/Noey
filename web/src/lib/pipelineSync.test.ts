/**
 * A project that reaches a terminal step must have its files on the server.
 *
 * This is the bug that shipped: `syncToServer` was called on the `highlight`
 * branch of the silent render and NOT on the `waiting_vo` branch beside it. A
 * dub project sits at `waiting_vo` until someone records a voiceover — days,
 * or never — and for that whole time not one of its files, `project.json`
 * included, had ever been uploaded. Opening the account in another browser
 * showed an empty workspace, which is the one thing the server-storage work
 * exists to prevent. Found in production, 2026-09-08.
 *
 * A grep, not a behavioural test, and deliberately so: the failure is a
 * MISSING call. Nothing throws, nothing logs, and every unit test of the
 * surrounding code passes either way. What has to be checked is that each
 * place the pipeline stops is followed by a sync.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SOURCE = readFileSync(resolve(__dirname, 'useProjectPipeline.ts'), 'utf8')
const LINES = SOURCE.split('\n')

/** Lines where the project is written into a step it can rest at. */
function terminalWrites(): number[] {
  const out: number[] = []
  LINES.forEach((line, i) => {
    if (/step: '(done|waiting_vo)'/.test(line)) out.push(i)
  })
  return out
}

describe('every terminal transition uploads the project', () => {
  it('finds the transitions at all (the grep still matches the source)', () => {
    expect(terminalWrites().length).toBeGreaterThanOrEqual(6)
  })

  for (const idx of terminalWrites()) {
    const lineNo = idx + 1
    it(`line ${lineNo} is followed by syncToServer`, () => {
      // The patch call spans a few lines and the sync follows the block it
      // closes, so look a short way ahead rather than at the next line.
      const window = LINES.slice(idx, idx + 12).join('\n')
      expect(window, `no syncToServer after the terminal write at line ${lineNo}`).toContain(
        'syncToServer('
      )
    })
  }
})

describe('the sync itself', () => {
  it('never throws into the caller', () => {
    // It is best-effort by design: a project whose files did not reach the
    // server still works on the machine that made it, so a failed upload must
    // not fail a render.
    const body = SOURCE.slice(
      SOURCE.indexOf('const syncToServer'),
      SOURCE.indexOf('const runImport')
    )
    expect(body).toContain('catch')
  })
})
