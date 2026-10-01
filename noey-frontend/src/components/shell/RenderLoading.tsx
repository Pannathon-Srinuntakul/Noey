import { ViewTransition, type CSSProperties, type ReactNode } from "react";
import { Waveform } from "../ds/Waveform";
import { NoeyMark } from "../NoeyMark";
import { LOADING_TEXT } from "@/lib/loading";
import { LoadingSignal } from "./LoadingSignal";

/**
 * A timecode that counts the real wait from the moment it appears — CSS
 * counters (loading.css), so it runs before hydration, without JavaScript
 * and with reduced motion. Never a percentage: nobody knows how much is left.
 */
export function WaitClock({ className }: { className?: string }) {
  return <span className={["tc ld-tc", className].filter(Boolean).join(" ")} aria-hidden="true" />;
}

/** A placeholder bar where text, a number or a control will be (`w`, `h`: CSS lengths). */
export function Skel({ w, h, className }: { w?: string; h?: string; className?: string }) {
  const style = { ...(w ? { "--w": w } : null), ...(h ? { "--h": h } : null) } as CSSProperties;
  return <i className={["skel", className].filter(Boolean).join(" ")} style={w || h ? style : undefined} />;
}

/** The lines of a paragraph or a heading, one line box each, in the type of the element they sit in. */
export function SkelLines({ widths, className }: { widths: readonly string[]; className?: string }) {
  return (
    <span className={["skel-lines", className].filter(Boolean).join(" ")}>
      {widths.map((width, index) => (
        <Skel key={index} w={width} />
      ))}
    </span>
  );
}

/**
 * The centre piece of every loading state, "rendering" in the editor's
 * terms: the splice mark draws itself and its two halves part and come back
 * to rest (never closer than rest — the gap stays open), a thin waveform with
 * the playhead crossing it, the wait clock, and "กำลังโหลด". The status role
 * and the words are the accessible part; everything that moves is hidden from
 * assistive technology. Still with reduced motion: drawn, at rest, the
 * playhead parked, the clock still counting.
 *
 * `full` stands alone in <main>; `chip` floats over a skeleton; `emblem` is
 * the emblem of a status card.
 */
export function RenderLoading({
  variant = "full",
  label = LOADING_TEXT,
  className,
}: {
  variant?: "full" | "chip" | "emblem";
  label?: string;
  className?: string;
}) {
  return (
    <div className={["rl", `rl--${variant}`, className].filter(Boolean).join(" ")} role="status" aria-live="polite">
      <span className="rl__art" aria-hidden="true">
        {/* A lighter stroke keeps the splice open at these sizes (as StatusCard's mark). */}
        <NoeyMark size={64} strokeWidth={11} draw split className="rl__mark" />
        <span className="rl__track">
          <Waveform bars={44} seed={19} still className="rl__wave" />
          <span className="rl__played">
            <Waveform bars={44} seed={19} still className="rl__wave" />
          </span>
          <span className="rl__rail">
            <span className="rl__head" />
          </span>
        </span>
        <WaitClock className="rl__tc" />
      </span>
      <span className="rl__label">{label}</span>
    </div>
  );
}

/**
 * The frame of a route's loading state (every loading.tsx, and the account
 * layout's own Suspense fallbacks): it appears only after 150 ms, marks the
 * region busy, tells the header ruler a page is on its way
 * (data-loading="route"), and fades out over the page when it arrives.
 * `demo` (the kitchen sink) drops the route signals.
 */
export function LoadingFrame({
  children,
  className,
  demo = false,
}: {
  children: ReactNode;
  className?: string;
  demo?: boolean;
}) {
  return (
    <ViewTransition exit="ld-out" default="none">
      <div className={["ld", className].filter(Boolean).join(" ")} data-loading={demo ? undefined : "route"} aria-busy="true">
        {demo ? null : <LoadingSignal />}
        {children}
      </div>
    </ViewTransition>
  );
}
