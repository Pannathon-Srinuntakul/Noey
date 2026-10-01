import { keepThaiProse } from "@/components/ds/ThaiProse";
import { Icon } from "@/components/mockups/app/ui";
import { MODES } from "@/lib/modes";

/**
 * The three modes side by side, each drawn as a track: its name with the
 * editor's own icon, the footage it is for, what the system does in three
 * cues, and what comes out. Data: lib/modes.ts.
 */
export function ModeTracks() {
  return (
    <ol className="modes" data-reveal="stagger">
      {MODES.map((mode, index) => (
        <li key={mode.name} className="mode">
          <div className="mode__head">
            <span className="mode__icon" aria-hidden="true">
              <Icon name={mode.icon} size={20} strokeWidth={1.8} />
            </span>
            <span className="trk tc" aria-hidden="true">
              {`M${index + 1}`}
            </span>
            <h3 className="mode__name">{mode.name}</h3>
          </div>
          <p className="mode__fit">
            <span className="mode__label">เหมาะกับ</span>
            {keepThaiProse(mode.fit)}
          </p>
          <ol className="mode__steps">
            {mode.steps.map((step, at) => (
              <li key={step}>
                <span className="mode__n tc" aria-hidden="true">
                  {String(at + 1).padStart(2, "0")}
                </span>
                <span>{keepThaiProse(step)}</span>
              </li>
            ))}
          </ol>
          <p className="mode__result">
            {mode.result.map((item) => (
              <span key={item} className="mode__chip">
                {keepThaiProse(item)}
              </span>
            ))}
          </p>
        </li>
      ))}
    </ol>
  );
}
