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

/** Thai script block (U+0E00–U+0E7F) — matches `_THAI_CHAR_RE` in caption.py. */
const THAI_CHAR = /[฀-๿]/

/**
 * Join word tokens for display, mirroring `_join_words` in
 * backend/packages/video/caption.py: no space between two Thai-script tokens
 * (Thai writing has no inter-word spaces — the word split exists only so
 * captions can break lines and reveal one word at a time), a normal space
 * everywhere else so Latin/numbers/punctuation don't run together.
 *
 * Getting this wrong is visible: the burnt-in captions come from the Python
 * side and read "ติดขนตา", while the editor list built here would read
 * "ติด ขน ตา" for the same line.
 */
export function joinWords(words: string[]): string {
  let out = ''
  let prevLast = ''
  for (const raw of words) {
    const w = raw.trim()
    if (!w) continue
    if (out && !(THAI_CHAR.test(prevLast) && THAI_CHAR.test(w[0]))) out += ' '
    out += w
    prevLast = w[w.length - 1]
  }
  return out
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
      text: joinWords(group.map((w) => w.word)),
      start,
      end
    })
  }
  return lines
}

// ── dub_first captions ───────────────────────────────────────────────────────

/**
 * Split a Thai/mixed string into word tokens.
 *
 * `Intl.Segmenter` is the only word splitter available in both the renderer
 * and the test runner, and Thai has no spaces to split on. A locale that does
 * not support Thai segmentation still returns the whole string as one token,
 * which degrades to "the caption does not split", never to broken text.
 */
export function segmentWords(text: string): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') {
    return trimmed.split(/\s+/)
  }
  const seg = new Intl.Segmenter('th', { granularity: 'word' })
  const out: string[] = []
  for (const part of seg.segment(trimmed)) {
    const w = part.segment.trim()
    if (w) out.push(w)
  }
  return out.length > 0 ? out : [trimmed]
}

/** One scene of the cut, in output time. */
export interface DubScene {
  lineId: number
  script: string
  start: number
  end: number
}

/**
 * Caption lines for `dub_first`, where there are no word timestamps at all —
 * the voiceover is recorded against the cut, not transcribed from it, so
 * `groupWordsIntoLines` has nothing to work with.
 *
 * A voiceover line is spoken across the scenes cut for it, so its text is
 * divided between those scenes in proportion to how long each scene is on
 * screen, and every resulting caption is clamped to its own scene. That is
 * what stops a caption outliving the shot it belongs to — the failure the
 * plan calls out.
 *
 * The split is approximate by nature (nobody knows exactly when each word is
 * spoken), which is why the editor lets the user drag the boundaries.
 */
export function dubCaptionLines(scenes: DubScene[]): CaptionLine[] {
  const byLine = new Map<number, DubScene[]>()
  for (const scene of scenes) {
    if (scene.end <= scene.start) continue
    const list = byLine.get(scene.lineId) ?? []
    list.push(scene)
    byLine.set(scene.lineId, list)
  }

  const lines: CaptionLine[] = []
  for (const group of byLine.values()) {
    const words = segmentWords(group[0].script)
    if (words.length === 0) continue

    // Fewer words than scenes: the first scenes each take one word and the
    // rest get no caption, rather than every scene showing the same text.
    const total = group.reduce((sum, s) => sum + (s.end - s.start), 0)
    let cursor = 0
    group.forEach((scene, i) => {
      const remainingScenes = group.length - i
      const remainingWords = words.length - cursor
      if (remainingWords <= 0) return
      const share = total > 0 ? (scene.end - scene.start) / total : 1 / group.length
      // Always leave one word for each scene still to come, so a long opening
      // scene cannot swallow the whole line.
      const take =
        i === group.length - 1
          ? remainingWords
          : Math.max(
              1,
              Math.min(remainingWords - (remainingScenes - 1), Math.round(words.length * share))
            )
      const text = joinWords(words.slice(cursor, cursor + take))
      cursor += take
      if (!text) return
      lines.push({ id: `cap${lines.length}`, text, start: scene.start, end: scene.end })
    })
  }

  return lines.sort((a, b) => a.start - b.start)
}

/**
 * Per-word timings for caption lines that have none — dub_first's whole
 * situation, since its voiceover is never transcribed.
 *
 * Only the reveal modes (word_pop / typewriter) need this: the burn-in falls
 * back to splitting a line on whitespace, and Thai has no spaces, so without
 * these tokens a Thai line "reveals" as one lump. The timings are an even
 * spread across the line — nobody knows when each word is actually spoken, and
 * a guessed rhythm would be no more true than an even one.
 */
export function captionWordsFromLines(lines: CaptionLine[]): CaptionWord[] {
  const words: CaptionWord[] = []
  for (const line of lines) {
    const span = line.end - line.start
    if (span <= 0) continue
    const tokens = segmentWords(line.text)
    if (tokens.length === 0) continue
    const step = span / tokens.length
    tokens.forEach((word, i) => {
      words.push({
        word,
        start: Number((line.start + i * step).toFixed(3)),
        end: Number((line.start + (i + 1) * step).toFixed(3))
      })
    })
  }
  return words
}

/** `1,234` seconds → SubRip's `HH:MM:SS,mmm`. */
function srtStamp(sec: number): string {
  // Round to whole milliseconds FIRST, then split. Rounding the fraction on its
  // own could carry to 1000 (e.g. 1.9997 → "00:00:01,1000"), which is not a
  // valid SubRip stamp — players reject the cue or the whole file.
  const totalMs = Math.max(0, Math.round(sec * 1000))
  const ms = totalMs % 1000
  const totalSec = (totalMs - ms) / 1000
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`
}

/**
 * Caption lines → SubRip (.srt) text, for the editor's "ส่งออก .srt".
 *
 * Exports what is on screen right now, not what the last render burned in —
 * the point of the button is to take your edits elsewhere before re-rendering.
 * Empty lines are skipped: a blank cue is invalid SubRip.
 */
export function captionLinesToSrt(lines: CaptionLine[]): string {
  return (
    [...lines]
      .filter((l) => l.text.trim())
      .sort((a, b) => a.start - b.start)
      .map((l, i) => `${i + 1}\n${srtStamp(l.start)} --> ${srtStamp(l.end)}\n${l.text.trim()}\n`)
      .join('\n') + '\n'
  )
}
