"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

/**
 * One small script behind every motion on the site, so pages stay server
 * components and nothing needs hydrating per section.
 *
 * Progressive by construction: every element is fully visible in the server
 * HTML. This script only ever (1) hides things that are still BELOW the fold
 * so they can be revealed, (2) pauses loops that are off screen, and (3)
 * feeds scroll progress to pinned scenes. With JavaScript off, or with
 * prefers-reduced-motion, nothing is hidden and nothing moves.
 *
 * Attributes it understands:
 *   data-reveal            reveal once in view (CSS decides how: rise, words, draw…)
 *   data-play              loops inside run only while on screen
 *   data-scene[="n"]       pinned scene: gets --p (0–1) and data-beat (0…n-1)
 *   data-scene-track       inside a scene: gets --shift (px) for a sideways track
 *   data-countup           a number that counts up when revealed
 *   data-magnetic          a control that leans toward a fine pointer
 */

/** Pinned scenes run only where the CSS pins them (see components.css). */
export const PIN_MEDIA = "(min-width: 1024px) and (min-height: 600px)";
const STILL = "(prefers-reduced-motion: reduce)";
const INTERACTIVE = "a, button, summary, label, input, textarea, select, [role='button'], form, dialog, .prose, [data-no-cursor]";

function countUp(element: HTMLElement) {
  const target = element.getAttribute("data-countup") ?? "";
  const value = Number(target.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(value) || value <= 0) return;
  const shown = element.querySelector<HTMLElement>("[data-countup-value]") ?? element;
  const final = shown.textContent ?? target;
  const decimals = final.includes(".") ? (final.split(".")[1]?.length ?? 0) : 0;
  const started = performance.now();
  const duration = 1100;
  element.setAttribute("aria-hidden", "true");
  const tick = (now: number) => {
    const t = Math.min(1, (now - started) / duration);
    const eased = 1 - Math.pow(1 - t, 4);
    shown.textContent = (value * eased).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    if (t < 1) window.requestAnimationFrame(tick);
    else {
      shown.textContent = final;
      element.removeAttribute("aria-hidden");
    }
  };
  window.requestAnimationFrame(tick);
}

