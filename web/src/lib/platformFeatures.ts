/**
 * Which features this build actually has.
 *
 * The UI is shared source, so a control it draws unconditionally is a promise
 * this build may not be able to keep. Every capability that depends on
 * something only a local process can do is named here rather than tested
 * inline, so the list of what is missing is one file instead of a grep.
 *
 * A hidden control is better than a disabled one with a hint: the hint has to
 * explain what would enable it, and on this build nothing would.
 */

// Read defensively. This module is imported by pure logic (`wizardState`)
// that unit tests exercise in a node environment with no `window` at all, and
// a bare `window.noey.platform` threw at import time there. An absent bridge
// means "not running inside the desktop shell", which for this source tree is
// the browser — the same answer, reached without a crash.
const platform = (globalThis as { window?: { noey?: { platform?: string } } }).window?.noey
  ?.platform
const isBrowser = platform === undefined || platform === 'web'

/** There is no folder to open — files live in the browser's own storage. */
export const canOpenFolder = !isBrowser

/**
 * Zoom effects need `render-effects` + `render-ai-preview`, neither of which
 * the browser engine implements yet.
 */
export const canUseZoomEffects = !isBrowser

/** AI re-edit needs a preview render for the same reason. */
export const canUseAiReedit = !isBrowser

// Beat snapping is no longer a platform limit (owner, 2026-10-01): the web
// build uploads the attached track to the server's beat analysis exactly like
// the desktop, so `canSnapToBeat` is gone — beats are a snap-target source
// wherever the track has them (see components/timeline/snapTargets.ts).

/**
 * In-app voiceover recording (VoiceoverPage + every button that leads to it).
 *
 * Hidden on web as a PRODUCT decision, not a capability one (the browser can
 * record audio fine): the owner wants the web build shipped without it for
 * now — the dub modes read as "ตัดภาพตามสคริปต์ แล้วไปพากย์เองภายหลัง", and the
 * script panel with its copy button is the hand-off. Turning it back on is
 * this flag alone; every entry point gates on it.
 */
export const canRecordVoiceover = !isBrowser

/**
 * The ใช้เสียงในคลิป choice (speech_scenes) in the wizard's เสียง row.
 * Same story: hidden on web for now by owner's call (2026-09-09), not because
 * the engine cannot do it. Existing speech_scenes projects still open fine —
 * only the wizard stops offering the mode.
 */
export const canUseOriginalVoice = !isBrowser

/**
 * The สไตล์ studio (the `library` route + its nav item) and the wizard's
 * สไตล์การตัด picker. Hidden on web by owner's call (2026-09-22): styles are
 * not being opened to users soon. A product decision, not a capability one —
 * turning it back on is this flag alone. A project that already carries a
 * cutStyleUid still re-cuts with it; only choosing and managing styles goes.
 */
export const canUseStyles = !isBrowser
