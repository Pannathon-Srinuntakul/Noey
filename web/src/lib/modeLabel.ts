import type { ProjectMode } from './projectFlow'

/** User-facing mode names. Three backend modes collapse into two in the UI:
 * `highlight` is dub_first with voiceover "none" (HANDOFF §6 item 2), so it
 * shares dub_first's label. The stored backend value is untouched. */
export const MODE_LABEL: Record<ProjectMode, string> = {
  talking_head: 'ตัดช่วงเงียบ',
  dub_first: 'ตัดฉากเด่น',
  highlight: 'ตัดฉากเด่น',
  // R17 speech modes — named apart because their results differ in kind:
  // many clips vs one clip with the original voice.
  speech_highlights: 'ตัดไฮไลต์จากคลิปยาว',
  speech_scenes: 'ตัดฉากเด่น · เสียงในคลิป'
}
