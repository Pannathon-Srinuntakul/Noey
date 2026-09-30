"use client";

import { useEffect, useRef } from "react";

/**
 * Wakes a mock-up up as it nears the screen: its windows get `data-live`,
 * which attaches the footage tiles (--am-strip), and the demo pointer learns
 * where its targets are. Everything else about the mock-up is CSS; without
 * this script the tiles come from the <noscript> style below and the pointer
 * stays hidden.
 */
export function MockLive() {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const figure = ref.current?.parentElement;
    if (!figure) return;
    const roots = [...figure.querySelectorAll<HTMLElement>(".am")];

    // Pointer targets, in the window's own pixels (the window is scaled, so
    // screen boxes are divided back by its scale).
    const aim = () => {
      for (const root of roots) {
        const pointer = root.querySelector<HTMLElement>(".am-pointer");
        if (!pointer) continue;
        const box = root.getBoundingClientRect();
        const scale = box.width / root.offsetWidth || 1;
        for (const target of root.querySelectorAll<HTMLElement>("[data-am-target]")) {
          const r = target.getBoundingClientRect();
          if (!r.width) continue;
          const x = (r.left + r.width / 2 - box.left) / scale;
          const y = (r.top + r.height / 2 - box.top) / scale;
          pointer.style.setProperty(`--to-${target.dataset.amTarget}`, `${Math.round(x)}px ${Math.round(y)}px`);
        }
        pointer.setAttribute("data-aimed", "");
      }
    };

    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        for (const root of roots) root.setAttribute("data-live", "");
        void document.fonts.ready.then(aim);
        io.disconnect();
      },
      { rootMargin: "50% 0px" },
    );
    io.observe(figure);
    return () => io.disconnect();
  }, []);

  return (
    <>
      <span ref={ref} hidden />
      <noscript>
        <style>{".am{--am-strip:var(--am-strip-src)}"}</style>
      </noscript>
    </>
  );
}
