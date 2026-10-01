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
 *   data-scene[="n"]       pinned scene: gets --p (0–1) and data-beat (0…n-1);
 *                          the beat it just left keeps data-leaving while it fades
 *   data-scene-auto        where nothing is pinned, its beats play on a timer
 *                          (data-scene-durations: ms per beat; data-scene-hold,
 *                          set by the scene's own script, keeps the current beat)
 *   data-scene-track       inside a scene: gets --shift (px) for a sideways track
 *   data-countup           a number that counts up when revealed
 *   data-magnetic          a control that leans toward a fine pointer
 */

/** Pinned scenes run only where the CSS pins them (see components.css). */
export const PIN_MEDIA = "(min-width: 1024px) and (min-height: 600px)";
const STILL = "(prefers-reduced-motion: reduce)";
/** How long a beat fades out (hero.css .edm__beat transition). */
const BEAT_FADE_MS = 450;

const leaving = new WeakMap<HTMLElement, number>();

/**
 * Moves a scene to `beat`. The beat it leaves keeps data-leaving for as long
 * as it fades, so its choreography can hold the frame it had reached instead
 * of snapping to its settled state mid-fade (a flash of another screen).
 */
function setBeat(scene: HTMLElement, beat: number) {
  const previous = scene.getAttribute("data-beat");
  const next = String(beat);
  if (previous === next) return;
  if (previous !== null) {
    scene.setAttribute("data-leaving", previous);
    window.clearTimeout(leaving.get(scene));
    leaving.set(
      scene,
      window.setTimeout(() => scene.removeAttribute("data-leaving"), BEAT_FADE_MS),
    );
  }
  scene.setAttribute("data-beat", next);
}

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
      // Measure them all before marking any: each mark restyles the page, and
      // a measurement after it would lay the whole page out again.
      const inView = waiting.map((element) => {
        const rect = element.getBoundingClientRect();
        return rect.top < fold && rect.bottom > 0;
      });
      waiting.forEach((element, index) => {
        if (inView[index]) element.setAttribute("data-reveal-state", "now");
        else {
          element.setAttribute("data-reveal-state", "wait");
          io.observe(element);
        }
      });
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
            if (beats > 0) setBeat(scene, Math.min(beats - 1, Math.floor(progress * beats)));
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
        // data-scene-auto plays its beats on a timer while it is on screen:
        // each beat for its entry in data-scene-durations (ms), else 2.6 s.
        const autos = scenes.filter((scene) => scene.hasAttribute("data-scene-auto"));
        if (autos.length) {
          const timers = new Map<HTMLElement, number>();
          const stop = (scene: HTMLElement) => {
            window.clearTimeout(timers.get(scene));
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
                const durations = (scene.getAttribute("data-scene-durations") ?? "").split(",").map(Number);
                // data-scene-hold (set while a visitor is using the beat, e.g. the
                // hero editor's timeline) keeps the beat where it is.
                const show = (beat: number) => {
                  setBeat(scene, beat);
                  timers.set(
                    scene,
                    window.setTimeout(() => show(scene.hasAttribute("data-scene-hold") ? beat : (beat + 1) % beats), durations[beat] || 2600),
                  );
                };
                show(0);
              }
            },
            { threshold: 0.4 },
          );
          // Watch the illustration itself (a phone shows the whole scene taller than the screen).
          autos.forEach((scene) => auto.observe(scene.querySelector<HTMLElement>("[data-scene-stage]") ?? scene));
          cleanups.push(() => {
            auto.disconnect();
            timers.forEach((timer) => window.clearTimeout(timer));
          });
        }
      }
    }

    return () => cleanups.forEach((cleanup) => cleanup());
  }, [pathname]);

  // Magnetic controls: a primary button leans a little toward the pointer.
  useEffect(() => {
    const fine = window.matchMedia("(pointer: fine) and (min-width: 1024px)");
    if (!fine.matches || window.matchMedia(STILL).matches) return;
    let magnet: HTMLElement | null = null;

    const release = () => {
      if (magnet) magnet.style.translate = "";
      magnet = null;
    };

    const onMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      const target = event.target instanceof Element ? event.target : null;
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

    document.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", release);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", release);
      release();
    };
  }, []);

  return null;
}
