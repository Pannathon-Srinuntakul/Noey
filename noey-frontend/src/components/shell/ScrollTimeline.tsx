"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { formatTimecode } from "../ds/timecode";

/** How many pixels of scrolling make one second of "footage" on the ruler. */
const PX_PER_SECOND = 90;
/** How far down the header's fade reaches (shell.css, .hdr::before), beta strip included. */
const HEADER_FADE_PX = 120;

interface Mark {
  element: HTMLElement;
  at: number;
  node: HTMLDivElement;
}

/**
 * The page as a timeline: a timecode ruler under the header with a gold
 * playhead that follows the scroll, and one marker per section heading
 * (every visible <h2> in <main>, read from the page itself). Hover a marker
 * for the section's name; click it to jump there. Phones get a thin progress
 * line only. It is the page's one clock: the sections' stamps and the
 * footer's END are rewritten from it once the page is measured.
 *
 * Purely an extra way to move around the page — the same sections are
 * reachable by scrolling, headings and the table of contents — so it is
 * hidden from assistive technology and takes no tab stops.
 */
export function ScrollTimeline() {
  const pathname = usePathname();
  const root = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const readout = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const bar = root.current;
    const marksLayer = layer.current;
    const tc = readout.current;
    if (!bar || !marksLayer || !tc) return;

    let marks: Mark[] = [];
    let frame = 0;
    let lastText = "";
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const docTop = (element: HTMLElement) => element.getBoundingClientRect().top + window.scrollY;
    const scrollable = () => Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    const offset = () => {
      const header = document.querySelector<HTMLElement>("[data-site-header] .hdr__bar");
      return (header?.getBoundingClientRect().bottom ?? 80) + 24;
    };

    // The night scenes (the closing call to action, the footer): while one is
    // under the header, the header's fade must not paint the day background
    // over it (shell.css, html[data-night-under]).
    let nights: HTMLElement[] = [];

    const update = () => {
      frame = 0;
      const max = scrollable();
      const progress = Math.min(1, Math.max(0, window.scrollY / max));
      const nightUnder = nights.some((night) => {
        const box = night.getBoundingClientRect();
        return box.top < HEADER_FADE_PX && box.bottom > 0;
      });
      bar.style.setProperty("--p", progress.toFixed(4));
      document.documentElement.toggleAttribute("data-scrolled", window.scrollY > 24);
      document.documentElement.toggleAttribute("data-night-under", nightUnder);
      const text = formatTimecode(window.scrollY / PX_PER_SECOND);
      if (text !== lastText) {
        tc.textContent = text;
        lastText = text;
      }
      for (const mark of marks) mark.node.toggleAttribute("data-passed", mark.at <= progress + 0.002);
    };

    const build = () => {
      // Every measurement first, then every change: a change between two
      // measurements would make the browser lay the page out again.
      const max = scrollable();
      const top = offset();
      nights = [...document.querySelectorAll<HTMLElement>("main .theme-night, [data-site-footer]")];
      // The sections' own stamps show the time the ruler reads when their
      // heading reaches the playhead (never past END).
      const stamps = [...document.querySelectorAll<HTMLElement>("main .sec-head__tc, main .chapter__tc")].flatMap((stamp) => {
        const anchor = stamp.closest(".sec-head")?.querySelector<HTMLElement>("h1, h2, h3") ?? stamp.closest<HTMLElement>(".chapter");
        if (!anchor || anchor.offsetParent === null) return [];
        return [{ stamp, text: formatTimecode(Math.min(max, Math.max(0, docTop(anchor) - top)) / PX_PER_SECOND) }];
      });
      // A status card's own heading (checkout, verification) is not a section.
      const headings = [...document.querySelectorAll<HTMLElement>("main h2")]
        .filter((heading) => heading.offsetParent !== null && !heading.closest("dialog, details:not([open]), [hidden], .status"))
        .map((element) => ({ element, at: Math.min(1, Math.max(0, (docTop(element) - top) / max)) }));

      // The footer's end credit shows the page's full length on the same clock.
      const end = document.querySelector<HTMLElement>("[data-end-tc]");
      if (end) end.textContent = `END · ${formatTimecode(max / PX_PER_SECOND)}`;
      for (const { stamp, text } of stamps) stamp.textContent = text;
      marksLayer.replaceChildren();
      marks = headings.map(({ element, at }) => {
        const node = document.createElement("div");
        node.className = "stl__mark";
        node.style.left = `${(at * 100).toFixed(3)}%`;
        const tip = document.createElement("span");
        tip.className = "stl__tip";
        if (at > 0.86) tip.style.translate = "-88% 0";
        if (at < 0.1) tip.style.translate = "-12% 0";
        tip.textContent = (element.getAttribute("aria-label") || element.textContent || "").trim();
        node.append(tip);
        node.addEventListener("click", () => {
          window.scrollTo({ top: Math.max(0, docTop(element) - top), behavior: still ? "auto" : "smooth" });
        });
        marksLayer.append(node);
        return { element, at, node };
      });
      update();
    };

    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };

    let rebuild = 0;
    const scheduleBuild = () => {
      window.clearTimeout(rebuild);
      rebuild = window.setTimeout(build, 180);
    };

    const resize = new ResizeObserver(scheduleBuild);
    resize.observe(document.body);
    window.addEventListener("scroll", onScroll, { passive: true });
    const first = window.setTimeout(build, 60);

    return () => {
      window.clearTimeout(first);
      window.clearTimeout(rebuild);
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      resize.disconnect();
    };
  }, [pathname]);

  return (
    <div className="stl" ref={root} aria-hidden="true">
      <div className="stl__ticks" />
      <div className="stl__fill" />
      <div className="stl__marks" ref={layer} />
      <div className="stl__playhead" />
      <span className="stl__tc tc" ref={readout}>
        00:00:00:00
      </span>
    </div>
  );
}
