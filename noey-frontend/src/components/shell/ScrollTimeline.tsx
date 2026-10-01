"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { formatTimecode } from "../ds/timecode";
import { whenHydrated } from "@/lib/client/hydration";
import { LOADED_EVENT, LOADING_TEXT } from "@/lib/loading";

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
 *
 * It is also the site's navigation indicator (loading.css): while a page is
 * on its way the playhead steps aside and a second one scrubs the ruler, the
 * clock counting the wait; when the page is ready the playhead snaps back to
 * the new page's position. Driven by CSS from <html data-nav-pending> and
 * from any route loading state on the page.
 */
const noop = () => () => {};

export function ScrollTimeline() {
  const pathname = usePathname();
  // The indicator's parts are drawn on the client only: no page's HTML
  // carries them (true once hydrated, false on the server).
  const client = useSyncExternalStore(noop, () => true, () => false);
  const root = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const readout = useRef<HTMLSpanElement>(null);

  // Any link that leaves for another page in this app — not only the header's
  // and the account's, which say so themselves (LinkPending) — sets the ruler
  // pending until the new page commits. A Next.js <Link> cancels the browser's
  // own navigation (defaultPrevented) and fetches the page; a plain link the
  // browser follows itself is left to the browser.
  useEffect(() => {
    const rootElement = document.documentElement;
    rootElement.removeAttribute("data-nav-pending");
  }, [pathname]);

  useEffect(() => {
    const rootElement = document.documentElement;
    let safety = 0;
    let watch = 0;
    const clear = () => {
      window.clearTimeout(safety);
      window.cancelAnimationFrame(watch);
      rootElement.removeAttribute("data-nav-pending");
    };
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || (link.target && link.target !== "_self") || link.hasAttribute("download")) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname || url.pathname.startsWith("/api/")) return;
      // After every handler has run: was it taken over by the router, and is
      // it still on its way (a prefetched page may already be in)?
      const from = window.location.pathname;
      window.setTimeout(() => {
        if (!event.defaultPrevented || window.location.pathname !== from) return;
        rootElement.setAttribute("data-nav-pending", "");
        window.clearTimeout(safety);
        safety = window.setTimeout(clear, 15_000);
        // Done the moment the address changes, whatever order React's effects run in.
        window.cancelAnimationFrame(watch);
        const settle = () => {
          if (window.location.pathname !== from) clear();
          else watch = window.requestAnimationFrame(settle);
        };
        watch = window.requestAnimationFrame(settle);
      }, 0);
    };
    document.addEventListener("click", onClick, true);
    window.addEventListener("pageshow", clear);
    return () => {
      clear();
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("pageshow", clear);
    };
  }, []);

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
      // Where the page is scrolled when `element` reaches the playhead. On a
      // pinned sideways track (MotionRuntime's data-scene-track, moved by the
      // scroll) every heading shares one top: it arrives when the track has
      // carried it to the middle of the screen.
      const reach = (element: HTMLElement) => {
        const track = element.closest<HTMLElement>("[data-scene-track]");
        const scene = track?.closest<HTMLElement>("[data-scene]");
        if (track && scene && getComputedStyle(track).transform !== "none") {
          const shift = Math.max(0, track.scrollWidth - (track.parentElement?.clientWidth ?? window.innerWidth));
          const length = scene.offsetHeight - window.innerHeight;
          if (shift > 0 && length > 0) {
            const now = Number.parseFloat(scene.style.getPropertyValue("--p")) || 0;
            const left = element.getBoundingClientRect().left + now * shift;
            const progress = Math.min(1, Math.max(0, (left - window.innerWidth / 2) / shift));
            return docTop(scene) + progress * length;
          }
        }
        return docTop(element) - top;
      };
      // The sections' own stamps show the time the ruler reads when their
      // heading reaches the playhead (never past END).
      const stamps = [...document.querySelectorAll<HTMLElement>("main .sec-head__tc, main .chapter__tc")].flatMap((stamp) => {
        const anchor = stamp.closest(".sec-head")?.querySelector<HTMLElement>("h1, h2, h3") ?? stamp.closest<HTMLElement>(".chapter");
        if (!anchor || anchor.offsetParent === null) return [];
        return [{ stamp, text: formatTimecode(Math.min(max, Math.max(0, reach(anchor))) / PX_PER_SECOND) }];
      });
      // A status card's own heading (checkout, verification) is not a section,
      // nor is a card's heading inside the account panel (its tabs are the
      // account's sections; a lone marker per tab read as a stray).
      const headings = [...document.querySelectorAll<HTMLElement>("main h2")]
        .filter((heading) => heading.offsetParent !== null && !heading.closest("dialog, details:not([open]), [hidden], .status, .acct-page__panel"))
        .map((element) => ({ element, at: Math.min(1, Math.max(0, reach(element) / max)) }));

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
          window.scrollTo({ top: Math.max(0, at * max), behavior: still ? "auto" : "smooth" });
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

    // The section stamps are written into the page: only once React has
    // hydrated it (a stamp changed before that is a hydration mismatch).
    const resize = new ResizeObserver(scheduleBuild);
    let first = 0;
    const cancelWait = whenHydrated("main .sec-head__tc, main .chapter__tc", () => {
      resize.observe(document.body);
      window.addEventListener("scroll", onScroll, { passive: true });
      // A loading state gave way to its page: read the page's sections again.
      window.addEventListener(LOADED_EVENT, scheduleBuild);
      first = window.setTimeout(build, 60);
    });

    return () => {
      cancelWait();
      window.clearTimeout(first);
      window.clearTimeout(rebuild);
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener(LOADED_EVENT, scheduleBuild);
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
      {/* The navigation indicator (loading.css): the scrubbing playhead, and the wait clock. */}
      {client ? (
        <>
          <div className="stl__scrub">
            <span className="stl__rail">
              <i />
            </span>
          </div>
          <span className="stl__wait">
            <span className="stl__wait-label">{LOADING_TEXT}</span>
            <span className="tc ld-tc" />
          </span>
        </>
      ) : null}
    </div>
  );
}
