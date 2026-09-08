/**
 * Registers every implemented job with the engine.
 *
 * Importing a job file is what registers it — see `registerJob`. A command with
 * no file here rejects with "ยังไม่รองรับ…", which is deliberate: the UI treats
 * a resolved promise as success, so a silent no-op would look like a finished
 * render.
 *
 * Implemented: probe, ingest, extract-proxy, filmstrip, render-silent,
 * render-final, mix-music, extract-audio, render-timeline, render-highlights.
 *
 * Deliberately absent: render-effects, render-ai-preview, proxy-one — the zoom
 * effects and AI re-edit features are hidden on this build (see
 * `lib/platformFeatures.ts`), so their commands must reject rather than
 * silently resolve.
 */

import './probe'
import './ingest'
import './extractProxy'
import './filmstrip'
import './renderSilent'
import './renderFinal'
import './mixMusic'
import './extractAudio'
import './renderTimeline'
import './renderHighlights'
