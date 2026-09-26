import type { EditCut } from '../../lib/editorApi'
import type { SnapContext } from '../../lib/timelineSnap'

export type WorkingCut = EditCut

export type { SnapContext, SnapHit, SnapKind, SnapTarget } from '../../lib/timelineSnap'

/**
 * What a lane reads at pointerdown to snap a drag — now the shared
 * `SnapContext` (cut edges, playhead, voiceover lines, captions, music, beats,
 * markers) rather than the music-only beat input it used to be. Kept as an
 * alias so an older import of the name still resolves; new code imports
 * `SnapContext` directly.
 */
export type TrimSnapContext = SnapContext
