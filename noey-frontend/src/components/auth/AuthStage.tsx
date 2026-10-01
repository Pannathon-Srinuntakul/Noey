import { EditorMockup } from "../mockups/client";

/**
 * The right half of /signup and /login: the editor mockup in its ambient
 * variant (the finished cut, playhead drifting, captions changing slowly),
 * on a dark viewer panel. Hidden on phones and tablets, where the form
 * takes the whole screen.
 */
export function AuthStage() {
  return (
    <div className="auth__stage">
      <div className="auth__viewer">
        <span className="auth__glow" aria-hidden="true" />
        <span className="auth__ruler" aria-hidden="true" />
        <EditorMockup variant="ambient" className="auth__mock" />
      </div>
    </div>
  );
}
