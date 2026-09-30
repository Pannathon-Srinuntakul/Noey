import type { FaqItem } from "@/lib/faq";
import { keepThaiProse } from "./ds/ThaiText";

/**
 * Native <details> FAQ — server-rendered, works without JavaScript, and the
 * answers stay in the HTML for crawlers even while collapsed. Questions are
 * <h3> so the page outline carries them (answer-engine friendly).
 *
 * Drawn as cue points on a track: a cue number, the question, and a marker
 * that turns into a playhead when the answer is open.
 */
export function FaqList({ items, compact = false }: { items: readonly FaqItem[]; compact?: boolean }) {
  return (
    <div className={compact ? "faq-list faq-list--compact" : "faq-list"}>
      {items.map((item, index) => (
        <details key={item.question} className="faq">
          <summary>
            <span className="faq__cue tc" aria-hidden="true">
              Q{String(index + 1).padStart(2, "0")}
            </span>
            <h3 className="faq__q">{keepThaiProse(item.question)}</h3>
            <span className="faq__plus" aria-hidden="true" />
          </summary>
          <div className="faq__a">
            <p>{keepThaiProse(item.answer)}</p>
          </div>
        </details>
      ))}
    </div>
  );
}
