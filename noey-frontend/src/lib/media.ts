/**
 * The media slots from the design's <image-slot> placeholders (Website v2:
 * the three step screenshots; the hero clip and sample-work slots are gone).
 *
 * OWNER: supply each file (put it in /public/media/ or on an allowed CDN),
 * then set `src` + `alt` (and `poster` for video) here. Nothing else changes:
 * every slot already reserves its aspect ratio, so adding media causes no
 * layout shift. For an external host, add it to `images.remotePatterns` in
 * next.config.ts (images) — videos load directly.
 *
 * Until then each slot shows a coded illustration of that step (`mock`,
 * components/mockups/StepMockup.tsx), labelled "ภาพจำลอง · <mockLabel>" so
 * it is never mistaken for a screenshot of real work.
 */
export interface MediaEntry {
  /** CSS aspect-ratio, e.g. "9 / 16". */
  ratio: string;
  kind: "image" | "video";
  /** What the screenshot will show — the brief for the placeholder until real media is supplied. */
  placeholderLabel: string;
  /** Which coded illustration stands in until `src` is set. */
  mock: "import" | "style" | "timeline";
  /** The step the illustration shows, after "ภาพจำลอง · ". */
  mockLabel: string;
  /** What the owner should supply (not shown to visitors). */
  brief: string;
  src?: string;
  /** Required with src: describe what the clip/screenshot shows and its takeaway. */
  alt?: string;
  poster?: string;
}

export const MEDIA = {
  stepImport: {
    ratio: "4 / 3",
    kind: "image",
    placeholderLabel: "ภาพหน้าจอ: ลากไฟล์เข้าโปรเจกต์",
    mock: "import",
    mockLabel: "ลากไฟล์เข้าโปรเจกต์",
    brief: "Step 1 screenshot (4:3): dragging footage into a project.",
  },
  stepStyle: {
    ratio: "4 / 3",
    kind: "image",
    placeholderLabel: "ภาพหน้าจอ: เลือกโหมดและความยาว",
    mock: "style",
    mockLabel: "เลือกโหมดและความยาว",
    brief: "Step 2 screenshot (4:3): choosing mode, length and voice option.",
  },
  stepTimeline: {
    ratio: "4 / 3",
    kind: "image",
    placeholderLabel: "ภาพหน้าจอ: หน้าพรีวิวและไทม์ไลน์",
    mock: "timeline",
    mockLabel: "หน้าพรีวิวและไทม์ไลน์",
    brief: "Step 3 screenshot (4:3): preview + timeline editor.",
  },
} satisfies Record<string, MediaEntry>;
