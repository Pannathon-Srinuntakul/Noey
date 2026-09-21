import type { EditCut } from '../../lib/editorApi'
import type { BeatSnapTrimInput } from '../../lib/timelineMath'

export type WorkingCut = EditCut

/** What a trim needs to snap a scene's end onto the music's beats. */
export type TrimSnapContext = Pick<
  BeatSnapTrimInput,
  'beatsSec' | 'snapEnabled' | 'musicOffsetSec' | 'musicTrimInSec'
>
