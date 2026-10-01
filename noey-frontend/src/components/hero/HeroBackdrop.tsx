"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

const FilmScene = dynamic(() => import("./FilmScene"), { ssr: false });

/** Only a desktop with a fine pointer, room to spare and motion allowed gets the 3D scene. */
function canRender3d(): boolean {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  if (!window.matchMedia("(pointer: fine) and (min-width: 1024px)").matches) return false;
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  if ((nav.hardwareConcurrency ?? 8) <= 4) return false;
  if ((nav.deviceMemory ?? 8) <= 4) return false;
  if (nav.connection?.saveData) return false;
  try {
    const probe = document.createElement("canvas");
    return !!(probe.getContext("webgl2") || probe.getContext("webgl"));
  } catch {
    return false;
  }
}

/**
 * The hero's backdrop. Everyone gets the still version first — a warm
 * projector glow, film grain and a few soft film frames, all in CSS. On a
 * capable desktop the three.js scene is fetched after the page is idle and
 * cross-fades in on top; phones, low-power devices, Save-Data and reduced
 * motion never download it.
 */
export function HeroBackdrop() {
  const [load, setLoad] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!canRender3d()) return;
    const start = () => setLoad(true);
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(start, { timeout: 2500 });
      return () => window.cancelIdleCallback(handle);
    }
    const handle = window.setTimeout(start, 1200);
    return () => window.clearTimeout(handle);
  }, []);

  return (
    <div className="hero-bg" data-3d={ready ? "on" : undefined} aria-hidden="true">
      <div className="hero-bg__glow" />
      <div className="hero-bg__frames">
        <span className="hero-bg__frame hero-bg__frame--1" />
        <span className="hero-bg__frame hero-bg__frame--2" />
        <span className="hero-bg__frame hero-bg__frame--3" />
        <span className="hero-bg__frame hero-bg__frame--4" />
        <span className="hero-bg__frame hero-bg__frame--5" />
      </div>
      {load ? <FilmScene onReady={() => setReady(true)} /> : null}
    </div>
  );
}
