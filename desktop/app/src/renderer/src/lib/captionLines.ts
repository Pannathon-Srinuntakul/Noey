/** Client-side caption-line grouping — mirrors the default `words_per_line`
 * grouping in backend/packages/video/caption.py so a project opened for the
 * first time in the editor gets a sensible initial line breakdown, without
 * needing a round-trip to the server. Once the user edits/saves, the edited
 * `captionLines` persist and this grouping is never re-applied. */

export interface CaptionWord {
  word: string
  start: number
  end: number
}

export interface CaptionLine {
  id: string
  text: string
  start: number
  end: number
}

export function groupWordsIntoLines(words: CaptionWord[], wordsPerLine = 3): CaptionLine[] {
  const lines: CaptionLine[] = []
  for (let i = 0; i < words.length; i += wordsPerLine) {
    const group = words.slice(i, i + wordsPerLine)
    if (group.length === 0) continue
    const start = group[0].start
    const end = group[group.length - 1].end
    if (end <= start) continue
    lines.push({
      id: `cap${lines.length}`,
      text: group.map((w) => w.word.trim()).join(' '),
      start,
      end
    })
  }
  return lines
}
