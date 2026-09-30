import type { CSSProperties } from "react";
import { AppScreen } from "./app/AppScreen";
import { EditorScreen } from "./app/Editor";
import { EditorLive } from "./app/EditorLive";
import { MockLive } from "./app/MockLive";
import { WizardFiles, WizardOutcome } from "./app/Wizard";
import { sceneStillTime } from "./sample";
import "./app/parts.css";

/**
 * One step of the workflow as the app shows it (stands in for a MediaSlot
 * screenshot until the owner supplies one): the wizard's file step, its
 * outcome step, and the editor — the hero's beats 0, 1 and 3, settled. A
 * 1024×768 window, always whole: in a narrow column it scales down. Always
 * labelled "ภาพจำลอง"; the pictures are hidden from assistive technology —
 * the editor's timeline is the one part a visitor can use (scrub, pick a
 * scene), as in the hero.
 */

const WINDOW = { width: 1024, height: 768 };

export function StepMockup({ kind, label, ratio = "4 / 3" }: { kind: "import" | "style" | "timeline"; label: string; ratio?: string }) {
  return (
    <figure className="amstep" aria-label={`ภาพจำลอง: ${label}`}>
      <div
        className="amstep__frame"
        style={{ "--ratio": ratio } as CSSProperties}
        aria-hidden={kind === "timeline" ? undefined : true}
      >
        <AppScreen width={WINDOW.width} height={WINDOW.height}>
          {kind === "import" ? (
            <WizardFiles />
          ) : kind === "style" ? (
            <WizardOutcome mode="highlight" length="15" />
          ) : (
            <EditorScreen windowWidth={WINDOW.width} time={sceneStillTime(2)} interactive video={<EditorLive />} />
          )}
        </AppScreen>
        <MockLive />
      </div>
      <figcaption className="amstep__tag mock-tag">ภาพจำลอง · {label}</figcaption>
    </figure>
  );
}
