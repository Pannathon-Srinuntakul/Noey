import type { CSSProperties, ReactNode } from "react";
import { STRIP } from "../sample";
import { cn } from "./ui";
import "./app.css";
import "./mock.css";

export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * One window of the editor, drawn at its real size in CSS pixels
 * (`width` × `height`, like a browser window) and scaled to fit its box —
 * text, borders and spacing keep the app's exact proportions at any size.
 *
 * `crop` shows only part of the window (a region in window pixels); the box
 * takes the crop's aspect ratio. A stylesheet can move the crop at other
 * sizes by setting --am-cx/--am-cy/--am-cw/--am-ch on the view.
 *
 * Inside, `.am` is a size container named "am": the editor's breakpoints and
 * viewport units (compiled into app.css) answer to this window, not to the
 * browser's.
 */
export function AppScreen({
  width,
  height,
  crop,
  className,
  children,
  ...data
}: {
  width: number;
  height: number;
  crop?: Crop;
  className?: string;
  children: ReactNode;
} & { [key: `data-${string}`]: string | undefined }) {
  const style = {
    "--am-w": width,
    "--am-h": height,
    "--am-tiles": STRIP.tiles,
    "--am-strip-src": `url("${STRIP.url}")`,
    ...(crop ? { "--am-cx": crop.x, "--am-cy": crop.y, "--am-cw": crop.w, "--am-ch": crop.h } : null),
  } as CSSProperties;
  return (
    <div className={cn("am-view", className)} style={style}>
      <div className="am" style={{ width, height }} {...data}>
        {children}
      </div>
    </div>
  );
}
