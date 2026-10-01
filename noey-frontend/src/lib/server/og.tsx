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

/**
 * The site's timeline motif at the foot of the card: a ruler, one track of
 * clips cut on the logo's diagonal, and the playhead. Shapes only (satori
 * draws SVG text without the bundled fonts).
 */
function Timeline() {
  const width = 1040;
  const ticks = Array.from({ length: width / 20 + 1 }, (_, index) => index * 20);
  return (
    <svg width={width} height={70} viewBox={`0 0 ${width} 70`} fill="none">
      <line x1="0" y1="14" x2={width} y2="14" stroke={BRAND.mutedOnDark} strokeOpacity="0.35" strokeWidth="1" />
      {ticks.map((x) => (
        <line key={x} x1={x} y1={x % 100 === 0 ? 2 : 8} x2={x} y2="14" stroke={BRAND.mutedOnDark} strokeOpacity="0.35" strokeWidth="1" />
      ))}
      <rect x="0" y="24" width={width} height="42" rx="8" fill={BRAND.ink} />
      <polygon points="6,28 300,28 300,62 6,62" fill={BRAND.gold} fillOpacity="0.85" />
      <polygon points="306,28 562,28 570,62 306,62" fill={BRAND.gold} fillOpacity="0.6" />
      <polygon points="604,28 1034,28 1034,62 612,62" fill={BRAND.gold} fillOpacity="0.75" />
      <line x1="704" y1="6" x2="704" y2="70" stroke={BRAND.offWhite} strokeWidth="2" />
      <path d="M697 0 H711 V6 L704 12 L697 6 Z" fill={BRAND.offWhite} />
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
          <div style={{ fontSize: 26, fontWeight: 500, color: BRAND.gold, marginBottom: 20 }}>
            {copy.eyebrow}
          </div>
          <div style={{ fontSize: 64, fontWeight: 500, lineHeight: 1.3, maxWidth: 1020 }}>{copy.title}</div>
          <div style={{ fontSize: 29, fontWeight: 300, lineHeight: 1.5, color: BRAND.mutedOnDark, marginTop: 22, maxWidth: 1000 }}>
            {copy.subtitle}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <Timeline />
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              paddingTop: 18,
              fontSize: 24,
              fontWeight: 300,
              color: BRAND.mutedOnDark,
            }}
          >
            <div>{host}</div>
            <div>ตัดคลิปด้วย AI</div>
          </div>
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
