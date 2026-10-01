"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { IconChevronDown } from "./icons";

export interface TocItem {
  id: string;
  /** Text, or text already wrapped for Thai line breaking on the server. */
  label: ReactNode;
  /** The marker's label; defaults to the item's number. Parts that are not numbered sections (FAQ, related pages) carry their own. */
  cue?: string;
  /** 2 = a subsection (an article's ###), listed indented under its section. */
  depth?: 1 | 2;
}

/**
 * The table of contents as a vertical timeline: one cue marker per section
 * heading, and a playhead that follows your reading position down the rail.
 * The current section's link carries aria-current="location".
 *
 * Desktop: a sticky rail beside the text. Phones and tablets: a <details>
 * bar that sticks under the header as you read (works without JavaScript),
 * naming the section you are in; picking a section closes it. Only one of
 * the two is displayed at any width, so only one is ever in the accessibility
 * tree.
 */
export function TimelineToc({ items, label, className }: { items: readonly TocItem[]; label: string; className?: string }) {
  const nav = useRef<HTMLElement>(null);

  useEffect(() => {
    const root = nav.current;
    if (!root) return;
    const rail = root.querySelector<HTMLElement>(".toc__desk");
    const now = root.querySelector<HTMLElement>("[data-toc-now]");
    const links = [...root.querySelectorAll<HTMLAnchorElement>("[data-toc-link]")];
    const targets = items.map((item) => document.getElementById(item.id));
    let frame = 0;

    const update = () => {
      frame = 0;
      const line = window.innerHeight * 0.3;
      let current = -1;
      let fraction = 0;
      targets.forEach((target, index) => {
        if (!target) return;
        const rect = target.getBoundingClientRect();
        if (rect.top <= line) {
          current = index;
          fraction = Math.min(1, Math.max(0, (line - rect.top) / Math.max(1, rect.height)));
        }
      });
      const at = current < 0 ? 0 : Math.min(1, (current + fraction) / Math.max(1, items.length));
      rail?.style.setProperty("--toc-p", at.toFixed(4));
      links.forEach((link) => {
        const index = Number(link.dataset.tocLink);
        if (index === current) link.setAttribute("aria-current", "location");
        else link.removeAttribute("aria-current");
        link.toggleAttribute("data-passed", index <= current);
      });
      // The bar on phones names the section being read ("07 · โควตา…").
      if (now) {
        const link = current >= 0 ? links.find((candidate) => Number(candidate.dataset.tocLink) === current) : undefined;
        const text = link ? `${link.querySelector(".toc__n")?.textContent ?? ""} · ${link.querySelector(".toc__text")?.textContent ?? ""}` : "";
        if (now.textContent !== text) now.textContent = text;
      }
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [items]);

  const list = (
    <ol className="toc__list">
      {items.map((item, index) => (
        <li key={item.id} className={item.depth === 2 ? "toc__sub" : undefined}>
          <a href={`#${item.id}`} data-toc-link={index} className="toc__link">
            <span className="toc__n tc" aria-hidden="true">
              {item.cue ?? String(index + 1).padStart(2, "0")}
            </span>
            <span className="toc__text">{item.label}</span>
          </a>
        </li>
      ))}
    </ol>
  );

  return (
    <nav ref={nav} className={["toc", className].filter(Boolean).join(" ")} aria-label={label}>
      <details
        className="toc__mobile"
        onClick={(event) => {
          // A section picked: the bar folds away so the section is in view.
          if (event.target instanceof Element && event.target.closest("a")) event.currentTarget.open = false;
        }}
      >
        <summary>
          <span className="toc__mobile-label">{label}</span>
          <span className="toc__now" data-toc-now="" aria-hidden="true" />
          <IconChevronDown size={16} />
        </summary>
        {list}
      </details>
      <div className="toc__desk">
        <p className="toc__label">{label}</p>
        <div className="toc__rail">
          <span className="toc__line" aria-hidden="true" />
          <span className="toc__playhead" aria-hidden="true" />
          {list}
        </div>
      </div>
    </nav>
  );
}
