import type { FaqItem } from "@/lib/faq";

/**
 * Native <details> FAQ — server-rendered, works without JavaScript, and the
 * answers stay in the HTML for crawlers even while collapsed. Questions are
 * <h3> so the page outline carries them (answer-engine friendly).
 */
export function FaqList({ items, compact = false }: { items: readonly FaqItem[]; compact?: boolean }) {
  return (
    <div className={compact ? "faq-list faq-list--compact" : "faq-list"}>
      {items.map((item) => (
        <details key={item.question} className="faq">
          <summary>
            <h3 className="faq__q">{item.question}</h3>
            <span className="faq__plus" aria-hidden="true">
              +
            </span>
          </summary>
          <p className="faq__a">{item.answer}</p>
        </details>
      ))}
    </div>
  );
}
