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

/**
 * Beat snapping needs a beat grid, and computing one is a server-side analysis
 * this build does not run.
 *
 * The reason used to be stated as "the web build never uploads the music".
 * That stopped being true when the server became the home of a project's
 * files — `music/` is a synced root, so the track is already there. What is
 * actually missing is the analysis pass and the editor's snap control, and a
 * rationale that is no longer true is worse than none: it is the sentence the
 * next person reads before deciding whether the feature can be turned on.
 */
export const canSnapToBeat = !isBrowser
