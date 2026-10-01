/**
 * The editor's three modes, as the site introduces them: what each is for,
 * how it works, what comes out.
 *
 * Names, purposes and steps follow the web editor's own mode cards and notes
 * (web/src/components/wizard/WizardStepOutcome.tsx, lib/modeLabel.ts) — say
 * only what the pipeline does. Owner, 2026-10-01: ตัดฉากเด่น does not use the
 * clips' own sound (a new voiceover or music only), and ตัดช่วงเงียบ cuts
 * pauses — it does not find stumbles or a sentence said twice.
 */
import type { CutMode } from "./plans";

export type ModeIcon = "Mic" | "Clapperboard" | "Layers";

export interface ModeIntro {
  /** The editor's mode id (/pricing prices each mode by it). */
  id: CutMode;
  /** The mode's name in the editor. */
  name: string;
  /**
   * Where the name may break, when it is too long for one line: each part is
   * kept whole ("ตัดไฮไลต์ / จากคลิปยาว", never "…คลิป / ยาว").
   */
  nameParts?: readonly string[];
  icon: ModeIcon;
  /** The footage it is for. */
  fit: string;
  /** What the system does, in order. */
  steps: readonly [string, string, string];
  /** What comes out: count and sound. */
  result: readonly string[];
}

export const MODES: readonly ModeIntro[] = [
  {
    id: "talking_head",
    name: "ตัดช่วงเงียบ",
    icon: "Mic",
    fit: "คลิปพูดหน้ากล้องที่ถ่ายรวดเดียว",
    steps: [
      "ถอดเสียงพูดเป็นข้อความพร้อมเวลาของแต่ละคำ",
      "ตัดช่วงที่เงียบหรือหยุดคิดออก เก็บลำดับภาพเดิมไว้ทั้งหมด",
      "ใส่ซับไทยจากสิ่งที่พูด",
    ],
    result: ["ได้ 1 คลิป", "เสียงเดิม"],
  },
  {
    id: "dub_first",
    name: "ตัดฉากเด่น",
    icon: "Clapperboard",
    fit: "คลิปขายของหรือรีวิวสินค้า ที่ถ่ายไว้หลายคลิปหลายมุม",
    steps: [
      "AI ดูฟุตเทจทุกไฟล์ แล้วเลือกช็อตที่โชว์สินค้าได้ชัด",
      "เขียนสคริปต์ขายภาษาไทยให้ หรือใช้สคริปต์ที่คุณพิมพ์เอง แล้วเรียงช็อตตามสคริปต์ ยาวตามที่เลือก",
      "ได้คลิปภาพพร้อมสคริปต์ คัดลอกไปพากย์ด้วยเสียงตัวเอง หรือไม่พากย์แล้วใส่เพลงแทน",
    ],
    // The result's cap is plans.ts MAX_CUT_RESULT_MINUTES (owner, 2026-10-01);
    // spelled out here because plans.ts imports this file (plans.test.ts pins it).
    result: ["ได้ 1 คลิป ยาวไม่เกิน 5 นาที", "พากย์ใหม่ ไม่ใช้เสียงในคลิปเดิม"],
  },
  {
    id: "speech_highlights",
    name: "ตัดไฮไลต์จากคลิปยาว",
    nameParts: ["ตัดไฮไลต์", "จากคลิปยาว"],
    icon: "Layers",
    fit: "คลิปพูดยาวหรือไลฟ์ ที่อยากแยกเป็นคลิปสั้น",
    steps: [
      "ถอดเสียงทั้งคลิปแล้วอ่านว่าพูดเรื่องอะไรบ้าง",
      "เลือกช่วงที่ดูจบได้ในตัวเอง ตัดเป็นคลิปแยกทีละช่วง",
      "ความยาวและจำนวนคลิปขึ้นกับเนื้อหา ไม่ได้ตั้งไว้ล่วงหน้า",
    ],
    result: ["ได้หลายคลิป", "เสียงเดิม"],
  },
];
