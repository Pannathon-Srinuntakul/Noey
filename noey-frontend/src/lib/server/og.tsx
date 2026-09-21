import "server-only";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import type { OgCopy } from "../og-copy";
import { BRAND, SITE_URL } from "../site";

/**
 * Images drawn with `next/og` (satori). Fonts are Noto Sans Thai static
 * subsets checked into src/assets/og (SIL OFL, see OFL.txt there): satori
 * needs TTF/WOFF files — not WOFF2, not variable fonts.
 *
 * The Latin and Thai subsets are registered under DIFFERENT family names and
 * listed as a fallback chain. Registered under one name, satori keeps only the
 * first file per weight, finds no Thai glyphs, and silently tries to download
 * a font from Google at build time — tofu boxes when that fetch fails
 * (measured 2026-09-21: the whole Thai headline rendered as boxes offline).
 */

export const OG_SIZE = { width: 1200, height: 630 } as const;

/** Latin first (digits, "Noey Studio"), then Thai; satori falls back per glyph. */
const OG_FONT_FAMILY = "OgLatin, OgThai";

type OgFont = { name: string; data: Buffer; weight: 300 | 500; style: "normal" };

let fontsPromise: Promise<OgFont[]> | null = null;

function loadFonts(): Promise<OgFont[]> {
  fontsPromise ??= (async () => {
    const dir = join(process.cwd(), "src", "assets", "og");
    const load = (file: string) => readFile(join(dir, file));
    const [latin300, thai300, latin500, thai500] = await Promise.all([
      load("noto-sans-thai-latin-300.woff"),
      load("noto-sans-thai-thai-300.woff"),
      load("noto-sans-thai-latin-500.woff"),
      load("noto-sans-thai-thai-500.woff"),
    ]);
    return [
      { name: "OgLatin", data: latin300, weight: 300, style: "normal" },
      { name: "OgLatin", data: latin500, weight: 500, style: "normal" },
      { name: "OgThai", data: thai300, weight: 300, style: "normal" },
      { name: "OgThai", data: thai500, weight: 500, style: "normal" },
    ];
  })();
  return fontsPromise;
}

/** The Noey "splice" mark (logo/README.md): four strokes, the gap in the middle kept open. */
function Mark({ size, color, strokeWidth = 13 }: { size: number; color: string; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round">
      <path d="M22 78 V 22" />
      <path d="M22 22 L 44 55" />
      <path d="M56 45 L 78 78" />
      <path d="M78 78 V 22" />
    </svg>
  );
}

export async function renderOgImage(copy: OgCopy): Promise<ImageResponse> {
  const fonts = await loadFonts();
  const host = new URL(SITE_URL).host;
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: BRAND.ground,
          color: BRAND.offWhite,
          padding: "68px 80px 56px",
          fontFamily: OG_FONT_FAMILY,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <Mark size={52} color={BRAND.gold} />
          <div style={{ fontSize: 38, fontWeight: 500, letterSpacing: "-0.01em" }}>Noey Studio</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 26, fontWeight: 500, color: BRAND.gold, letterSpacing: "0.01em", marginBottom: 20 }}>
            {copy.eyebrow}
          </div>
          <div style={{ fontSize: 66, fontWeight: 300, lineHeight: 1.35, maxWidth: 1020 }}>{copy.title}</div>
          <div style={{ fontSize: 29, fontWeight: 300, lineHeight: 1.5, color: BRAND.mutedOnDark, marginTop: 22, maxWidth: 1000 }}>
            {copy.subtitle}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            borderTop: "1px solid #35322d",
            paddingTop: 20,
            fontSize: 24,
            fontWeight: 300,
            color: BRAND.mutedOnDark,
          }}
        >
          <div>{host}</div>
          <div>ตัดคลิปด้วย AI</div>
        </div>
      </div>
    ),
    { ...OG_SIZE, fonts },
  );
}

/**
 * Square app icon: gold mark on the dark ground. `rounded` gives the logo
 * README's app-icon corners (rx 114/512); maskable/Apple icons stay square
 * because the platform applies its own mask. Mark size follows the README's
 * app icon (≈60% of the tile, clear space well above one stroke width).
 */
export function renderAppIcon(size: number, options: { rounded: boolean; markRatio?: number }): ImageResponse {
  const markSize = Math.round(size * (options.markRatio ?? 0.6));
  // Below ~48px the regular stroke gets thin; use the README's small-size weight.
  const strokeWidth = size < 64 ? 15 : 13;
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: BRAND.ground,
          borderRadius: options.rounded ? Math.round(size * (114 / 512)) : 0,
        }}
      >
        <Mark size={markSize} color={BRAND.gold} strokeWidth={strokeWidth} />
      </div>
    ),
    { width: size, height: size },
  );
}
