import "server-only";
import * as fontkit from "fontkit";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Thai text for generated share images, drawn as SVG outlines.
 *
 * satori (next/og) cannot place a Thai tone mark over an upper vowel — "ที่"
 * comes out as "ที" (lib/thai-text.ts) — so the site's fixed OG copy avoids
 * those syllables. A blog title cannot: any Thai sentence has them. Here the
 * text is laid out by fontkit, which applies the font's own GSUB/GPOS rules
 * (the raised tone mark, the shifted marks over ป ฝ ฟ), with the same Noto
 * Sans Thai subsets the other share images use, and handed to satori as
 * paths.
 *
 * Safety: the text from the blog API never reaches the SVG. Only path data
 * produced here goes in — commands and numbers, checked against a strict
 * pattern before use — so no attacker-controlled string can land in SVG
 * content, attributes or styles (GHSA-vcvr-r3jv-pc5j).
 */

type Weight = 300 | 500;
type Font = fontkit.Font;

const FILES: Record<Weight, { thai: string; latin: string }> = {
  300: { thai: "noto-sans-thai-thai-300.woff", latin: "noto-sans-thai-latin-300.woff" },
  500: { thai: "noto-sans-thai-thai-500.woff", latin: "noto-sans-thai-latin-500.woff" },
};

const fonts = new Map<Weight, { thai: Font; latin: Font }>();

function load(weight: Weight) {
  let pair = fonts.get(weight);
  if (!pair) {
    const dir = join(process.cwd(), "src", "assets", "og");
    const open = (file: string) => fontkit.create(readFileSync(join(dir, file))) as Font;
    pair = { thai: open(FILES[weight].thai), latin: open(FILES[weight].latin) };
    fonts.set(weight, pair);
  }
  return pair;
}

const THAI = /[฀-๿]/;
/** Path data: SVG path commands and numbers only. */
const PATH_DATA = /^[MLHVCSQTAZmlhvcsqtaz0-9eE.,\s-]*$/;

/** The text cut into runs of one script: Thai (with its marks) or everything else. */
function scriptRuns(text: string): { thai: boolean; text: string }[] {
  const out: { thai: boolean; text: string }[] = [];
  for (const char of text) {
    const thai = THAI.test(char);
    const last = out.at(-1);
    if (last && last.thai === thai) last.text += char;
    else out.push({ thai, text: char });
  }
  return out;
}

interface Shaped {
  width: number;
  d: string;
}

/** One line at `size` px with its baseline at y = `baseline`. */
function shape(text: string, size: number, weight: Weight, baseline = 0): Shaped {
  const pair = load(weight);
  let x = 0;
  const parts: string[] = [];
  for (const run of scriptRuns(text)) {
    const font = run.thai ? pair.thai : pair.latin;
    const scale = size / font.unitsPerEm;
    const glyphs = font.layout(run.text);
    glyphs.glyphs.forEach((glyph, index) => {
      const position = glyphs.positions[index];
      // .notdef (a character neither subset has) is skipped, not drawn as a box.
      if (glyph.id !== 0) {
        const d = glyph.path
          .scale(scale, -scale)
          .translate(x + position.xOffset * scale, baseline - position.yOffset * scale)
          .toSVG();
        if (d && PATH_DATA.test(d)) parts.push(d);
      }
      x += position.xAdvance * scale;
    });
  }
  return { width: x, d: parts.join("") };
}

const words = new Intl.Segmenter("th", { granularity: "word" });

/** Greedy line breaking at word boundaries (Thai words from Intl.Segmenter). */
function wrap(text: string, size: number, weight: Weight, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const { segment } of words.segment(text.replace(/\s+/g, " ").trim())) {
    const candidate = line + segment;
    if (line.trim() && shape(candidate.trimEnd(), size, weight).width > maxWidth) {
      lines.push(line.trimEnd());
      line = segment.trimStart();
    } else {
      line = candidate;
    }
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines;
}

export interface OgTextBlock {
  width: number;
  height: number;
  lines: { d: string; y: number }[];
}

/**
 * `text` set in at most `maxLines` lines of `maxWidth`, at the largest of
 * `sizes` that fits; at the smallest size the last line is cut with "…".
 */
export function ogTextBlock(
  text: string,
  { sizes, maxWidth, maxLines, weight = 500, lineHeight = 1.42 }: { sizes: readonly number[]; maxWidth: number; maxLines: number; weight?: Weight; lineHeight?: number },
): OgTextBlock {
  let size = sizes[sizes.length - 1];
  let lines: string[] = [];
  for (const candidate of sizes) {
    lines = wrap(text, candidate, weight, maxWidth);
    size = candidate;
    if (lines.length <= maxLines) break;
  }
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    let last = lines[maxLines - 1];
    while (last.length > 1 && shape(`${last}…`, size, weight).width > maxWidth) last = last.slice(0, -1).trimEnd();
    lines[maxLines - 1] = `${last}…`;
  }
  const step = Math.round(size * lineHeight);
  // Room above the first baseline for Thai marks stacked over a vowel.
  const top = Math.round(size * 1.12);
  const shaped = lines.map((line, index) => ({ d: shape(line, size, weight, top + index * step).d, y: top + index * step }));
  return { width: maxWidth, height: top + (lines.length - 1) * step + Math.round(size * 0.42), lines: shaped };
}

/** The block as an <svg> satori can draw. */
export function OgText({ block, color }: { block: OgTextBlock; color: string }) {
  return (
    <svg width={block.width} height={block.height} viewBox={`0 0 ${block.width} ${block.height}`}>
      {block.lines.map((line, index) => (line.d ? <path key={index} d={line.d} fill={color} /> : null))}
    </svg>
  );
}
