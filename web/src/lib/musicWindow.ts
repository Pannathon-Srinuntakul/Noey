/**
 * Where the attached music sits on the output timeline, in the shape the cut
 * AI routes accept (PARITY #41).
 *
 * The server keeps the track's beat grid in FILE time (librosa ran on the whole
 * file). Trimming the song or sliding it along the timeline moves every beat on
 * the output clock, so each AI call that aligns scene changes to the beat —
 * analyze-video, reedit-dub-scenes (form fields) and plan-dub (JSON) — is told
 * the placement and maps the beats itself (`music_beats_on_output`).
 *
 * Only non-default values travel: the defaults (untrimmed track at 0) are what
 * the server assumes, and a field it would refuse (a negative offset, an end
 * at or before the start) is left out rather than failing the whole run.
 *
 * Shared byte-identical between desktop (`desktop/app/src/renderer/src/lib`)
 * and web (`web/src/lib`).
 */

export interface MusicWindow {
  offsetSec: number
  trimInSec: number
  trimOutSec: number | null
}

interface MusicWindowValues {
  offset?: number
  trimIn?: number
  trimOut?: number
}

function windowValues(music: MusicWindow | null | undefined): MusicWindowValues {
  if (!music) return {}
  const out: MusicWindowValues = {}
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
  if (finite(music.offsetSec) && music.offsetSec > 0) out.offset = music.offsetSec
  const trimIn = finite(music.trimInSec) && music.trimInSec > 0 ? music.trimInSec : 0
  if (trimIn > 0) out.trimIn = trimIn
  if (finite(music.trimOutSec) && music.trimOutSec > trimIn) out.trimOut = music.trimOutSec
  return out
}

/** Form fields for analyze-video / reedit-dub-scenes. */
export function musicWindowFormFields(
  music: MusicWindow | null | undefined
): Record<string, string> {
  const v = windowValues(music)
  return {
    ...(v.offset !== undefined ? { music_offset_sec: String(v.offset) } : {}),
    ...(v.trimIn !== undefined ? { music_trim_in_sec: String(v.trimIn) } : {}),
    ...(v.trimOut !== undefined ? { music_trim_out_sec: String(v.trimOut) } : {})
  }
}

/** JSON body fields for plan-dub. */
export function musicWindowBody(music: MusicWindow | null | undefined): {
  musicOffsetSec?: number
  musicTrimInSec?: number
  musicTrimOutSec?: number
} {
  const v = windowValues(music)
  return {
    ...(v.offset !== undefined ? { musicOffsetSec: v.offset } : {}),
    ...(v.trimIn !== undefined ? { musicTrimInSec: v.trimIn } : {}),
    ...(v.trimOut !== undefined ? { musicTrimOutSec: v.trimOut } : {})
  }
}
