/** Builds the timed voiceover/transcript text block sent to the effects AI
 * (backend `script` form field → effects_ai.py `script_lines`) so placement can
 * match the exact spoken words, not just what's visually on screen.
 *
 * dub_first/highlight: derived from the edit script (groupScriptLines gives
 * per-line output-timeline timing + the AI's per-segment `visualDescription`).
 * Falls back to `[scene] <visualDescription>` per line when there's no
 * voiceoverScript — always true for highlight mode, and possible for any
 * dub_first line with no VO text — so the effects AI still gets SOME textual
 * context instead of pure vision. talking_head: derived from the saved
 * timeline's captionLines (or raw word timestamps if none were ever edited)
 * — already has real spoken-word context, untouched here.
 */

import type { LocalProject } from '@renderer/platform/types'
import { groupScriptLines } from './dubScript'
import { groupWordsIntoLines, type CaptionWord } from './captionLines'
import type { DubEditScript } from './videosLocalApi'

function fmt(lines: { start: number; end: number; text: string }[]): string {
  return lines
    .filter((l) => l.text.trim())
    .map((l) => `${l.start.toFixed(1)}s-${l.end.toFixed(1)}s: ${l.text.trim()}`)
    .join('\n')
}

export function buildEffectsScriptText(project: LocalProject): string {
  if ((project.mode === 'dub_first' || project.mode === 'highlight') && project.editScript) {
    const lines = groupScriptLines(project.editScript as unknown as DubEditScript)
    return fmt(
      lines.map((l) => ({
        start: l.outputIn,
        end: l.outputOut,
        text: l.script || (l.visualDescription ? `[scene] ${l.visualDescription}` : '')
      }))
    )
  }

  if (project.mode === 'talking_head' && project.timeline) {
    const timeline = project.timeline as {
      captionLines?: { start: number; end: number; text: string }[]
      words?: CaptionWord[]
    }
    if (timeline.captionLines?.length) {
      return fmt(timeline.captionLines)
    }
    if (timeline.words?.length) {
      return fmt(groupWordsIntoLines(timeline.words))
    }
  }

  return ''
}
