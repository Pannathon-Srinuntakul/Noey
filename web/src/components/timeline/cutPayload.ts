import type { EditCut } from '../../lib/editorApi'
import { cutLineId } from '../../lib/timelineMath'
import type { WorkingCut } from './types'

/** The cut list in the shape both the draft save and the render save send. */
export function cutPayload(list: WorkingCut[], isDub: boolean): EditCut[] {
  return list.map(
    (c) =>
      ({
        source: c.source,
        in: c.in,
        out: c.out,
        label: c.label,
        voiceoverLineId: isDub ? (c.voiceoverLineId ?? (cutLineId(c) || null)) : undefined,
        // Trimmed here, where it is stored, not in the script box — see
        // lineScriptDraft.
        voiceoverScript: isDub ? (c.voiceoverScript ?? '').trim() : undefined,
        // The segment fields this editor does not model (alternates, …) —
        // dropping them here emptied ปรับช็อต on every save (EditCut.meta).
        ...(c.meta ? { meta: c.meta } : {})
      }) as EditCut
  )
}

/** The cut list the AI re-edit is sent. Kept exactly as it was when it lived
 * inline in the editor: the line fields are always set, because the re-edit
 * only exists for dub projects (canAiReedit), and `meta` is not sent — what
 * the AI is shown is a prompt decision, not something a save helper decides. */
export function aiReeditPayload(list: WorkingCut[]): EditCut[] {
  return list.map(
    (c) =>
      ({
        source: c.source,
        in: c.in,
        out: c.out,
        label: c.label,
        voiceoverLineId: c.voiceoverLineId ?? (cutLineId(c) || null),
        voiceoverScript: (c.voiceoverScript ?? '').trim()
      }) as EditCut
  )
}
