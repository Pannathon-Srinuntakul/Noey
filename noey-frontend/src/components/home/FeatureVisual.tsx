import { AppScreen } from "../mockups/app/AppScreen";
import { EditorScreen, TimelineBlock } from "../mockups/app/Editor";
import { EditorLive } from "../mockups/app/EditorLive";
import { MockLive } from "../mockups/app/MockLive";
import { ScriptPanel } from "../mockups/app/Pages";
import { sceneStillTime } from "../mockups/sample";
import "../mockups/app/parts.css";

/**
 * The picture on each of the three big feature cards (home bento), cut from
 * the app itself and hidden from assistive technology — the card's heading
 * and text say everything:
 *   0 the timeline — the scenes the AI cut, the voiceover lines and captions
 *     laid against them, the playhead running through;
 *   1 the project page's script panel — the lines the AI wrote, the one being
 *     spoken lit, copied out with คัดลอก;
 *   2 the whole editor in a browser tab, the cut playing.
 */
export function FeatureVisual({ index }: { index: number }) {
  if (index === 0) {
    return (
      <div className="fv fv--app" aria-hidden="true">
        {/* At rest the playhead sits in the selected scene, clear of the
            ruler's 0:00 (playing, it sweeps the cut from the start). The
            window is the picture's own width, so the editor's fitted zoom
            lays the whole cut inside it — never cropped mid-scene. */}
        <AppScreen width={690} height={253} crop={{ x: 0, y: 0, w: 690, h: 253 }}>
          <TimelineBlock windowWidth={690} time={sceneStillTime(2)} selected={2} run />
        </AppScreen>
        <MockLive />
      </div>
    );
  }
  if (index === 1) {
    return (
      <div className="fv fv--app" aria-hidden="true">
        <AppScreen width={520} height={280}>
          <div className="flex h-full flex-col">
            <ScriptPanel cycling />
          </div>
        </AppScreen>
      </div>
    );
  }
  return (
    <div className="fv fv--browser" aria-hidden="true">
      <div className="fv__address">
        <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
          <path d="M4.5 7V5a3.5 3.5 0 0 1 7 0v2" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <rect x="3" y="7" width="10" height="7" rx="1.5" fill="currentColor" />
        </svg>
        app.noeystudio.com
      </div>
      {/* The window down to its lanes: the hint line under them is left out
          of the drawings (unpainted), and its empty 32px row read as a gap
          between the window and the frame's bottom edge. */}
      <AppScreen width={1024} height={768} crop={{ x: 0, y: 0, w: 1024, h: 736 }}>
        <EditorScreen windowWidth={1024} time={sceneStillTime(2)} video={<EditorLive />} />
      </AppScreen>
      <MockLive />
    </div>
  );
}