export function MotionRuntime() {
  const pathname = usePathname();

  // Page-level wiring: reveals, loops, scenes. Re-run on every navigation.
  useEffect(() => {
    const still = window.matchMedia(STILL).matches;
    const cleanups: Array<() => void> = [];

    // Loops: pause whatever is off screen (they run by default without JS).
    const players = [...document.querySelectorAll<HTMLElement>("[data-play]")];
    if (players.length) {
      const io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) entry.target.toggleAttribute("data-paused", !entry.isIntersecting);
        },
        { rootMargin: "120px 0px" },
      );
      players.forEach((player) => io.observe(player));
      cleanups.push(() => io.disconnect());
    }

    if (!still) {
      // Reveals: only what is still below the fold waits; the rest is "now".
      // Elements left waiting by an earlier run (a re-run effect) are taken up again.
      const waiting = [...document.querySelectorAll<HTMLElement>('[data-reveal]:not([data-reveal-state="in"]):not([data-reveal-state="now"])')];
      const fold = window.innerHeight * 0.92;
      const io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const element = entry.target as HTMLElement;
            element.setAttribute("data-reveal-state", "in");
            if (element.hasAttribute("data-countup")) countUp(element);
            io.unobserve(element);
          }
        },
        { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
      );
      for (const element of waiting) {
        const rect = element.getBoundingClientRect();
        if (rect.top < fold && rect.bottom > 0) element.setAttribute("data-reveal-state", "now");
        else {
          element.setAttribute("data-reveal-state", "wait");
          io.observe(element);
        }
      }
      cleanups.push(() => io.disconnect());

      // Pinned scenes: progress through the scene's scroll length.
      const pin = window.matchMedia(PIN_MEDIA);
      const scenes = [...document.querySelectorAll<HTMLElement>("[data-scene]")];
      if (scenes.length) {
        const active = new Set<HTMLElement>();
        let frame = 0;
        const measure = () => {
          for (const scene of scenes) {
            const track = scene.querySelector<HTMLElement>("[data-scene-track]");
            if (!track) continue;
            const shift = Math.max(0, track.scrollWidth - (track.parentElement?.clientWidth ?? window.innerWidth));
            scene.style.setProperty("--shift", `${shift}px`);
          }
        };
        const update = () => {
          frame = 0;
          if (!pin.matches) return;
          const vh = window.innerHeight;
          const center = window.innerWidth / 2;
          for (const scene of active) {
            const rect = scene.getBoundingClientRect();
            const length = Math.max(1, rect.height - vh);
            const progress = Math.min(1, Math.max(0, -rect.top / length));
            scene.style.setProperty("--p", progress.toFixed(4));
            const beats = Number(scene.getAttribute("data-scene")) || 0;
            if (beats > 0) scene.setAttribute("data-beat", String(Math.min(beats - 1, Math.floor(progress * beats))));
            // A track read past a fixed playhead: mark what is under it.
            if (scene.hasAttribute("data-scene-items")) {
              for (const item of scene.querySelectorAll<HTMLElement>("[data-scene-item]")) {
                const box = item.getBoundingClientRect();
                item.toggleAttribute("data-live", box.left <= center && box.right >= center);
              }
            }
          }
        };
        const onScroll = () => {
          if (!frame) frame = window.requestAnimationFrame(update);
        };
        const io = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            const scene = entry.target as HTMLElement;
            if (entry.isIntersecting) active.add(scene);
            else active.delete(scene);
          }
          onScroll();
        });
        scenes.forEach((scene) => io.observe(scene));
        const resize = new ResizeObserver(() => {
          measure();
          onScroll();
        });
        resize.observe(document.body);
        measure();
        window.addEventListener("scroll", onScroll, { passive: true });
        cleanups.push(() => {
          io.disconnect();
          resize.disconnect();
          window.removeEventListener("scroll", onScroll);
          window.cancelAnimationFrame(frame);
        });

        // Where nothing is pinned (phones, short windows), a scene marked
        // data-scene-auto plays its beats on a timer while it is on screen.
        const autos = scenes.filter((scene) => scene.hasAttribute("data-scene-auto"));
        if (autos.length) {
          const timers = new Map<HTMLElement, number>();
          const stop = (scene: HTMLElement) => {
            window.clearInterval(timers.get(scene));
            timers.delete(scene);
          };
          const auto = new IntersectionObserver(
            (entries) => {
              for (const entry of entries) {
                const scene = (entry.target as HTMLElement).closest<HTMLElement>("[data-scene]");
                if (!scene) continue;
                if (!entry.isIntersecting || pin.matches) {
                  stop(scene);
                  continue;
                }
                if (timers.has(scene)) continue;
                const beats = Number(scene.getAttribute("data-scene")) || 1;
                let tick = 0;
                scene.setAttribute("data-beat", "0");
                timers.set(
                  scene,
                  window.setInterval(() => {
                    tick = (tick + 1) % (beats + 1);
                    scene.setAttribute("data-beat", String(Math.min(beats - 1, tick)));
                  }, 2600),
                );
              }
            },
            { threshold: 0.4 },
          );
          // Watch the illustration itself (a phone shows the whole scene taller than the screen).
          autos.forEach((scene) => auto.observe(scene.querySelector<HTMLElement>("[data-scene-stage]") ?? scene));
          cleanups.push(() => {
            auto.disconnect();
            timers.forEach((timer) => window.clearInterval(timer));
          });
        }
      }
    }

    return () => cleanups.forEach((cleanup) => cleanup());
  }, [pathname]);

  // Site-wide pointer niceties: the playhead cursor and magnetic controls.
  useEffect(() => {
    const fine = window.matchMedia("(pointer: fine) and (min-width: 1024px)");
    if (!fine.matches || window.matchMedia(STILL).matches) return;
    const root = document.documentElement;
    const cursor = document.querySelector<HTMLElement>(".cursor");

    let x = -100;
    let y = -100;
    let tx = -100;
    let ty = -100;
    let frame = 0;
    let magnet: HTMLElement | null = null;

    const draw = () => {
      x += (tx - x) * 0.32;
      y += (ty - y) * 0.32;
      if (cursor) cursor.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      frame = Math.abs(tx - x) + Math.abs(ty - y) > 0.3 ? window.requestAnimationFrame(draw) : 0;
    };

    const release = () => {
      if (magnet) magnet.style.translate = "";
      magnet = null;
    };

    const onMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      tx = event.clientX;
      ty = event.clientY;
      const target = event.target instanceof Element ? event.target : null;
      if (cursor) cursor.toggleAttribute("data-hidden", !!target?.closest(INTERACTIVE));
      if (!frame) frame = window.requestAnimationFrame(draw);

      const next = target?.closest<HTMLElement>("[data-magnetic]") ?? null;
      if (next !== magnet) release();
      magnet = next;
      if (magnet) {
        const rect = magnet.getBoundingClientRect();
        const dx = (event.clientX - (rect.left + rect.width / 2)) / rect.width;
        const dy = (event.clientY - (rect.top + rect.height / 2)) / rect.height;
        magnet.style.translate = `${(dx * 10).toFixed(1)}px ${(dy * 7).toFixed(1)}px`;
      }
    };
    const onLeave = () => {
      cursor?.setAttribute("data-hidden", "");
      release();
    };

    if (cursor) root.setAttribute("data-cursor", "on");
    document.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    return () => {
      root.removeAttribute("data-cursor");
      document.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      window.cancelAnimationFrame(frame);
      release();
    };
  }, []);

  return null;
}
