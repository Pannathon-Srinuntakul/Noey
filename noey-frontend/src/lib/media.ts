/**
 * The six media slots from the design's <image-slot> placeholders.
 *
 * OWNER: supply each file (put it in /public/media/ or on an allowed CDN),
 * then set `src` + `alt` (and `poster` for video) here. Nothing else changes:
 * every slot already reserves its aspect ratio, so adding media causes no
 * layout shift. For an external host, add it to `images.remotePatterns` in
 * next.config.ts (images) — videos load directly.
 */
export interface MediaEntry {
  /** CSS aspect-ratio, e.g. "9 / 16". */
  ratio: string;
  kind: "image" | "video";
  /** Neutral label shown on the placeholder until real media is supplied. */
  placeholderLabel: string;
  /** What the owner should supply (not shown to visitors). */
  brief: string;
  src?: string;
  /** Required with src: describe what the clip/screenshot shows and its takeaway. */
  alt?: string;
  poster?: string;
}

export const MEDIA = {
  heroClip: {
    ratio: "9 / 16",
    kind: "video",
    placeholderLabel: "คลิปตัวอย่างแนวตั้ง 9:16",
    brief: "Hero: a finished vertical 9:16 clip cut from several raw files (MP4/WebM + poster JPG).",
  },
  stepImport: {
    ratio: "4 / 3",
    kind: "image",
    placeholderLabel: "ภาพหน้าจอ: ลากไฟล์เข้าโปรเจกต์",
    brief: "Step 1 screenshot (4:3): dragging footage into a project.",
  },
  stepStyle: {
    ratio: "4 / 3",
    kind: "image",
    placeholderLabel: "ภาพหน้าจอ: เลือกสไตล์การตัด",
    brief: "Step 2 screenshot (4:3): choosing length, cut style and voice option.",
  },
  stepTimeline: {
    ratio: "4 / 3",
    kind: "image",
    placeholderLabel: "ภาพหน้าจอ: หน้าพรีวิวและไทม์ไลน์",
    brief: "Step 3 screenshot (4:3): preview + timeline editor.",
  },
  homeWork: {
    ratio: "9 / 16",
    kind: "video",
    placeholderLabel: "ภาพปกคลิปตัวอย่าง",
    brief: "Home 'work' teaser: product-review clip made in voiceover mode (9:16 video or cover image).",
  },
  examplesWork: {
    ratio: "9 / 16",
    kind: "video",
    placeholderLabel: "ภาพปกคลิปตัวอย่าง",
    brief: "Examples page: the same product-review clip (8 raw files, voiceover mode) — or update the copy to match the real clip.",
  },
} satisfies Record<string, MediaEntry>;
